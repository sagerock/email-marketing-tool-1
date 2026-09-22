// Operate the AI Chat case → review-first follow-up bridge against production data.
//
//   node scripts/ai-chat-followups.mjs status                    # agent, cutover, synced/pending cases
//   node scripts/ai-chat-followups.mjs sync [--all]              # pull AI Chat cases from Salesforce (incremental by default)
//   node scripts/ai-chat-followups.mjs dry-run [--cutover=ISO]   # enrollment decisions, no writes
//   node scripts/ai-chat-followups.mjs enable [--since=ISO]      # set the cutover (default: now)
//   node scripts/ai-chat-followups.mjs disable                   # clear the cutover (inert)
//   node scripts/ai-chat-followups.mjs notify [--only=email] [--dry-run]
//                                                                # email reviewers about pending chat drafts
//   node scripts/ai-chat-followups.mjs reviewers a@x.com,b@y.com # set who gets review emails
//
// Generation (the Claude call) only runs on the server, so "enable" is what
// makes the live server enroll + draft + notify on its hourly run.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
const { createClient } = require('@supabase/supabase-js')
const jsforce = require('jsforce')
const sgMail = require('@sendgrid/mail')
const { decrypt } = require('../api/crypto-utils')
const { syncAiChatCases, enrollChatFollowups, notifyPendingChatReviews } = require('../api/ai-chat-followups')

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const [command = 'status', ...rest] = process.argv.slice(2)
const flag = (name) => rest.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const has = (name) => rest.includes(`--${name}`)
const baseUrl = process.env.BASE_URL || 'https://mail.sagerock.com'

async function chatClients() {
  const { data, error } = await supabase.from('ai_followup_config').select('client_id').eq('trigger_ai_chat', true)
  if (error) throw error
  const ids = [...new Set((data || []).map(r => r.client_id))]
  const only = flag('client')
  return only ? ids.filter(id => id === only) : ids
}

async function getSalesforceConnection(clientId) {
  const { data: c, error } = await supabase.from('clients')
    .select('salesforce_instance_url, salesforce_client_id, salesforce_client_secret').eq('id', clientId).single()
  if (error) throw error
  const K = process.env.ENCRYPTION_KEY
  const res = await fetch(`${c.salesforce_instance_url}/services/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: decrypt(c.salesforce_client_id, K), client_secret: decrypt(c.salesforce_client_secret, K) }),
  })
  const tok = await res.json()
  if (!tok.access_token) throw new Error(`Salesforce auth failed: ${JSON.stringify(tok)}`)
  return new jsforce.Connection({ instanceUrl: tok.instance_url, accessToken: tok.access_token })
}

async function sendMail(clientId, msg) {
  const { data: c } = await supabase.from('clients').select('sendgrid_api_key').eq('id', clientId).single()
  sgMail.setApiKey(decrypt(c.sendgrid_api_key, process.env.ENCRYPTION_KEY))
  await sgMail.send(msg)
}

async function status(clientId) {
  const { data: cfgs } = await supabase.from('ai_followup_config')
    .select('id, name, enabled, auto_send, chat_trigger_since, review_notify_emails').eq('client_id', clientId).eq('trigger_ai_chat', true)
  const { count: total } = await supabase.from('salesforce_ai_chat_cases').select('*', { count: 'exact', head: true }).eq('client_id', clientId)
  const { count: pending } = await supabase.from('salesforce_ai_chat_cases').select('*', { count: 'exact', head: true }).eq('client_id', clientId).is('followup_processed_at', null)
  const { data: processed } = await supabase.from('salesforce_ai_chat_cases').select('followup_skip_reason, followup_enrollment_id').eq('client_id', clientId).not('followup_processed_at', 'is', null)
  const outcomes = {}
  for (const r of processed || []) { const k = r.followup_enrollment_id ? 'enrolled' : (r.followup_skip_reason || 'skipped'); outcomes[k] = (outcomes[k] || 0) + 1 }
  console.log(`client ${clientId}`)
  for (const c of cfgs || []) console.log(`  ${c.name}: enabled=${c.enabled} auto_send=${c.auto_send} cutover=${c.chat_trigger_since || 'NOT ENABLED'} reviewers=${c.review_notify_emails || '(none)'}`)
  console.log(`  cases synced: ${total ?? 0}; pending: ${pending ?? 0}; processed: ${JSON.stringify(outcomes)}`)
  for (const c of cfgs || []) {
    const { data: drafts } = await supabase.from('ai_followup_drafts').select('id, status, review_notified_at, reviewed_by_email, contact:contacts(email)').eq('config_id', c.id).order('created_at', { ascending: false }).limit(10)
    for (const d of drafts || []) console.log(`  draft ${d.id.slice(0, 8)} ${d.status} to ${d.contact?.email} notified=${d.review_notified_at ? 'yes' : 'no'} by=${d.reviewed_by_email || '-'}`)
  }
}

for (const clientId of await chatClients()) {
  if (command === 'status') {
    await status(clientId)
  } else if (command === 'sync') {
    let since = null
    if (!has('all')) {
      const { data } = await supabase.from('salesforce_ai_chat_cases').select('sf_last_modified').eq('client_id', clientId).order('sf_last_modified', { ascending: false }).limit(1).maybeSingle()
      since = data?.sf_last_modified ? new Date(new Date(data.sf_last_modified).getTime() - 10 * 60 * 1000).toISOString() : null
    }
    console.log(JSON.stringify({ clientId, since, ...(await syncAiChatCases({ supabase, getSalesforceConnection }, clientId, since)) }))
  } else if (command === 'dry-run') {
    console.log(JSON.stringify({ clientId, ...(await enrollChatFollowups({ supabase }, clientId, { dryRun: true, simulateCutover: flag('cutover') })) }, null, 2))
  } else if (command === 'enable' || command === 'disable') {
    const since = command === 'enable' ? (flag('since') || new Date().toISOString()) : null
    const { data, error } = await supabase.from('ai_followup_config').update({ chat_trigger_since: since }).eq('client_id', clientId).eq('trigger_ai_chat', true).select('name, chat_trigger_since')
    if (error) throw error
    console.log(JSON.stringify({ clientId, [command + 'd']: data }))
  } else if (command === 'notify') {
    const only = flag('only')
    const out = await notifyPendingChatReviews({ supabase, sendMail, baseUrl }, clientId, { onlyReviewers: only ? only.split(',') : undefined, dryRun: has('dry-run') })
    console.log(JSON.stringify({ clientId, ...out }, null, 2))
  } else if (command === 'reviewers') {
    const list = rest.find(a => !a.startsWith('--'))
    if (!list) throw new Error('Usage: reviewers a@x.com,b@y.com')
    const { data, error } = await supabase.from('ai_followup_config').update({ review_notify_emails: list }).eq('client_id', clientId).eq('trigger_ai_chat', true).select('name, review_notify_emails')
    if (error) throw error
    console.log(JSON.stringify({ clientId, updated: data }))
  } else {
    throw new Error(`Unknown command "${command}"`)
  }
}
