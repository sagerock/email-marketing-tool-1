\set ON_ERROR_STOP on
-- Run ONLY in a disposable database: pg_virtualenv psql -f scripts/test-email-tracker.sql
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
CREATE TABLE clients(id uuid PRIMARY KEY, name text);
CREATE TABLE admin_users(user_id uuid,email text,client_id uuid);
CREATE FUNCTION can_access_client(id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id=auth.uid() AND client_id=id) $$;
CREATE TABLE templates(id uuid PRIMARY KEY,client_id uuid,html_content text);
CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id uuid REFERENCES clients(id),name text,subject text,template_id uuid REFERENCES templates(id),status text DEFAULT 'draft',from_name text,from_email text,reply_to text,filter_tags text[],audience_filter text[],salesforce_campaign_id uuid,purchase_filter jsonb,bypass_safe_send boolean DEFAULT false,created_at timestamptz DEFAULT now(),scheduled_at timestamptz,sent_at timestamptz,sent_count int DEFAULT 0,failed_count int DEFAULT 0,send_error text);
INSERT INTO clients VALUES('00000000-0000-0000-0000-000000000001','One'),('00000000-0000-0000-0000-000000000002','Two');
INSERT INTO admin_users VALUES('00000000-0000-0000-0000-000000000010','reviewer@example.test','00000000-0000-0000-0000-000000000001');
INSERT INTO templates VALUES('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001','<p>Version one</p>');
INSERT INTO campaigns(id,client_id,name,subject,template_id,status,scheduled_at) VALUES('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000001','Already scheduled','Test subject','00000000-0000-0000-0000-000000000020','scheduled','2026-09-08T18:00:00Z');
\ir ../supabase/migrations/089_email_tracker.sql
CREATE FUNCTION test_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%',msg; END IF; END $$;
SELECT test_assert((SELECT status='scheduled' AND scheduled_at='2026-09-08T18:00:00Z' FROM campaigns WHERE name='Already scheduled'),'Backfill must preserve scheduled campaign');
SELECT test_assert((SELECT count(*)=1 FROM email_tracker_items),'Backfill creates tracker');
SELECT test_assert((SELECT approval IS NULL FROM email_tracker_items),'Never fabricate past approval');

SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000010';
INSERT INTO campaigns(id,client_id,name,subject,template_id) VALUES('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000001','New campaign','Test subject','00000000-0000-0000-0000-000000000020');
SELECT id AS item FROM email_tracker_items WHERE campaign_id='00000000-0000-0000-0000-000000000031' \gset
SELECT test_assert((SELECT kind='campaign_created' AND actor_label='reviewer@example.test' FROM email_tracker_events WHERE item_id=:'item'),'Creation audit with actor');
SET ROLE authenticated;
SELECT email_tracker_change('00000000-0000-0000-0000-000000000001','stage',:'item','waiting_approval','Review requested',(SELECT updated_at FROM email_tracker_items WHERE id=:'item'));
SELECT email_tracker_change('00000000-0000-0000-0000-000000000001','stage',:'item','approved','Stacy: approved by email',(SELECT updated_at FROM email_tracker_items WHERE id=:'item'));
RESET ROLE;
SELECT test_assert((SELECT approval->'snapshot'->>'html_content'='<p>Version one</p>' FROM email_tracker_items WHERE id=:'item'),'Approval snapshots content');
UPDATE campaigns SET status='scheduled',scheduled_at='2026-09-09T18:00:00Z' WHERE id='00000000-0000-0000-0000-000000000031';
UPDATE campaigns SET subject='Changed after approval' WHERE id='00000000-0000-0000-0000-000000000031';
SELECT test_assert((SELECT status='draft' AND scheduled_at IS NULL FROM campaigns WHERE id='00000000-0000-0000-0000-000000000031'),'Subject change cancels pending schedule');
SELECT test_assert((SELECT stage='drafted' AND approval IS NULL FROM email_tracker_items WHERE id=:'item'),'Subject change invalidates approval');
SELECT test_assert((SELECT count(*)=1 FROM email_tracker_events WHERE item_id=:'item' AND kind='approved' AND details->'approval'->'snapshot'->>'subject'='Test subject'),'Historical approval survives invalidation');
SELECT email_tracker_change('00000000-0000-0000-0000-000000000001','stage',:'item','waiting_approval','',(SELECT updated_at FROM email_tracker_items WHERE id=:'item'));
SELECT email_tracker_change('00000000-0000-0000-0000-000000000001','stage',:'item','approved','Stacy: revised version approved',(SELECT updated_at FROM email_tracker_items WHERE id=:'item'));
UPDATE campaigns SET status='scheduled',scheduled_at='2026-09-09T18:00:00Z' WHERE id='00000000-0000-0000-0000-000000000031';
UPDATE templates SET html_content='<p>Version two</p>' WHERE id='00000000-0000-0000-0000-000000000020';
SELECT test_assert((SELECT stage='drafted' AND approval IS NULL FROM email_tracker_items WHERE id=:'item'),'Template edit invalidates approval');
SELECT test_assert((SELECT status='draft' AND scheduled_at IS NULL FROM campaigns WHERE id='00000000-0000-0000-0000-000000000031'),'Template edit cancels schedule');
SELECT test_assert((SELECT status='scheduled' FROM campaigns WHERE name='Already scheduled'),'Unapproved grandfathered schedule survives template edit');
UPDATE campaigns SET status='sending' WHERE id='00000000-0000-0000-0000-000000000031';
UPDATE campaigns SET status='sent',sent_at=now(),sent_count=42 WHERE id='00000000-0000-0000-0000-000000000031';
SELECT test_assert((SELECT count(*)=1 FROM email_tracker_events WHERE item_id=:'item' AND details->>'status'='sent' AND details->>'sent_count'='42'),'Automatic send history');

