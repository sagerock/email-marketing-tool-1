// Install migration 112 (bubble-up: Task/EmailMessage mirrors, survey columns, bubble_* tables).
//   node scripts/apply-bubble-up-migration.mjs          # read-only check
//   node scripts/apply-bubble-up-migration.mjs --apply  # install
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
    (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public'
      AND table_name IN ('salesforce_tasks','salesforce_email_messages','bubble_items','bubble_events','bubble_config')) AS tables,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public'
      AND table_name='salesforce_opportunities' AND column_name LIKE 'survey\\_%' AND column_name <> 'survey_completed') AS survey_cols,
    (SELECT count(*)::int FROM public.salesforce_opportunities) AS opps
`

const before = (await query(CHECK))[0]
if (before.tables === 5 && before.survey_cols === 9) {
  console.log('Migration 112 is already installed.')
} else if (!process.argv.includes('--apply')) {
  console.log(`Migration 112 (bubble-up) pending: ${before.tables}/5 tables, ${before.survey_cols}/9 survey columns. Pass --apply to install.`)
} else {
  await query(fs.readFileSync(new URL('../supabase/migrations/112_bubble_up.sql', import.meta.url), 'utf8'))
  const after = (await query(CHECK))[0]
  if (after.tables !== 5 || after.survey_cols !== 9) throw new Error(`Migration returned but objects are missing: ${JSON.stringify(after)}`)
  if (after.opps !== before.opps) throw new Error('Migration installed, but the opportunity count changed unexpectedly')
  console.log(`Migration 112 installed (${after.opps} opportunity rows untouched).`)
}
