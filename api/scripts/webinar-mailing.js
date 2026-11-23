#!/usr/bin/env node
// Send (or preview) webinar event mail from webinar_registrations. Dry run unless --send.
// Run where the API's environment is (Railway backend: `railway ssh`), from api/:
//   node scripts/webinar-mailing.js reminder-day  --join=<Zoom Invite Link>          [--send] [--only=addr]
//   node scripts/webinar-mailing.js reminder-hour --join=<Zoom Invite Link>          [--send]
//   node scripts/webinar-mailing.js followup --recording=<url> --checklist=<url>     [--send]
// Needs VITE_SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY (SageRock's SendGrid key is read
// from clients and decrypted, as sendSageRockRequestedMail does). Prints addresses and statuses only.
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')
const { CLIENT_ID } = require('../public-webinar-registration')
const { runMailing, createMailingStore } = require('../webinar-mailings')

const args = Object.fromEntries(process.argv.slice(3).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true] }))
const kind = process.argv[2]

async function main() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const sendMail = async message => {
    const { data, error } = await supabase.from('clients').select('sendgrid_api_key,ip_pool').eq('id', CLIENT_ID).single()
    if (error || !data?.sendgrid_api_key) throw new Error('SageRock sender unavailable')
    const mailer = new (require('@sendgrid/mail').MailService)()
    mailer.setApiKey(decrypt(data.sendgrid_api_key, process.env.ENCRYPTION_KEY))
    mailer.client.setDefaultRequest('timeout', 8000)
    const [response] = await mailer.send({ ...message, ...(data.ip_pool ? { ipPoolName: data.ip_pool } : {}) })
    return { messageId: response.headers?.['x-message-id'] || null }
  }
  const results = await runMailing({
    store: createMailingStore(supabase), sendMail, event: args.event || 'budget-2026-12-08', kind,
    links: { joinUrl: args.join, recordingUrl: args.recording, checklistUrl: args.checklist },
    send: args.send === true, only: typeof args.only === 'string' ? args.only : null,
  })
  for (const r of results) console.log(`${r.status}\t${r.email}`)
  const count = s => results.filter(r => r.status === s).length
  console.log(`${args.send ? 'SENT' : 'DRY RUN'} ${kind}: sent ${count('sent')}, would_send ${count('would_send')}, failed ${count('failed')}, uncertain ${count('uncertain')}, skipped ${results.length - count('sent') - count('would_send') - count('failed') - count('uncertain')}`)
}
main().catch(e => { console.error(e.message); process.exit(1) })
