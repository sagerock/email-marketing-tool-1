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

const rpcResult = await management('database/query', `BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
DO $verify$
DECLARE f record; u record; foreign_client uuid; expected bigint; actual bigint;
 signatures integer := 0; client_checks integer := 0;
BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN (
  'apply_engagement_snapshot','freeze_engagement_snapshot_evidence','engagement_overview',
  'engagement_reporting_candidates','engagement_snapshot_report','fill_opportunity_emails',
  'recompute_woo_rollups','refresh_alconox_safe_send','email_tracker_record',
  'email_tracker_snapshot','get_program_enrollment_counts','cfa_dashboard_stats') LOOP
  signatures := signatures + 1;
  IF has_function_privilege('anon',f.oid,'EXECUTE')
   OR has_function_privilege('authenticated',f.oid,'EXECUTE')
   OR NOT has_function_privilege('service_role',f.oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Backend function grants failed';
  END IF;
 END LOOP;
 IF signatures<>13 THEN RAISE EXCEPTION 'Expected 13 restricted signatures; review schema changes'; END IF;
 IF (SELECT prosecdef FROM pg_proc WHERE oid='public.get_tag_counts(uuid,text[])'::regprocedure)
  OR has_function_privilege('anon','public.get_tag_counts(uuid,text[])','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.get_tag_counts(uuid,text[])','EXECUTE')
  OR NOT has_function_privilege('service_role','public.get_tag_counts(uuid,text[])','EXECUTE') THEN
  RAISE EXCEPTION 'Tag lookup access contract failed';
 END IF;
 IF has_function_privilege('anon','public.email_tracker_change(uuid,text,uuid,text,text,timestamptz)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.email_tracker_change(uuid,text,uuid,text,text,timestamptz)','EXECUTE') THEN
  RAISE EXCEPTION 'Tracker browser contract failed';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclrole='postgres'::regrole
   AND defaclnamespace=0 AND defaclobjtype='f') OR EXISTS (
  SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole='postgres'::regrole AND d.defaclobjtype='f'
   AND d.defaclnamespace IN (0,'public'::regnamespace)
   AND a.grantee IN (0,'anon'::regrole,'authenticated'::regrole)
   AND a.privilege_type='EXECUTE') THEN
  RAISE EXCEPTION 'Future function defaults are exposed';
 END IF;
 FOR u IN SELECT user_id,client_id FROM public.admin_users
  WHERE role='client_admin' AND client_id IS NOT NULL LOOP
  SELECT id INTO foreign_client FROM public.clients WHERE id<>u.client_id LIMIT 1;
  IF foreign_client IS NULL THEN RAISE EXCEPTION 'No foreign client available for isolation check'; END IF;
  SELECT count(*) INTO expected FROM public.get_tag_counts(u.client_id,NULL);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u.user_id,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO actual FROM public.get_tag_counts(u.client_id,NULL);
  IF expected<>actual THEN RAISE EXCEPTION 'Own-client tag lookup failed'; END IF;
  SELECT count(*) INTO actual FROM public.get_tag_counts(foreign_client,NULL);
  RESET ROLE;
  IF actual<>0 THEN RAISE EXCEPTION 'Foreign-client tags exposed'; END IF;
  client_checks := client_checks + 1;
 END LOOP;
 IF client_checks=0 THEN RAISE EXCEPTION 'No client-admin tag isolation checks ran'; END IF;
END;
$verify$;
SELECT 'PASS' AS backend_rpc_grants_tag_isolation_and_future_defaults;
COMMIT;`)
console.log(JSON.stringify(rpcResult))
