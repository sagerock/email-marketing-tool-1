// Run bubble-up for one client from the CLI (migration 112, ../bubble-up.js).
//   node api/scripts/run-bubble-up.js <clientId> [--dry] [--no-sync] [--no-send] [--to=you@example.com] [--html=out.html]
// --dry     refresh nothing, write nothing, send nothing; print the report
// --no-sync skip the Salesforce refresh (Tasks, EmailMessage, recent Opportunities)
// --to      send to this address instead of bubble_config.recipients (doesn't mark items notified)
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const jsforce = require('jsforce')
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')
const { syncSalesforceActivity } = require('../salesforce-activity')
const { syncSalesforceOpportunities } = require('../salesforce-opportunities')

const args = process.argv.slice(2)
const clientId = args[0]
if (!clientId || clientId.startsWith('--')) { console.error('clientId required'); process.exit(1) }
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || undefined

const supabase = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
const decryptClient = c => ({ ...c, sendgrid_api_key: c.sendgrid_api_key ? decrypt(c.sendgrid_api_key, process.env.ENCRYPTION_KEY) : null })

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

const { runBubbleUp } = require('../bubble-up')({ post() {} }, {
  supabase, decryptClient, cron: null,
  syncActivity: async id => console.log('activity mirror:', await syncSalesforceActivity({ supabase, getSalesforceConnection }, id)),
  syncOpportunities: async (id, since) => console.log('opportunities:', await syncSalesforceOpportunities({ supabase, getSalesforceConnection }, id, since)),
})

runBubbleUp(clientId, {
  dryRun: args.includes('--dry'), sync: !args.includes('--no-sync'), send: !args.includes('--no-send'), to: opt('to'),
}).then(r => {
  console.log(`candidates ${r.candidates}, new ${r.inserted}, auto-closed ${r.closed}, expired ${r.expired}; open ${r.open}`)
  console.log(r.sent ? `sent to ${r.recipients.join(', ')}` : 'not sent')
  if (opt('html')) require('fs').writeFileSync(opt('html'), r.html)
  if (args.includes('--dry') || !r.sent) console.log(`\n${r.subject}\n\n${r.text}`)
}).catch(e => { console.error(e); process.exit(1) })
