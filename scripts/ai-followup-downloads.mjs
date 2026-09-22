// Operate the member-download → AI follow-up bridge against production data.
//
//   node scripts/ai-followup-downloads.mjs status            # agents, cutover, pending downloads
//   node scripts/ai-followup-downloads.mjs dry-run           # what the next run would do, no writes
//   node scripts/ai-followup-downloads.mjs dry-run --cutover=2026-09-19T00:00:00Z
//                                                            # ...pretending the cutover were that time
//   node scripts/ai-followup-downloads.mjs enable            # set the cutover to now on routed agents
//   node scripts/ai-followup-downloads.mjs disable           # clear the cutover (bridge goes inert)
//   node scripts/ai-followup-downloads.mjs run               # enroll for real, WITHOUT generating
//                                                            # (the server's scheduler sends step 1)
//
// The live server also runs the bridge itself after every Salesforce sync and
// on its hourly download check, with immediate generation. "run" here is for
// catching up from a terminal when the server is not doing it.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
const { createClient } = require('@supabase/supabase-js')
const { enrollDownloadFollowups } = require('../api/ai-followup-downloads')

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const command = process.argv[2] || 'status'
const clientArg = process.argv.find(a => a.startsWith('--client='))?.slice('--client='.length)
const cutoverArg = process.argv.find(a => a.startsWith('--cutover='))?.slice('--cutover='.length)

async function routedClients() {
  const { data, error } = await supabase
    .from('ai_followup_config')
    .select('client_id')
    .not('trigger_download_resource', 'is', null)
  if (error) throw error
  const ids = [...new Set((data || []).map(r => r.client_id))]
  return clientArg ? ids.filter(id => id === clientArg) : ids
}

async function status(clientId) {
  const { data: configs } = await supabase
    .from('ai_followup_config')
    .select('name, enabled, auto_send, trigger_download_resource, download_trigger_since')
    .eq('client_id', clientId)
    .not('trigger_download_resource', 'is', null)
  const { count: pending } = await supabase
    .from('salesforce_prospect_activities')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('channel', 'Resource Download').is('followup_processed_at', null)
  const { data: processed } = await supabase
    .from('salesforce_prospect_activities')
    .select('followup_skip_reason, followup_enrollment_id')
    .eq('client_id', clientId).eq('channel', 'Resource Download').not('followup_processed_at', 'is', null)
  const outcomes = {}
  for (const r of processed || []) {
    const k = r.followup_enrollment_id ? 'enrolled' : (r.followup_skip_reason || 'skipped')
    outcomes[k] = (outcomes[k] || 0) + 1
  }
  console.log(`client ${clientId}`)
  for (const c of configs || []) {
    console.log(`  ${c.name}: resource=${JSON.stringify(c.trigger_download_resource)} enabled=${c.enabled} auto_send=${c.auto_send} cutover=${c.download_trigger_since || 'NOT ENABLED'}`)
  }
  console.log(`  pending downloads: ${pending ?? 0}; processed: ${JSON.stringify(outcomes)}`)
}

for (const clientId of await routedClients()) {
  if (command === 'status') {
    await status(clientId)
  } else if (command === 'dry-run') {
    const result = await enrollDownloadFollowups({ supabase }, clientId, { dryRun: true, simulateCutover: cutoverArg })
    console.log(JSON.stringify({ clientId, ...result }, null, 2))
  } else if (command === 'enable' || command === 'disable') {
    const since = command === 'enable' ? new Date().toISOString() : null
    const { data, error } = await supabase
      .from('ai_followup_config')
      .update({ download_trigger_since: since })
      .eq('client_id', clientId)
      .not('trigger_download_resource', 'is', null)
      .select('name, download_trigger_since')
    if (error) throw error
    console.log(JSON.stringify({ clientId, [command + 'd']: data }, null, 2))
  } else if (command === 'run') {
    const result = await enrollDownloadFollowups({ supabase }, clientId)
    console.log(JSON.stringify({ clientId, ...result }, null, 2))
  } else {
    throw new Error(`Unknown command "${command}"`)
  }
}
