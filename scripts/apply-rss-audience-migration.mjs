// Install migration 111 (RSS audience tags, draft mode, plain style).
//   node scripts/apply-rss-audience-migration.mjs          # read-only check
//   node scripts/apply-rss-audience-migration.mjs --apply  # install
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
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public'
      AND table_name='clients' AND column_name IN ('rss_filter_tags','rss_mode','rss_style')) AS cols,
    (SELECT count(*)::int FROM public.clients) AS clients
`

const before = (await query(CHECK))[0]
if (before.cols === 3) {
  console.log('Migration 111 is already installed.')
} else if (!process.argv.includes('--apply')) {
  console.log(`Migration 111 (rss audience/draft/style) pending: ${before.cols}/3 columns. Pass --apply to install.`)
} else {
  await query(fs.readFileSync(new URL('../supabase/migrations/111_rss_audience_and_draft.sql', import.meta.url), 'utf8'))
  const after = (await query(CHECK))[0]
  if (after.cols !== 3) throw new Error('Migration returned successfully but columns are missing')
  if (after.clients !== before.clients) throw new Error('Migration installed, but the client count changed unexpectedly')
  console.log(`Migration 111 installed (${after.clients} client rows untouched).`)
}
