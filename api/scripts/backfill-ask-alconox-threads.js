// Backfill Ask Alconox questions with their text and the email conversation that answered them
// (migration 107). Matching rules live in ../salesforce-ask-threads.js; the scheduler re-reads
// the last 180 days daily. Read-only against Salesforce; re-runnable (upserts).
//   node api/scripts/backfill-ask-alconox-threads.js <clientId> [--dry] [--days=N] [--verbose]
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const jsforce = require('jsforce')
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')
const { syncAskThreads } = require('../salesforce-ask-threads')

const clientId = process.argv[2]
if (!clientId || clientId.startsWith('--')) { console.error('clientId required'); process.exit(1) }
const daysArg = process.argv.find(a => a.startsWith('--days='))

const supabase = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)

async function getSalesforceConnection(id) {
  const { data: c, error } = await supabase.from('clients')
    .select('salesforce_instance_url, salesforce_client_id, salesforce_client_secret').eq('id', id).single()
  if (error) throw error
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: decrypt(c.salesforce_client_id, process.env.ENCRYPTION_KEY),
    client_secret: decrypt(c.salesforce_client_secret, process.env.ENCRYPTION_KEY),
  })
  const t = await (await fetch(`${c.salesforce_instance_url}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json()
  if (!t.access_token) throw new Error('token: ' + JSON.stringify(t))
  return new jsforce.Connection({ instanceUrl: c.salesforce_instance_url, accessToken: t.access_token, version: '61.0' })
}

syncAskThreads({ supabase, getSalesforceConnection, log: console.log }, clientId, {
  days: daysArg ? Number(daysArg.split('=')[1]) : null,
  dryRun: process.argv.includes('--dry'),
  verbose: process.argv.includes('--verbose'),
}).then(stats => {
  if (!stats.supported) console.log('This org has no Ask_Alconox__c object; nothing to do.')
  else console.log(process.argv.includes('--dry') ? '--dry: nothing written' : `wrote ${stats.questions} questions, ${stats.messages} messages`)
}).catch(e => { console.error(e); process.exit(1) })
