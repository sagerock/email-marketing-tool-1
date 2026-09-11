-- SYNTHETIC DISPOSABLE DATABASE ONLY. psql -v ON_ERROR_STOP=1 -f this-file.
-- The database name must identify this test; never run against production.
DO $$ BEGIN
  IF current_database() <> 'security_hardening_test' THEN
    RAISE EXCEPTION 'Requires disposable security_hardening_test database';
  END IF;
END $$;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE ROLE metabase_ro;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
CREATE TABLE admin_users(user_id uuid,role text,client_id uuid);
INSERT INTO admin_users VALUES
 ('00000000-0000-0000-0000-000000000001','client_admin','10000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000002','client_admin','10000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000003','admin',null);
CREATE FUNCTION can_access_client(target_client_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS (SELECT 1 FROM admin_users WHERE user_id=auth.uid()
 AND (role IN ('super_admin','admin') OR (role='client_admin' AND client_id=target_client_id)))
$$;
CREATE TABLE contacts(id uuid PRIMARY KEY,client_id uuid);
INSERT INTO contacts VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002');
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON contacts TO authenticated;
CREATE POLICY client_read ON contacts FOR SELECT TO authenticated USING(can_access_client(client_id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contact_notes','contact_tasks','knowledge_bases','email_conversations','discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs'] LOOP
  EXECUTE format('CREATE TABLE %I(id integer PRIMARY KEY,client_id uuid,contact_id uuid,body text)',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('GRANT ALL ON %I TO anon,authenticated,service_role',t);
  EXECUTE format('CREATE POLICY unsafe ON %I USING(true) WITH CHECK(true)',t);
  EXECUTE format('INSERT INTO %I SELECT 1,client_id,id,''synthetic A'' FROM contacts WHERE id=''20000000-0000-0000-0000-000000000001''',t);
  EXECUTE format('INSERT INTO %I SELECT 2,client_id,id,''synthetic B'' FROM contacts WHERE id=''20000000-0000-0000-0000-000000000002''',t);
 END LOOP;
END $$;
CREATE VIEW sync_health AS SELECT id,client_id FROM sync_runs;
GRANT SELECT ON sync_health TO anon,authenticated,metabase_ro;
CREATE FUNCTION execute_sql(query text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '[]'::jsonb $$;
\ir ../supabase/migrations/095_restrict_execute_sql.sql
\ir ../supabase/migrations/096_client_data_security.sql
-- Migrations are safely repeatable.
\ir ../supabase/migrations/095_restrict_execute_sql.sql
\ir ../supabase/migrations/096_client_data_security.sql
DO $$ DECLARE t text; BEGIN
 IF has_function_privilege('anon','execute_sql(text)','execute') OR has_function_privilege('authenticated','execute_sql(text)','execute') THEN RAISE EXCEPTION 'SQL RPC exposed'; END IF;
 IF NOT has_function_privilege('service_role','execute_sql(text)','execute') THEN RAISE EXCEPTION 'Server SQL utility broken'; END IF;
 FOREACH t IN ARRAY ARRAY['contact_notes','contact_tasks','knowledge_bases','email_conversations','discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs'] LOOP
  IF has_table_privilege('anon',t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Anonymous grants on %',t; END IF;
  IF has_table_privilege('authenticated',t,'TRUNCATE,TRIGGER,REFERENCES') THEN RAISE EXCEPTION 'Excess browser privilege on %',t; END IF;
 END LOOP;
END $$;
SET ROLE authenticated;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
DO $$ DECLARE t text; n integer; BEGIN
 FOREACH t IN ARRAY ARRAY['contact_notes','contact_tasks','knowledge_bases','email_conversations','discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs'] LOOP
  EXECUTE format('SELECT count(*) FROM %I',t) INTO n;
  IF n<>1 THEN RAISE EXCEPTION 'Tenant A read isolation failed: %',t; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['contact_notes','contact_tasks','knowledge_bases'] LOOP
  EXECUTE format('UPDATE %I SET body=''owned update'' WHERE id=1',t); GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'Own update denied: %',t; END IF;
  EXECUTE format('UPDATE %I SET body=''forbidden'' WHERE id=2',t); GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'Foreign update allowed: %',t; END IF;
  EXECUTE format('DELETE FROM %I WHERE id=2',t); GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'Foreign delete allowed: %',t; END IF;
  BEGIN
   EXECUTE format('UPDATE %I SET client_id=''10000000-0000-0000-0000-000000000002'' WHERE id=1',t);
   RAISE EXCEPTION 'Tenant reassignment allowed: %',t;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
   EXECUTE format('INSERT INTO %I VALUES(3,''10000000-0000-0000-0000-000000000002'',''20000000-0000-0000-0000-000000000002'',''bad'')',t);
   RAISE EXCEPTION 'Foreign insert allowed: %',t;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE format('INSERT INTO %I VALUES(3,''10000000-0000-0000-0000-000000000001'',''20000000-0000-0000-0000-000000000001'',''owned'')',t);
  EXECUTE format('DELETE FROM %I WHERE id=3',t); GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'Own delete denied: %',t; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['contact_notes','contact_tasks'] LOOP
  BEGIN
   EXECUTE format('INSERT INTO %I VALUES(3,''10000000-0000-0000-0000-000000000001'',''20000000-0000-0000-0000-000000000002'',''bad parent'')',t);
   RAISE EXCEPTION 'Cross-client parent accepted: %',t;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 BEGIN
  INSERT INTO email_conversations VALUES(3,'10000000-0000-0000-0000-000000000001',null,'browser forgery');
  RAISE EXCEPTION 'Browser may forge email history';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
DO $$ BEGIN IF (SELECT count(*) FROM knowledge_bases WHERE id=1)<>0 OR (SELECT count(*) FROM knowledge_bases WHERE id=2)<>1 THEN RAISE EXCEPTION 'Tenant B isolation'; END IF; END $$;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM knowledge_bases)<>2 THEN RAISE EXCEPTION 'Internal admin access broken'; END IF; END $$;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000099';
DO $$ BEGIN IF (SELECT count(*) FROM knowledge_bases)<>0 THEN RAISE EXCEPTION 'Unassigned account has access'; END IF; END $$;
RESET ROLE;
SET ROLE metabase_ro;
DO $$ BEGIN IF (SELECT count(*) FROM sync_health)<>2 THEN RAISE EXCEPTION 'Reporting summary broken'; END IF; END $$;
RESET ROLE;
SET ROLE service_role;
DO $$ DECLARE t text; n integer; BEGIN
 FOREACH t IN ARRAY ARRAY['contact_notes','contact_tasks','knowledge_bases','email_conversations','discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs'] LOOP
  EXECUTE format('SELECT count(*) FROM %I',t) INTO n;
  IF n<>2 THEN RAISE EXCEPTION 'Server read broken: %',t; END IF;
  EXECUTE format('INSERT INTO %I VALUES(4,null,null,''server-only fixture'')',t);
  EXECUTE format('DELETE FROM %I WHERE id=4',t);
 END LOOP;
END $$;
RESET ROLE;
SELECT 'PASS: isolation, CRUD, reassignment, parent ownership, worker/reporting access, idempotence' AS result;