SELECT email_tracker_change('00000000-0000-0000-0000-000000000001','create',NULL,'Future email','Topic notes') AS plan \gset
SELECT email_tracker_change('00000000-0000-0000-0000-000000000001','link',:'plan','00000000-0000-0000-0000-000000000031','',(SELECT updated_at FROM email_tracker_items WHERE id=:'plan'));
SELECT test_assert((SELECT archived_at IS NOT NULL FROM email_tracker_items WHERE id=:'plan'),'Original plan is retained after linking');
SELECT test_assert((SELECT count(*)=1 FROM email_tracker_events WHERE item_id=:'item' AND kind='plan_linked' AND note='Topic notes'),'Linked campaign retains plan reference');
DELETE FROM campaigns WHERE id='00000000-0000-0000-0000-000000000031';
SELECT test_assert((SELECT campaign_id IS NULL AND archived_at IS NOT NULL AND campaign_snapshot->>'status'='sent' FROM email_tracker_items WHERE id=:'item'),'Deleting a sent campaign preserves archived delivery status');
SELECT test_assert((SELECT count(*)=1 FROM email_tracker_events WHERE item_id=:'item' AND kind='campaign_deleted'),'Campaign removal is audited');

-- Negative paths run as an actual authenticated role, not the migration owner.
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM email_tracker_change('00000000-0000-0000-0000-000000000002','create',NULL,'Cross tenant',''); RAISE EXCEPTION 'FAILED cross tenant allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO email_tracker_events(item_id,client_id,kind,actor_label) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','approved','Fake'); RAISE EXCEPTION 'FAILED audit forgery allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE email_tracker_items SET stage='approved'; RAISE EXCEPTION 'FAILED direct stage mutation allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM email_tracker_record(gen_random_uuid(),'approved'); RAISE EXCEPTION 'FAILED internal function exposed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
DO $$ DECLARE v email_tracker_items; message text; BEGIN
  SELECT * INTO v FROM email_tracker_items WHERE name='Future email';
  BEGIN
    PERFORM email_tracker_change(v.client_id,'note',v.id,NULL,'stale edit','2000-01-01T00:00:00Z');
    RAISE EXCEPTION 'FAILED stale edit allowed';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    IF message <> 'This email changed. Refresh and try again.' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM email_tracker_change(v.client_id,'stage',v.id,'approved','approval',v.updated_at);
    RAISE EXCEPTION 'FAILED approval without review allowed';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    IF message <> 'Request approval first' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000099';
SET ROLE authenticated;
SELECT test_assert((SELECT count(*)=0 FROM email_tracker_items),'RLS hides other tenants');
SELECT test_assert((SELECT count(*)=0 FROM email_tracker_events),'RLS hides history');
RESET ROLE;
SELECT 'PASS: backfill, approval snapshots, invalidation, schedule preservation, automatic send history, planning linkage, and access controls' AS result;
