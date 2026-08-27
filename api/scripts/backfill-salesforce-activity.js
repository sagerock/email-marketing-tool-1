// One-off / re-runnable: backfill contacts.salesforce_last_activity_date + salesforce_lead_status
// for every Lead/Contact in Salesforce, and do a FULL opportunity sync. The daily sync only
// touches records modified since last run, so first-time population needs this.
//   ENCRYPTION_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/backfill-salesforce-activity.js <clientId>
const jsforce = require('jsforce')
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')
const { syncSalesforceOpportunities } = require('../salesforce-opportunities')

const clientId = process.argv[2]
if (!clientId) { console.error('clientId required'); process.exit(1) }
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function getConn() {
  const { data: c, error } = await supabase.from('clients')
    .select('salesforce_instance_url, salesforce_client_id, salesforce_client_secret').eq('id', clientId).single()
  if (error) throw error
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: decrypt(c.salesforce_client_id, process.env.ENCRYPTION_KEY),
    client_secret: decrypt(c.salesforce_client_secret, process.env.ENCRYPTION_KEY),
  })
  const t = await (await fetch(`${c.salesforce_instance_url}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json()
  if (!t.access_token) throw new Error('token: ' + JSON.stringify(t))
  return new jsforce.Connection({ instanceUrl: c.salesforce_instance_url, accessToken: t.access_token })
}

async function backfillObject(conn, soql, map) {
  let res = await conn.query(soql), n = 0, updated = 0
  while (true) {
    const rows = res.records.map(map).filter(r => r.salesforce_last_activity_date || r.salesforce_lead_status)
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200)
      // update by salesforce_id; do it per-row in parallel batches (no upsert: we must not insert)
      const results = await Promise.all(chunk.map(r =>
        supabase.from('contacts').update({ salesforce_last_activity_date: r.salesforce_last_activity_date, salesforce_lead_status: r.salesforce_lead_status })
          .eq('client_id', clientId).eq('salesforce_id', r.salesforce_id).select('id')))
      for (const { data, error } of results) { if (error) console.error(error.message); else updated += (data || []).length }
    }
    n += res.records.length
    process.stdout.write(`\r  ${n} scanned, ${updated} updated`)
    if (res.done || !res.nextRecordsUrl) break
    res = await conn.queryMore(res.nextRecordsUrl)
  }
  console.log()
  return { n, updated }
}

;(async () => {
  const conn = await getConn()
  if (!process.env.SKIP_CONTACTS) {
  console.log('Leads…')
  console.log(await backfillObject(conn,
    'SELECT Id, LastActivityDate, Status FROM Lead WHERE Email != null AND (LastActivityDate != null OR Status != null)',
    l => ({ salesforce_id: l.Id, salesforce_last_activity_date: l.LastActivityDate || null, salesforce_lead_status: l.Status || null })))
  console.log('Contacts…')
  console.log(await backfillObject(conn,
    'SELECT Id, LastActivityDate FROM Contact WHERE Email != null AND LastActivityDate != null',
    c => ({ salesforce_id: c.Id, salesforce_last_activity_date: c.LastActivityDate || null, salesforce_lead_status: null })))
  }
  console.log('Opportunities (full)…')
  const total = await syncSalesforceOpportunities({ supabase, getSalesforceConnection: async () => conn }, clientId, null)
  const { data: filled } = await supabase.rpc('fill_opportunity_emails', { p_client_id: clientId })
  console.log(`  opps: ${total}, emails filled: ${filled}`)
})().catch(e => { console.error(e); process.exit(1) })
