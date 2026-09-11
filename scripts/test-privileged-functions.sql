-- Run after test-security-hardening.sql in the same disposable database.
DO $$ BEGIN IF current_database()<>'security_hardening_test' THEN RAISE EXCEPTION 'Disposable test database required'; END IF; END $$;
ALTER TABLE contacts ADD COLUMN tags text[];
UPDATE contacts SET tags=ARRAY[CASE WHEN id='20000000-0000-0000-0000-000000000001' THEN 'A-only' ELSE 'B-only' END];
GRANT SELECT ON contacts TO service_role;
CREATE FUNCTION get_tag_counts(p_client_id uuid,p_audience_filter text[] DEFAULT NULL)
RETURNS TABLE(tag_name text,cnt bigint) LANGUAGE sql SECURITY DEFINER AS $$
 SELECT t,count(*) FROM public.contacts,unnest(tags) t WHERE client_id=p_client_id GROUP BY t
$$;
CREATE FUNCTION email_tracker_change(uuid,text,uuid,text,text,timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER AS $$ SELECT $1 $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['apply_engagement_snapshot','freeze_engagement_snapshot_evidence','engagement_overview','engagement_reporting_candidates','engagement_snapshot_report','fill_opportunity_emails','recompute_woo_rollups','refresh_alconox_safe_send','email_tracker_record','email_tracker_snapshot','get_program_enrollment_counts','cfa_dashboard_stats'] LOOP
  EXECUTE format('CREATE FUNCTION %I(uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 1 $f$',n);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I(uuid) TO anon,authenticated,service_role',n);
 END LOOP;
END $$;
CREATE FUNCTION engagement_reporting_candidates(uuid,integer) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
GRANT EXECUTE ON FUNCTION engagement_reporting_candidates(uuid,integer) TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
\ir ../supabase/migrations/097_privileged_function_boundaries.sql
\ir ../supabase/migrations/097_privileged_function_boundaries.sql
DO $$ DECLARE f record; n integer:=0; BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname IN ('apply_engagement_snapshot','freeze_engagement_snapshot_evidence','engagement_overview','engagement_reporting_candidates','engagement_snapshot_report','fill_opportunity_emails','recompute_woo_rollups','refresh_alconox_safe_send','email_tracker_record','email_tracker_snapshot','get_program_enrollment_counts','cfa_dashboard_stats') LOOP
  n:=n+1;
  IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE') OR NOT has_function_privilege('service_role',f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Incorrect RPC grants'; END IF;
 END LOOP;
 IF n<>13 THEN RAISE EXCEPTION 'Missing overload coverage'; END IF;
 IF has_function_privilege('anon','email_tracker_change(uuid,text,uuid,text,text,timestamptz)','EXECUTE') OR NOT has_function_privilege('authenticated','email_tracker_change(uuid,text,uuid,text,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'Browser tracker contract failed'; END IF;
END $$;
CREATE FUNCTION future_private_rpc() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
DO $$ BEGIN
 IF has_function_privilege('anon','future_private_rpc()','EXECUTE') OR has_function_privilege('authenticated','future_private_rpc()','EXECUTE') THEN RAISE EXCEPTION 'Future RPC exposed by default'; END IF;
 IF NOT has_function_privilege('service_role','future_private_rpc()','EXECUTE') THEN RAISE EXCEPTION 'Future service grant missing'; END IF;
END $$;
SET ROLE authenticated;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF (SELECT count(*) FROM get_tag_counts('10000000-0000-0000-0000-000000000001'))<>1 THEN RAISE EXCEPTION 'Own tags unavailable'; END IF;
 IF (SELECT count(*) FROM get_tag_counts('10000000-0000-0000-0000-000000000002'))<>0 THEN RAISE EXCEPTION 'Foreign tags exposed'; END IF;
END $$;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000099';
DO $$ BEGIN IF (SELECT count(*) FROM get_tag_counts('10000000-0000-0000-0000-000000000001'))<>0 THEN RAISE EXCEPTION 'Unassigned account can read tags'; END IF; END $$;
RESET ROLE;
SET ROLE service_role;
DO $$ BEGIN IF (SELECT count(*) FROM get_tag_counts('10000000-0000-0000-0000-000000000002'))<>1 THEN RAISE EXCEPTION 'Server tag retrieval failed'; END IF; END $$;
RESET ROLE;
SELECT 'PASS: backend RPC grants, overloads, browser tag isolation, future defaults, idempotence' AS result;
