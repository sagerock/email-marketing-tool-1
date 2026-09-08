// Scoped production migration runner. Read-only unless --apply is supplied.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

if (!process.env.VITE_SUPABASE_URL) throw new Error('VITE_SUPABASE_URL is required')
const projectRef = new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(
  path.join(os.homedir(), '.supabase/access-token'),
  'utf8',
).trim()

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60000),
  })
  const result = await response.json()
  if (!response.ok) {
    throw new Error(`Database request failed (${response.status}): ${result.message || 'See provider logs'}`)
  }
  return result
}

const table = await query("SELECT to_regclass('public.search_console_integrations') AS name")
if (table[0]?.name) {
  const audit = (await query(`
    SELECT
      c.id AS client_id,
      (length(c.sendgrid_api_key) = 0) AS email_sending_disabled,
      i.site_url,
      i.last_final_date,
      i.last_sync_status,
      (SELECT count(*)::int FROM public.search_console_credentials k WHERE k.client_id = c.id) AS credentials,
      (SELECT count(*)::int FROM public.search_console_site_daily d WHERE d.client_id = c.id) AS daily_rows,
      (SELECT count(*)::int FROM public.search_console_query_page_daily d WHERE d.client_id = c.id) AS detail_rows,
      (SELECT count(*)::int FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'public'
         AND g.table_name = 'search_console_credentials'
         AND g.grantee IN ('anon', 'authenticated')) AS credential_user_grants
    FROM public.clients c
    JOIN public.search_console_integrations i ON i.client_id = c.id
    WHERE c.name = 'Center for Orthopedics'
  `))[0]
  console.log(JSON.stringify({ migration: '090_search_console_warehouse', installed: true, audit }, null, 2))
  process.exit(0)
}

if (!process.argv.includes('--apply')) {
  console.log('Migration 090 is pending. Pass --apply to install it.')
  process.exit(0)
}

const before = (await query(`
  SELECT
    (SELECT count(*)::int FROM public.clients) AS clients,
    (SELECT count(*)::int FROM public.contacts) AS contacts,
    (SELECT count(*)::int FROM public.campaigns) AS campaigns,
    (SELECT count(*)::int FROM public.clients WHERE name = 'Center for Orthopedics') AS c4o_clients
`))[0]

const migration = fs.readFileSync(
  new URL('../supabase/migrations/090_search_console_warehouse.sql', import.meta.url),
  'utf8',
)
await query(migration)

const after = (await query(`
  SELECT
    (SELECT count(*)::int FROM public.clients) AS clients,
    (SELECT count(*)::int FROM public.contacts) AS contacts,
    (SELECT count(*)::int FROM public.campaigns) AS campaigns,
    (SELECT count(*)::int FROM public.clients WHERE name = 'Center for Orthopedics') AS c4o_clients,
    (SELECT count(*)::int FROM public.search_console_integrations WHERE site_url = 'sc-domain:center4orthopedics.com') AS integrations,
    (SELECT count(*)::int FROM public.search_console_credentials) AS credentials
`))[0]

if (Number(after.contacts) !== Number(before.contacts)) throw new Error('Contact count changed during migration')
if (Number(after.campaigns) !== Number(before.campaigns)) throw new Error('Campaign count changed during migration')
if (Number(after.clients) !== Number(before.clients) + (Number(before.c4o_clients) ? 0 : 1)) {
  throw new Error('Unexpected client count after migration')
}
if (Number(after.c4o_clients) !== 1 || Number(after.integrations) !== 1) {
  throw new Error('Center for Orthopedics tenant or Search Console integration was not created exactly once')
}

console.log(JSON.stringify({ migration: '090_search_console_warehouse', before, after }, null, 2))
