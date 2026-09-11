-- Read the restored SYNTHETIC fixture, not production. Do not reapply migrations:
-- the archive itself must preserve data, ownership, grants, RLS and defaults.
DO $$ DECLARE t text; n integer; BEGIN
 IF current_database()<>'security_hardening_test' THEN RAISE EXCEPTION 'Synthetic database required'; END IF;
 FOREACH t IN ARRAY ARRAY['contacts','contact_notes','contact_tasks','knowledge_bases','email_conversations','discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',t) INTO n;
  IF n<>2 THEN RAISE EXCEPTION 'Restored row count failed on %',t; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=format('public.%I',t)::regclass) THEN RAISE EXCEPTION 'RLS lost on %',t; END IF;
 END LOOP;
 IF (SELECT body FROM knowledge_bases WHERE id=1)<>'owned update' OR
    (SELECT body FROM knowledge_bases WHERE id=2)<>'synthetic B' THEN RAISE EXCEPTION 'Restored content differs'; END IF;
 IF has_function_privilege('anon','execute_sql(text)','EXECUTE') OR has_function_privilege('authenticated','execute_sql(text)','EXECUTE') THEN RAISE EXCEPTION 'Restored SQL RPC exposed'; END IF;
 IF has_function_privilege('authenticated','cfa_dashboard_stats(uuid)','EXECUTE') OR NOT has_function_privilege('service_role','cfa_dashboard_stats(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Restored RPC grants wrong'; END IF;
 IF (SELECT proowner FROM pg_proc WHERE oid='can_access_client(uuid)'::regprocedure)<>'postgres'::regrole THEN RAISE EXCEPTION 'Function owner lost'; END IF;
END $$;
SET ROLE authenticated;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF (SELECT count(*) FROM knowledge_bases)<>1 THEN RAISE EXCEPTION 'Restored tenant isolation failed'; END IF;
 IF (SELECT count(*) FROM get_tag_counts('10000000-0000-0000-0000-000000000002'))<>0 THEN RAISE EXCEPTION 'Restored tags leaked'; END IF;
 BEGIN
  UPDATE knowledge_bases SET client_id='10000000-0000-0000-0000-000000000002' WHERE id=1;
  RAISE EXCEPTION 'Restored tenant reassignment allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
 BEGIN PERFORM * FROM knowledge_bases; RAISE EXCEPTION 'Restored anonymous read allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE metabase_ro;
DO $$ BEGIN IF (SELECT count(*) FROM sync_health)<>2 THEN RAISE EXCEPTION 'Restored reporting contract lost'; END IF; END $$;
RESET ROLE;
SET ROLE service_role;
DO $$ BEGIN IF (SELECT count(*) FROM knowledge_bases)<>2 THEN RAISE EXCEPTION 'Restored worker contract lost'; END IF; END $$;
RESET ROLE;
-- Check the RESTORED default ACL by creating a new postgres-owned function.
CREATE FUNCTION post_restore_private_rpc() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
DO $$ BEGIN
 IF has_function_privilege('anon','post_restore_private_rpc()','EXECUTE') OR has_function_privilege('authenticated','post_restore_private_rpc()','EXECUTE') OR NOT has_function_privilege('service_role','post_restore_private_rpc()','EXECUTE') THEN RAISE EXCEPTION 'Restored future defaults failed'; END IF;
END $$;
SELECT 'PASS: restored data, RLS, ownership, grants, workers, reporting and future defaults' AS result;
