// Defaults to read-only inspection. Applies only the reviewed security files.
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const env = require('../api/node_modules/dotenv').parse(fs.readFileSync(new URL('../.env', import.meta.url)))
const ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]
if (ref !== 'ckloewflialohuvixmvd') throw new Error('Unexpected Supabase project')
const token = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(`${os.homedir()}/.supabase/access-token`, 'utf8').trim()
async function query(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`Database request failed: HTTP ${r.status}; no automatic retry`)
  return r.json()
}
const selected = process.argv.find(a => a.startsWith('--migration='))?.split('=')[1]
const files = { '095': '095_restrict_execute_sql.sql', '096': '096_client_data_security.sql', '097': '097_privileged_function_boundaries.sql' }
if (process.argv.includes('--apply')) {
  if (!files[selected]) throw new Error('Specify --migration=095, --migration=096, or --migration=097')
  await query(fs.readFileSync(new URL(`../supabase/migrations/${files[selected]}`, import.meta.url), 'utf8'))
  console.log(JSON.stringify({ applied: files[selected] }))
}
console.log(JSON.stringify(await query(`BEGIN READ ONLY;
SELECT now() AS checked_at,
  has_function_privilege('anon','public.execute_sql(text)','EXECUTE') AS anon_sql,
  has_function_privilege('authenticated','public.execute_sql(text)','EXECUTE') AS authenticated_sql,
  has_function_privilege('service_role','public.execute_sql(text)','EXECUTE') AS service_sql,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
    AND tablename IN ('contact_notes','contact_tasks','email_conversations','knowledge_bases',
      'discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs')
    AND roles && ARRAY['public','anon','authenticated']::name[]
    AND (qual='true' OR with_check='true')) AS broad_client_policies;
COMMIT;`), null, 2))
