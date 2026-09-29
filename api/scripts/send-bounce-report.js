// Send (or preview) the weekly bounce report from the CLI.
//   ENCRYPTION_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/send-bounce-report.js <clientId> [to@example.com] [--dry] [--days=N]
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')
const args = process.argv.slice(2)
const clientId = args[0]
if (!clientId) { console.error('clientId required'); process.exit(1) }
const to = args.find((a, i) => i > 0 && !a.startsWith('--'))
const dryRun = args.includes('--dry')
const days = Number((args.find(a => a.startsWith('--days=')) || '').split('=')[1]) || undefined
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const decryptClient = c => ({ ...c, sendgrid_api_key: c.sendgrid_api_key ? decrypt(c.sendgrid_api_key, process.env.ENCRYPTION_KEY) : null })
const { sendBounceReport } = require('../bounce-report')({ post() {} }, { supabase, decryptClient, cron: null })
sendBounceReport(clientId, { to, dryRun, days })
  .then(r => {
    console.log('subject:', r.subject || r.skipped); console.log('recipients:', r.recipients.join(', '))
    if (dryRun) console.log(`typos ${r.typos}, other address ${r.moved}, no domain ${r.noDomain}, gone ${r.gone}, possible false ${r.maybeFalse}\n\n${r.text}`)
  })
  .catch(e => { console.error(e); process.exit(1) })
