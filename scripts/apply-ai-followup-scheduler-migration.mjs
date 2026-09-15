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

const installed = await query(`
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='claim_due_ai_followups'
  ) AS installed
`)

if (installed[0].installed) {
  console.log('Migration 098 is already installed.')
} else if (!process.argv.includes('--apply')) {
  console.log('Migration 098 is pending. Pass --apply to install it.')
} else {
  const before = await query(`
    SELECT
      count(*) FILTER (WHERE status='sending')::int AS sending,
      count(*)::int AS drafts
    FROM public.ai_followup_drafts
  `)
  if (before[0].sending !== 0) {
    throw new Error('An AI follow-up draft is actively sending; retry after it finishes')
  }

  const migration = fs.readFileSync(
    new URL('../supabase/migrations/098_ai_followup_scheduler_claims.sql', import.meta.url),
    'utf8',
  )
  await query(migration)

  const after = await query(`
    SELECT
      to_regprocedure('public.claim_due_ai_followups(integer,integer)') IS NOT NULL AS function_installed,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ai_followup_drafts' AND column_name='generation_key'
      ) AS generation_key_installed,
      to_regclass('public.idx_ai_followup_drafts_generation_key') IS NOT NULL AS unique_index_installed,
      (SELECT count(*)::int FROM public.ai_followup_drafts) AS drafts
  `)
  if (!after[0].function_installed || !after[0].generation_key_installed || !after[0].unique_index_installed) {
    throw new Error('Migration returned successfully but required scheduler objects are missing')
  }
  if (after[0].drafts !== before[0].drafts) {
    throw new Error('Migration installed, but the AI draft row count changed unexpectedly')
  }
  console.log(JSON.stringify({ migration: '098_ai_followup_scheduler_claims', verified: after[0] }, null, 2))
}
