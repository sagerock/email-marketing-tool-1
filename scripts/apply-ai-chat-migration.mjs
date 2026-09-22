// Install migration 103 (AI Chat case follow-ups with email review).
//   node scripts/apply-ai-chat-migration.mjs          # read-only check
//   node scripts/apply-ai-chat-migration.mjs --apply  # install
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
  if (!response.ok) throw new Error(`Database migration request failed (${response.status}): ${result.message || 'See provider logs'}`)
  return result
}

const CHECK = `
  SELECT
    to_regclass('public.salesforce_ai_chat_cases') IS NOT NULL AS cases_table,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='ai_followup_config' AND column_name='trigger_ai_chat') AS config_cols,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='ai_followup_contacts' AND column_name='source_case_id') AS enrollment_cols,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='ai_followup_drafts' AND column_name='reviewed_by_email') AS draft_cols,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='ai_followup_config' AND column_name='trigger_ai_chat')
      THEN (SELECT count(*)::int FROM public.ai_followup_config WHERE (to_jsonb(ai_followup_config)->>'trigger_ai_chat')::boolean)
      ELSE 0 END AS chat_agents,
    (SELECT count(*)::int FROM public.ai_followup_config) AS configs,
    (SELECT count(*)::int FROM public.ai_followup_drafts) AS drafts
`

const before = (await query(CHECK))[0]
const installed = before.cases_table && before.config_cols && before.enrollment_cols && before.draft_cols

if (installed) {
  console.log(`Migration 103 is already installed (${before.chat_agents} chat agent(s)).`)
} else if (!process.argv.includes('--apply')) {
  console.log('Migration 103 (ai_chat_case_followups) pending. Pass --apply to install.')
} else {
  await query(fs.readFileSync(new URL('../supabase/migrations/103_ai_chat_case_followups.sql', import.meta.url), 'utf8'))
  const after = (await query(CHECK))[0]
  if (!(after.cases_table && after.config_cols && after.enrollment_cols && after.draft_cols)) {
    throw new Error('Migration returned successfully but required objects are missing')
  }
  if (after.drafts !== before.drafts) throw new Error('Migration installed, but the draft row count changed unexpectedly')
  if (after.configs !== before.configs + 1) throw new Error(`Expected exactly one new agent row, got ${after.configs - before.configs}`)
  console.log(JSON.stringify({ applied: ['103_ai_chat_case_followups'], verified: after }, null, 2))
}
