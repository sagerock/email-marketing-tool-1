// Install migration 106 (Ask Alconox answers count as follow-up).
//   node scripts/apply-ask-alconox-migration.mjs          # read-only check
//   node scripts/apply-ask-alconox-migration.mjs --apply  # install
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

const CHECK = `SELECT to_regclass('public.salesforce_ask_questions') IS NOT NULL AS ask_table,
  position('Ask Alconox answered' in pg_get_functiondef('public.engagement_overview(uuid,int,int)'::regprocedure)) > 0 AS overview_updated`
console.log('before:', JSON.stringify(await query(CHECK)))
if (process.argv.includes('--apply')) {
  await query(fs.readFileSync(fileURLToPath(new URL('../supabase/migrations/106_engagement_ask_alconox.sql', import.meta.url)), 'utf8'))
  console.log('after:', JSON.stringify(await query(CHECK)))
}
