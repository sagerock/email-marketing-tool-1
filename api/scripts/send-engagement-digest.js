// Send (or preview) the weekly engagement digest from the CLI.
//   ENCRYPTION_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/send-engagement-digest.js <clientId> [to@example.com] [--dry]
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')
const [clientId, to, flag] = process.argv.slice(2)
if (!clientId) { console.error('clientId required'); process.exit(1) }
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const decryptClient = c => ({ ...c, sendgrid_api_key: c.sendgrid_api_key ? decrypt(c.sendgrid_api_key, process.env.ENCRYPTION_KEY) : null })
const { sendDigest } = require('../engagement-digest')({ post() {} }, { supabase, decryptClient, cron: null })
sendDigest(clientId, { to: to && !to.startsWith('--') ? to : undefined, dryRun: flag === '--dry' || to === '--dry' })
  .then(r => { console.log('subject:', r.subject); console.log('recipients:', r.recipients.join(', ')); console.log('leads needing a person:', r.attention); if (r.html && process.env.DUMP_HTML) require('fs').writeFileSync(process.env.DUMP_HTML, r.html) })
  .catch(e => { console.error(e); process.exit(1) })
