/**
 * Reconcile contacts.bounce_status against SendGrid's ACTUAL suppression state.
 *
 * Background: a brand-new dedicated IP was used without warmup in Jan 2026; a
 * large blast got blocked by receiving servers, and ~27K contacts were flagged
 * bounce_status='hard' in our DB. Most were IP-reputation casualties, not dead
 * addresses — and SendGrid never permanently suppressed them. This script trusts
 * SendGrid as the source of truth and clears stale 'hard' flags.
 *
 * Buckets each DB-hard contact by SendGrid membership:
 *   - clearable: not in any SendGrid suppression list  -> safe to reset (deliverable)
 *   - blocked:   in 'blocks' only (IP-reputation block) -> recoverable, needs SG block removal first
 *   - genuine:   in 'bounces' or 'invalid_emails'       -> real bad address, leave flagged
 *
 * Default is DRY RUN (report only). Pass --apply to clear the 'clearable' bucket
 * (sets bounce_status='none', bounced_at=NULL, last_bounce_campaign_id=NULL).
 *
 * Usage:
 *   node api/reconcile-bounces.js <clientId>                  # dry run
 *   node api/reconcile-bounces.js <clientId> --apply          # clear stale flags (clearable bucket)
 *   node api/reconcile-bounces.js <clientId> --apply-blocked  # remove 'blocked' bucket from
 *                                                             # SendGrid blocks list + reset DB flag
 *
 * Requires SENDGRID_LOOKUP_API_KEY (suppression.read), ENCRYPTION_KEY,
 * VITE_SUPABASE_URL, SUPABASE_SERVICE_KEY in .env.
 */

require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('./crypto-utils')

const API_KEY = process.env.SENDGRID_LOOKUP_API_KEY
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
const BASE = 'https://api.sendgrid.com/v3'
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const clientId = process.argv[2]
const APPLY = process.argv.includes('--apply')
const APPLY_BLOCKED = process.argv.includes('--apply-blocked')

if (!clientId) {
  console.error('Usage: node api/reconcile-bounces.js <clientId> [--apply]')
  process.exit(1)
}

// Download a full SendGrid suppression list into a lowercased Set of emails.
async function fetchSuppressionSet(list) {
  const set = new Set()
  let offset = 0
  const LIMIT = 500
  while (true) {
    const res = await fetch(`${BASE}/suppression/${list}?limit=${LIMIT}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    if (!res.ok) throw new Error(`SendGrid ${list} ${res.status}: ${await res.text()}`)
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) if (r.email) set.add(r.email.toLowerCase())
    if (rows.length < LIMIT) break
    offset += LIMIT
  }
  return set
}

async function main() {
  console.log('📥 Downloading SendGrid suppression lists...')
  const [bounces, blocks, invalid] = await Promise.all([
    fetchSuppressionSet('bounces'),
    fetchSuppressionSet('blocks'),
    fetchSuppressionSet('invalid_emails'),
  ])
  console.log(`   bounces=${bounces.size}  blocks=${blocks.size}  invalid_emails=${invalid.size}`)

  // Pull all DB-hard contacts for this client.
  console.log('📥 Loading DB hard-bounced contacts...')
  const hard = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('contacts')
      .select('email')
      .eq('client_id', clientId)
      .eq('bounce_status', 'hard')
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const c of data) if (c.email) hard.push(c.email.toLowerCase())
    if (data.length < PAGE) break
    from += PAGE
  }
  console.log(`   ${hard.length} contacts flagged bounce_status='hard'`)

  // Bucket.
  const clearable = [], blocked = [], genuine = []
  for (const email of hard) {
    if (bounces.has(email) || invalid.has(email)) genuine.push(email)
    else if (blocks.has(email)) blocked.push(email)
    else clearable.push(email)
  }

  console.log('\n=== Reconciliation summary ===')
  console.log(`  clearable (no SendGrid suppression, deliverable): ${clearable.length}`)
  console.log(`  blocked   (SendGrid 'blocks' — IP casualty, needs SG removal): ${blocked.length}`)
  console.log(`  genuine   (SendGrid bounce/invalid — leave flagged): ${genuine.length}`)

  // Helper: reset DB hard flags for a list of emails, in chunks.
  async function clearDbFlags(list, label) {
    let cleared = 0
    const CHUNK = 500
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK)
      const { error, count } = await supabase
        .from('contacts')
        .update({ bounce_status: 'none', bounced_at: null, last_bounce_campaign_id: null }, { count: 'exact' })
        .eq('client_id', clientId)
        .eq('bounce_status', 'hard')
        .in('email', chunk)
      if (error) throw error
      cleared += count || 0
      process.stdout.write(`\r   ${label} ${cleared}/${list.length}`)
    }
    console.log('')
    return cleared
  }

  if (APPLY_BLOCKED) {
    // Remove the 'blocked' bucket from SendGrid's blocks list, then reset DB flags.
    // Uses the client's own SendGrid key (needs suppression delete scope).
    const { data: clientRow, error: cErr } = await supabase
      .from('clients').select('sendgrid_api_key').eq('id', clientId).single()
    if (cErr || !clientRow?.sendgrid_api_key) throw new Error('Could not load client SendGrid key')
    const sgKey = decrypt(clientRow.sendgrid_api_key, ENCRYPTION_KEY)

    console.log(`\n✏️  Removing ${blocked.length} address(es) from SendGrid 'blocks' list...`)
    let removed = 0
    for (const email of blocked) {
      try {
        const r = await fetch(`${BASE}/suppression/blocks/${encodeURIComponent(email)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${sgKey}` },
        })
        if (r.status === 204 || r.status === 404) removed++ // 404 = already gone, fine
        else console.warn(`\n   ⚠️ ${email}: HTTP ${r.status}`)
      } catch (err) {
        console.warn(`\n   ⚠️ ${email}: ${err.message}`)
      }
      if (removed % 100 === 0) process.stdout.write(`\r   removed ${removed}/${blocked.length}`)
    }
    console.log(`\r   removed ${removed}/${blocked.length} from SendGrid blocks`)
    const cleared = await clearDbFlags(blocked, 'reset DB flags')
    console.log(`✅ Done. Unblocked ${removed}, reset ${cleared} DB flags.`)
    return
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no changes made. Re-run with --apply (clearable) or --apply-blocked (blocks).')
    return
  }

  // Apply: clear the stale 'hard' flags for the clearable bucket, in chunks.
  console.log(`\n✏️  Clearing ${clearable.length} stale hard flags...`)
  const cleared = await clearDbFlags(clearable, 'cleared')
  console.log(`✅ Done. Cleared ${cleared} stale hard flags.`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
