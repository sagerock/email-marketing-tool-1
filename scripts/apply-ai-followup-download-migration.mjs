// Install migration 102 (AI follow-ups triggered by synced member downloads).
//   node scripts/apply-ai-followup-download-migration.mjs          # read-only check
//   node scripts/apply-ai-followup-download-migration.mjs --apply  # install
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const projectRef = new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  || fs.readFileSync(path.join(os.homedir(), '.supabase/access-token'), 'utf8').trim()

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60000),
  })
  const result = await response.json()
  if (!response.ok) {
    throw new Error(`Database migration request failed (${response.status}): ${result.message || 'See provider logs'}`)
  }
  return result
}

const CHECK = `
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='ai_followup_config' AND column_name='trigger_download_resource') AS config_cols,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='ai_followup_contacts' AND column_name='source_activity_id') AS enrollment_cols,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='salesforce_prospect_activities' AND column_name='followup_processed_at') AS activity_cols,
    to_regclass('public.idx_ai_followup_contacts_source_activity') IS NOT NULL AS unique_index,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='ai_followup_config' AND column_name='trigger_download_resource')
      THEN (SELECT count(*)::int FROM public.ai_followup_config
            WHERE to_jsonb(ai_followup_config)->>'trigger_download_resource' IS NOT NULL)
      ELSE 0 END AS routed_agents,
    (SELECT count(*)::int FROM public.ai_followup_contacts) AS enrollments
`

const before = (await query(CHECK))[0]
const installed = before.config_cols && before.enrollment_cols && before.activity_cols && before.unique_index

if (installed) {
  console.log(`Migration 102 is already installed (${before.routed_agents} download-routed agent(s)).`)
} else if (!process.argv.includes('--apply')) {
  console.log('Migration 102 (ai_followup_download_triggers) pending. Pass --apply to install.')
} else {
  await query(fs.readFileSync(new URL('../supabase/migrations/102_ai_followup_download_triggers.sql', import.meta.url), 'utf8'))
  const after = (await query(CHECK))[0]
  if (!(after.config_cols && after.enrollment_cols && after.activity_cols && after.unique_index)) {
    throw new Error('Migration returned successfully but required objects are missing')
  }
  if (after.enrollments !== before.enrollments) {
    throw new Error('Migration installed, but the enrollment row count changed unexpectedly')
  }
  console.log(JSON.stringify({ applied: ['102_ai_followup_download_triggers'], verified: after }, null, 2))
}
