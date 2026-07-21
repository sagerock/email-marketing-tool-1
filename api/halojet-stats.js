/**
 * One-off: pull authoritative SendGrid category stats for the Halojet Free Trial
 * campaign to confirm the auto-warmup throttle (requests vs delivered over time).
 * Usage: node api/halojet-stats.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('./crypto-utils')

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
const BASE = 'https://api.sendgrid.com/v3'
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const CAMPAIGN_ID = '67d13e66-02ba-4beb-94f0-ea8da8dcc1c1'
const CATEGORY = `campaign-${CAMPAIGN_ID}`
const START = '2026-06-18'

async function main() {
  const { data: client, error } = await supabase
    .from('clients').select('id, name, sendgrid_api_key').ilike('name', '%alconox%').single()
  if (error || !client?.sendgrid_api_key) throw new Error('Could not load Alconox SendGrid key')
  const sgKey = decrypt(client.sendgrid_api_key, ENCRYPTION_KEY)
  console.log(`Client: ${client.name} (${client.id})`)

  const url = new URL(`${BASE}/categories/stats`)
  url.searchParams.set('categories', CATEGORY)
  url.searchParams.set('start_date', START)
  url.searchParams.set('aggregated_by', 'day')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${sgKey}` } })
  if (!res.ok) throw new Error(`SendGrid categories/stats ${res.status}: ${await res.text()}`)
  const days = await res.json()

  const tot = { requests: 0, delivered: 0, bounces: 0, bounce_drops: 0, deferred: 0, processed: 0, opens: 0, unique_opens: 0, clicks: 0, blocks: 0, spam: 0 }
  console.log(`\nCategory: ${CATEGORY}`)
  for (const d of days) {
    const m = (d.stats?.[0]?.metrics) || {}
    console.log(`  ${d.date}: requests=${m.requests||0} delivered=${m.delivered||0} processed=${m.processed||0} deferred=${m.deferred||0} bounces=${m.bounces||0} blocks=${m.blocks||0} unique_opens=${m.unique_opens||0} clicks=${m.clicks||0}`)
    for (const k of Object.keys(tot)) tot[k] += (m[k] || 0)
  }
  console.log(`\nTOTALS:`, JSON.stringify(tot, null, 0))
  const accounted = tot.delivered + tot.bounces + tot.bounce_drops + tot.blocks
  console.log(`\nrequests(accepted)=${tot.requests}  delivered=${tot.delivered}  deferred(in-queue)=${tot.deferred}  bounces=${tot.bounces}  blocks=${tot.blocks}`)
  console.log(`Remaining (requests - delivered - bounces - blocks) ≈ ${tot.requests - accounted}`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
