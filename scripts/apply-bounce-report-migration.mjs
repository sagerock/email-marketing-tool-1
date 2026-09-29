// Install migration 105 (weekly bounce report).
//   node scripts/apply-bounce-report-migration.mjs          # read-only check
//   node scripts/apply-bounce-report-migration.mjs --apply  # install
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

const CHECK = `SELECT to_regclass('public.bounce_report_config') IS NOT NULL AS config_table,
  to_regprocedure('public.bounce_report_domain_candidates(uuid,text[])') IS NOT NULL AS domain_fn`
console.log('before:', JSON.stringify(await query(CHECK)))
if (process.argv.includes('--apply')) {
  await query(fs.readFileSync(fileURLToPath(new URL('../supabase/migrations/105_bounce_report.sql', import.meta.url)), 'utf8'))
  console.log('after:', JSON.stringify(await query(CHECK)))
}
