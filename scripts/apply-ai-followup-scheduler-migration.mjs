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
  SELECT
    to_regprocedure('public.claim_due_ai_followups(integer,integer)') IS NOT NULL AS claims_installed,
    coalesce(
      position('interval ''72 hours''' in pg_get_functiondef(to_regprocedure('public.claim_due_ai_followups(integer,integer)'))) > 0,
      false
    ) AS spacing_installed
`)

if (installed[0].claims_installed && installed[0].spacing_installed) {
  console.log('AI follow-up scheduler migrations 098-099 are already installed.')
} else if (!process.argv.includes('--apply')) {
  const pending = []
  if (!installed[0].claims_installed) pending.push('098')
  if (!installed[0].spacing_installed) pending.push('099')
  console.log(`AI follow-up scheduler migration${pending.length === 1 ? '' : 's'} ${pending.join(', ')} pending. Pass --apply to install.`)
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

  const applied = []
  if (!installed[0].claims_installed) {
    await query(fs.readFileSync(
      new URL('../supabase/migrations/098_ai_followup_scheduler_claims.sql', import.meta.url),
      'utf8',
    ))
    applied.push('098_ai_followup_scheduler_claims')
  }
  if (!installed[0].spacing_installed) {
    await query(fs.readFileSync(
      new URL('../supabase/migrations/099_ai_followup_contact_spacing.sql', import.meta.url),
      'utf8',
    ))
    applied.push('099_ai_followup_contact_spacing')
  }

  const after = await query(`
    SELECT
      to_regprocedure('public.claim_due_ai_followups(integer,integer)') IS NOT NULL AS function_installed,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ai_followup_drafts' AND column_name='generation_key'
      ) AS generation_key_installed,
      to_regclass('public.idx_ai_followup_drafts_generation_key') IS NOT NULL AS unique_index_installed,
      position('interval ''72 hours''' in pg_get_functiondef(to_regprocedure('public.claim_due_ai_followups(integer,integer)'))) > 0 AS spacing_installed,
      (SELECT count(*)::int FROM public.ai_followup_drafts) AS drafts
  `)
  if (!after[0].function_installed || !after[0].generation_key_installed || !after[0].unique_index_installed || !after[0].spacing_installed) {
    throw new Error('Migration returned successfully but required scheduler objects are missing')
  }
  if (after[0].drafts !== before[0].drafts) {
    throw new Error('Migration installed, but the AI draft row count changed unexpectedly')
  }
  console.log(JSON.stringify({ applied, verified: after[0] }, null, 2))
}
