/**
 * One-off: classify the January 2026 cold-IP cohort's CURRENT SendGrid bounce
 * reasons to tell genuine dead addresses apart from cold-IP reputation artifacts.
 *
 * Reads (no writes). Pulls full SendGrid bounces + invalid_emails lists (with the
 * verbatim SMTP reason), intersects with the DB's still-hard Jan-blast contacts
 * (last_bounce_campaign_id = the 2026-01-22 blast), and buckets by reason pattern.
 *
 * Usage: node api/analyze-jan-bounces.js <clientId> [janCampaignId]
 */
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const API_KEY = process.env.SENDGRID_LOOKUP_API_KEY
const BASE = 'https://api.sendgrid.com/v3'
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const clientId = process.argv[2]
const janCampaignId = process.argv[3] || '1bee1587-4c90-4070-8fc5-17fbe77bffdc'
if (!clientId) { console.error('Usage: node api/analyze-jan-bounces.js <clientId>'); process.exit(1) }

// Full list with reasons: email -> { created, reason, status }
async function fetchListMap(list) {
  const map = new Map()
  let offset = 0
  const LIMIT = 500
  while (true) {
    const res = await fetch(`${BASE}/suppression/${list}?limit=${LIMIT}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    if (!res.ok) throw new Error(`SendGrid ${list} ${res.status}: ${await res.text()}`)
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) if (r.email) map.set(r.email.toLowerCase(), { created: r.created, reason: r.reason || '', status: r.status || '' })
    if (rows.length < LIMIT) break
    offset += LIMIT
  }
  return map
}

const IP_REPUTATION = /banned sending ip|access denied|5\.7\.606|reputation|spamhaus|barracuda|rbl|black ?list|blocklist|listed in|rate limit|too many|try again|temporar|deferred|greylist|throttl|connection (refused|timed out)|4\.\d\.\d/i
const GENUINE_DEAD = /user unknown|unknown user|does not exist|doesn'?t exist|no such (user|mailbox|recipient)|mailbox (unavailable|not found|does not|full|disabled)|recipient (address )?rejected|account.*(disabled|closed|inactive|suspended)|invalid (recipient|address|mailbox)|no longer|5\.1\.1|5\.1\.10|550 5\.1|address rejected|relay denied/i

async function loadJanCohort() {
  const emails = []
  let from = 0; const PAGE = 1000
  while (true) {
    const { data, error } = await supabase.from('contacts')
      .select('email')
      .eq('client_id', clientId).eq('bounce_status', 'hard')
      .eq('last_bounce_campaign_id', janCampaignId)
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
  console.log('📥 Downloading SendGrid bounces + invalid_emails (with reasons)...')
  const [bounces, invalid] = await Promise.all([fetchListMap('bounces'), fetchListMap('invalid_emails')])
  console.log(`   bounces=${bounces.size}  invalid_emails=${invalid.size}`)

  const cohort = await loadJanCohort()
  console.log(`📥 Jan-blast still-hard contacts in DB: ${cohort.length}\n`)

  const RELAY_POLICY = /not permitted to relay|not in relay or upstream|relay (access|denied|not permitted)|sender.*(verif|reject)|spf|dkim|dmarc|authentication|policy/i
  const MAILBOX_DISABLED = /disabled|inactive|suspended|over ?quota|quota exceeded|full|no longer (active|available)/i

  const buckets = { genuine_dead: [], ip_reputation: [], relay_policy: [], mailbox_disabled: [], invalid_list: [], other: [], not_in_sg: [] }
  const monthTally = {}
  for (const email of cohort) {
    if (invalid.has(email)) { buckets.invalid_list.push({ email, ...invalid.get(email) }); continue }
    const b = bounces.get(email)
    if (!b) { buckets.not_in_sg.push(email); continue }
    const m = b.created ? new Date(b.created * 1000).toISOString().slice(0, 7) : 'unknown'
    monthTally[m] = (monthTally[m] || 0) + 1
    if (GENUINE_DEAD.test(b.reason)) buckets.genuine_dead.push({ email, ...b })
    else if (IP_REPUTATION.test(b.reason)) buckets.ip_reputation.push({ email, ...b })
    else if (RELAY_POLICY.test(b.reason)) buckets.relay_policy.push({ email, ...b })
    else if (MAILBOX_DISABLED.test(b.reason)) buckets.mailbox_disabled.push({ email, ...b })
    else buckets.other.push({ email, ...b })
  }

  console.log('=== Jan cohort by SendGrid classification ===')
  console.log(`  genuine_dead     (user unknown / not found / no such user):  ${buckets.genuine_dead.length}`)
  console.log(`  mailbox_disabled (disabled / suspended / over quota):        ${buckets.mailbox_disabled.length}`)
  console.log(`  invalid_list     (SendGrid invalid_emails list):             ${buckets.invalid_list.length}`)
  console.log(`  --- likely recoverable (not a dead-mailbox reason) ---`)
  console.log(`  relay_policy     (not permitted to relay / auth / policy):   ${buckets.relay_policy.length}`)
  console.log(`  ip_reputation    (banned IP / blocked / temp / reputation):  ${buckets.ip_reputation.length}`)
  console.log(`  other            (reason matched nothing — inspect):         ${buckets.other.length}`)
  console.log(`  not_in_sg        (DB-hard but absent from SG bounces):       ${buckets.not_in_sg.length}`)

  console.log('\n=== Bounce record month (SendGrid created) ===')
  for (const m of Object.keys(monthTally).sort()) console.log(`  ${m}: ${monthTally[m]}`)

  const sample = (arr, n = 8) => arr.slice(0, n).map(r => `      [${r.status}] ${r.email}\n        ${r.reason}`).join('\n')
  console.log('\n=== Sample reasons: ip_reputation ===\n' + (sample(buckets.ip_reputation) || '   (none)'))
  console.log('\n=== Sample reasons: other ===\n' + (sample(buckets.other) || '   (none)'))
  console.log('\n=== Sample reasons: genuine_dead ===\n' + (sample(buckets.genuine_dead) || '   (none)'))
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
