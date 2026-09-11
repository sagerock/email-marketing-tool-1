-- Continue scoped RPC hardening. Existing server workers retain their contract.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'apply_engagement_snapshot','freeze_engagement_snapshot_evidence',
      'engagement_overview','engagement_reporting_candidates','engagement_snapshot_report',
      'fill_opportunity_emails','recompute_woo_rollups','refresh_alconox_safe_send',
      'email_tracker_record','email_tracker_snapshot','get_program_enrollment_counts',
      'cfa_dashboard_stats'
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END;
$migration$;

-- The contact screen really does call this RPC directly. Execute as its caller
-- so contacts RLS enforces tenant ownership, including for a forged client ID.
ALTER FUNCTION public.get_tag_counts(uuid,text[]) SECURITY INVOKER;
ALTER FUNCTION public.get_tag_counts(uuid,text[]) SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION public.get_tag_counts(uuid,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_tag_counts(uuid,text[]) TO authenticated,service_role;

-- This browser RPC already validates can_access_client before any mutation.
REVOKE ALL ON FUNCTION public.email_tracker_change(uuid,text,uuid,text,text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.email_tracker_change(uuid,text,uuid,text,text,timestamptz) TO authenticated,service_role;

-- Future postgres-owned functions must opt in to browser access explicitly.
-- Revoking PUBLIC alone does not remove Supabase's explicit per-schema grants.
-- Global PUBLIC revocation is necessary: a schema-level revoke cannot undo it.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
COMMIT;
