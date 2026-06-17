/**
 * Recover the January 2026 cohort's RECOVERABLE slice (server-policy + IP-reputation
 * rejections — NOT dead mailboxes) back into the sendable pool.
 *
 * Scope: contacts with bounce_status='hard' AND last_bounce_campaign_id = the
 * 2026-01-22 blast, whose CURRENT SendGrid bounce reason is a relay/policy or
 * IP-reputation refusal (per the same patterns as analyze-jan-bounces.js).
 * Dead-mailbox reasons (user unknown / not found / disabled) are left suppressed.
 *
 * Two actions per recovered address:
 *   1. DELETE it from SendGrid's 'bounces' suppression list (client/subuser key).
 *   2. Reset DB: bounce_status='none', bounced_at=NULL, last_bounce_campaign_id=NULL.
 *
 * DRY RUN by default. Pass --apply to execute.
 * Usage: node api/recover-jan-relay-bounces.js <clientId> [--apply]
 */
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('./crypto-utils')

const API_KEY = process.env.SENDGRID_LOOKUP_API_KEY
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
const BASE = 'https://api.sendgrid.com/v3'
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const clientId = process.argv[2]
const janCampaignId = '1bee1587-4c90-4070-8fc5-17fbe77bffdc'
const APPLY = process.argv.includes('--apply')
if (!clientId) { console.error('Usage: node api/recover-jan-relay-bounces.js <clientId> [--apply]'); process.exit(1) }

const IP_REPUTATION = /banned sending ip|access denied|5\.7\.606|reputation|spamhaus|barracuda|rbl|black ?list|blocklist|listed in|rate limit|too many|try again|temporar|deferred|greylist|throttl|connection (refused|timed out)|4\.\d\.\d/i
const GENUINE_DEAD = /user unknown|unknown user|does not exist|doesn'?t exist|no such (user|mailbox|recipient)|mailbox (unavailable|not found|does not|full|disabled)|recipient (address )?rejected|account.*(disabled|closed|inactive|suspended)|invalid (recipient|address|mailbox)|no longer|5\.1\.1|5\.1\.10|550 5\.1|address rejected|relay denied/i
const RELAY_POLICY = /not permitted to relay|not in relay or upstream|relay (access|denied|not permitted)|sender.*(verif|reject)|spf|dkim|dmarc|authentication|policy/i

async function fetchListMap(list) {
  const map = new Map(); let offset = 0; const LIMIT = 500
  while (true) {
    const res = await fetch(`${BASE}/suppression/${list}?limit=${LIMIT}&offset=${offset}`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    if (!res.ok) throw new Error(`SendGrid ${list} ${res.status}: ${await res.text()}`)
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) if (r.email) map.set(r.email.toLowerCase(), { reason: r.reason || '', status: r.status || '' })
    if (rows.length < LIMIT) break
    offset += LIMIT
  }
  return map
}

async function loadJanCohort() {
  const emails = []; let from = 0; const PAGE = 1000
  while (true) {
    const { data, error } = await supabase.from('contacts').select('email')
      .eq('client_id', clientId).eq('bounce_status', 'hard').eq('last_bounce_campaign_id', janCampaignId)
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const c of data) if (c.email) emails.push(c.email.toLowerCase())
    if (data.length < PAGE) break
    from += PAGE
  }
  return emails
}

async function main() {
  const bounces = await fetchListMap('bounces')
  const cohort = await loadJanCohort()

  // Recoverable = in SG bounces, reason is NOT dead-mailbox, and IS relay/policy or IP-reputation.
  const recoverable = []
  for (const email of cohort) {
    const b = bounces.get(email)
    if (!b) continue
    if (GENUINE_DEAD.test(b.reason)) continue
    if (RELAY_POLICY.test(b.reason) || IP_REPUTATION.test(b.reason)) recoverable.push(email)
  }
  console.log(`Jan cohort still-hard: ${cohort.length}`)
  console.log(`Recoverable (relay-policy + IP-reputation, non-dead): ${recoverable.length}`)

  if (!APPLY) {
    console.log('\nDRY RUN — no changes. Sample:')
    recoverable.slice(0, 10).forEach(e => console.log('   ' + e))
    console.log('\nRe-run with --apply to un-suppress in SendGrid + reset DB flags.')
    return
  }

  // 1. Remove from SendGrid bounces list using the client's own key.
  const { data: clientRow, error: cErr } = await supabase.from('clients').select('sendgrid_api_key').eq('id', clientId).single()
  if (cErr || !clientRow?.sendgrid_api_key) throw new Error('Could not load client SendGrid key')
  const sgKey = decrypt(clientRow.sendgrid_api_key, ENCRYPTION_KEY)

  let removed = 0, missing = 0, failed = 0
  for (const email of recoverable) {
    try {
      const r = await fetch(`${BASE}/suppression/bounces/${encodeURIComponent(email)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sgKey}` } })
      if (r.status === 204) removed++
      else if (r.status === 404) missing++
      else { failed++; if (failed <= 5) console.warn(`   ⚠️ ${email}: HTTP ${r.status} ${await r.text()}`) }
    } catch (err) { failed++; if (failed <= 5) console.warn(`   ⚠️ ${email}: ${err.message}`) }
    if ((removed + missing + failed) % 50 === 0) process.stdout.write(`\r   SG delete: ${removed} removed, ${missing} already-gone, ${failed} failed`)
  }
  console.log(`\r   SG delete: ${removed} removed, ${missing} already-gone, ${failed} failed`)

  // 2. Reset DB flags in chunks.
  let cleared = 0; const CHUNK = 500
  for (let i = 0; i < recoverable.length; i += CHUNK) {
    const chunk = recoverable.slice(i, i + CHUNK)
    const { count, error } = await supabase.from('contacts')
      .update({ bounce_status: 'none', bounced_at: null, last_bounce_campaign_id: null }, { count: 'exact' })
      .eq('client_id', clientId).eq('bounce_status', 'hard').in('email', chunk)
    if (error) throw error
    cleared += count || 0
  }
  console.log(`✅ Done. SG-unsuppressed ${removed} (+${missing} already gone), reset ${cleared} DB flags.`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
