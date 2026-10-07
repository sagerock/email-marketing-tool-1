// Install migration 110 (template version lineage).
//   node scripts/apply-template-versions-migration.mjs          # read-only check
//   node scripts/apply-template-versions-migration.mjs --apply  # install
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
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='templates' AND column_name='source_template_id') AS col,
    (SELECT count(*)::int FROM public.templates) AS templates
`

const before = (await query(CHECK))[0]
if (before.col) {
  console.log('Migration 110 is already installed.')
} else if (!process.argv.includes('--apply')) {
  console.log('Migration 110 (template_versions) pending. Pass --apply to install.')
} else {
  await query(fs.readFileSync(new URL('../supabase/migrations/110_template_versions.sql', import.meta.url), 'utf8'))
  const after = (await query(CHECK))[0]
  if (!after.col) throw new Error('Migration returned successfully but the column is missing')
  if (after.templates !== before.templates) throw new Error('Migration installed, but the template count changed unexpectedly')
  console.log(`Migration 110 installed (${after.templates} template rows untouched).`)
}
