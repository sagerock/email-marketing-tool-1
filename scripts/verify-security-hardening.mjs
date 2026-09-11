// Live read-only checks. No message bodies, contacts, credentials, or user IDs
// are emitted; SQL impersonation is transaction-local and creates no sessions.
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const env = require('../api/node_modules/dotenv').parse(fs.readFileSync(new URL('../.env', import.meta.url)))
const base = env.VITE_SUPABASE_URL
const ref = new URL(base).hostname.split('.')[0]
if (ref !== 'ckloewflialohuvixmvd') throw new Error('Unexpected project')
const token = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(`${os.homedir()}/.supabase/access-token`, 'utf8').trim()
const tables = ['contact_notes','contact_tasks','email_conversations','knowledge_bases',
  'discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs']
async function management(route, query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/${route}`, {
    method: query ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(query ? { body: JSON.stringify({ query }) } : {}), signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`Read-only management check failed: HTTP ${r.status}`)
  return r.json()
}
const keys = await management('api-keys')
const key = keys.find(k => k.type === 'publishable' && k.name === 'emailmarketingtool')?.api_key
if (!key) throw new Error('Expected public application key missing')
for (const table of [...tables, 'sync_health']) {
  const r = await fetch(`${base}/rest/v1/${table}?select=*&limit=0`, {
    method: 'HEAD', headers: { apikey: key, Prefer: 'count=exact' }, signal: AbortSignal.timeout(15000),
  })
  if (![401,403].includes(r.status)) throw new Error(`Anonymous access not denied on ${table}: ${r.status}`)
  console.log(JSON.stringify({ anonymous_denied: table, status: r.status }))
}
const rpc = await fetch(`${base}/rest/v1/rpc/execute_sql`, {
  method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'SELECT 1 AS harmless_probe' }), signal: AbortSignal.timeout(15000),
})
await rpc.body?.cancel()
if (![401,403,404].includes(rpc.status)) throw new Error(`Anonymous SQL RPC not denied: ${rpc.status}`)
console.log(JSON.stringify({ anonymous_sql_denied: true, status: rpc.status }))

const result = await management('database/query', `BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
DO $verify$
DECLARE u record; t text; expected bigint; actual bigint; total_users integer := 0;
BEGIN
 FOR u IN SELECT user_id,role,client_id FROM public.admin_users LOOP
  total_users := total_users + 1;
  FOREACH t IN ARRAY ARRAY[${tables.map(t => `'${t}'`).join(',')}] LOOP
   IF u.role IN ('admin','super_admin') THEN
    EXECUTE format('SELECT count(*) FROM public.%I',t) INTO expected;
   ELSE
    EXECUTE format('SELECT count(*) FROM public.%I WHERE client_id=$1',t) INTO expected USING u.client_id;
   END IF;
   PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u.user_id,'role','authenticated')::text,true);
   SET LOCAL ROLE authenticated;
   EXECUTE format('SELECT count(*) FROM public.%I',t) INTO actual;
   RESET ROLE;
   IF expected<>actual THEN RAISE EXCEPTION 'Client read isolation failed on %',t; END IF;
  END LOOP;
 END LOOP;
 IF total_users=0 THEN RAISE EXCEPTION 'No real application roles checked'; END IF;
 FOREACH t IN ARRAY ARRAY[${tables.map(t => `'${t}'`).join(',')}] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',t) INTO expected;
  SET LOCAL ROLE service_role;
  EXECUTE format('SELECT count(*) FROM public.%I',t) INTO actual;
  RESET ROLE;
  IF expected<>actual THEN RAISE EXCEPTION 'Service read access failed on %',t; END IF;
 END LOOP;
END;
$verify$;
SELECT 'PASS' AS role_isolation_and_service_reads, (SELECT count(*) FROM public.admin_users) AS application_roles_checked;
COMMIT;`)
console.log(JSON.stringify(result))
