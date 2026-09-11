-- Targeted containment; preserves owner/service workers and explicit reporting access.
-- No records, credentials, schedules, or existing function bodies are modified.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  target text;
  existing record;
  can_write boolean;
  check_expr text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'contact_notes','contact_tasks','knowledge_bases','email_conversations',
    'discovered_media_urls','cc_contacts','cc_lists','cc_list_memberships','sync_runs'
  ] LOOP
    -- Replace the complete policy set on these exact audited tables. Permissive
    -- policies combine with OR, so leaving an older policy defeats the new one.
    FOR existing IN SELECT policyname FROM pg_policies
      WHERE schemaname='public' AND tablename=target
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', existing.policyname, target);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', target);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', target);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', target);
    EXECUTE format('CREATE POLICY client_read ON public.%I FOR SELECT TO authenticated USING (public.can_access_client(client_id))', target);

    can_write := target IN ('contact_notes','contact_tasks','knowledge_bases');
    IF can_write THEN
      check_expr := 'public.can_access_client(client_id)';
      IF target IN ('contact_notes','contact_tasks') THEN
        check_expr := check_expr || format(' AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = %I.contact_id AND c.client_id = %I.client_id)', target, target);
      END IF;
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', target);
      EXECUTE format('CREATE POLICY client_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', target, check_expr);
      EXECUTE format('CREATE POLICY client_update ON public.%I FOR UPDATE TO authenticated USING (public.can_access_client(client_id)) WITH CHECK (%s)', target, check_expr);
      EXECUTE format('CREATE POLICY client_delete ON public.%I FOR DELETE TO authenticated USING (public.can_access_client(client_id))', target);
    END IF;

    -- metabase_ro is an existing trusted cross-client reporting identity. Preserve
    -- SELECT only where it already has a table grant; do not broaden its grants.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='metabase_ro') THEN
      IF has_table_privilege('metabase_ro', format('public.%I',target), 'SELECT') THEN
        EXECUTE format('CREATE POLICY reporting_read ON public.%I FOR SELECT TO metabase_ro USING (true)',target);
      END IF;
    END IF;
  END LOOP;
END;
$migration$;

-- This is an operations-only owner-rights view. Keep its existing reporting
-- contract: metabase_ro can read the summary but not the raw sync_runs table.
-- Do not expose it to browser roles or grant the reporter new raw-log access.
REVOKE ALL ON public.sync_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sync_health TO service_role;
COMMIT;
