-- 121: function hardening (2026-10-20). Fixed search_path on the 22 functions the Supabase
-- linter flagged as mutable; no browser-role EXECUTE on trigger functions (they run when their
-- trigger fires, nobody calls them over RPC) or on the helper overloads that take an arbitrary
-- user id (no policy or app calls them; anyone with the anon key could probe admin user ids).
-- The RLS helpers policies call (can_access_client, is_internal_staff, is_super_admin(),
-- is_admin(), get_user_client_id) keep anon/authenticated EXECUTE on purpose: ~200 policies on
-- anon-readable tables evaluate them, and a missing EXECUTE would turn an empty result into a
-- permission error for every app sharing this project. cfa_website_lead stays anon-callable
-- (CfA website form).
--
-- CONVENTION for new functions: `set search_path = public, pg_temp` on every function, and
-- `revoke execute ... from public, anon, authenticated` on trigger functions and anything only
-- the server calls. Applied in production 2026-10-20 via the Supabase MCP.

alter function public.append_tag_to_contacts(uuid, text, text[]) set search_path = public, pg_temp;
alter function public.cfa_source_of(text) set search_path = public, pg_temp;
alter function public.engagement_evidence_classification(timestamptz, date, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, integer) set search_path = public, pg_temp;
alter function public.engagement_opportunity_last_touch(date, timestamptz, timestamptz) set search_path = public, pg_temp;
alter function public.execute_sql(text) set search_path = public, pg_temp;
alter function public.fill_opportunity_emails(uuid) set search_path = public, pg_temp;
alter function public.form_submissions(uuid, date) set search_path = public, pg_temp;
alter function public.get_campaign_link_stats(uuid) set search_path = public, pg_temp;
alter function public.get_campaign_unique_clicks(uuid) set search_path = public, pg_temp;
alter function public.get_campaign_unique_opens(uuid) set search_path = public, pg_temp;
alter function public.has_client_access(uuid, uuid) set search_path = public, pg_temp;
alter function public.is_admin(uuid) set search_path = public, pg_temp;
alter function public.is_super_admin(uuid) set search_path = public, pg_temp;
alter function public.log_prospect_stage_change() set search_path = public, pg_temp;
alter function public.reengagement_classify(uuid) set search_path = public, pg_temp;
alter function public.reengagement_classify_all() set search_path = public, pg_temp;
alter function public.reengagement_health(uuid) set search_path = public, pg_temp;
alter function public.refresh_alconox_safe_send() set search_path = public, pg_temp;
alter function public.sr_set_updated_at() set search_path = public, pg_temp;
alter function public.try_date(text) set search_path = public, pg_temp;
alter function public.update_sequence_updated_at() set search_path = public, pg_temp;
alter function romalume.touch_updated_at() set search_path = romalume, pg_temp;

-- Trigger functions: firing a trigger does not check EXECUTE, only CREATE TRIGGER does (run as postgres).
revoke execute on function public.email_tracker_campaign_deleted() from public, anon, authenticated;
revoke execute on function public.email_tracker_campaign_sync() from public, anon, authenticated;
revoke execute on function public.email_tracker_template_changed() from public, anon, authenticated;
revoke execute on function public.log_prospect_stage_change() from public, anon, authenticated;
revoke execute on function public.sr_set_updated_at() from public, anon, authenticated;
revoke execute on function public.update_sequence_updated_at() from public, anon, authenticated;

-- User-id-probing helper overloads: server side only from now on.
revoke execute on function public.has_client_access(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.is_admin(uuid) from public, anon, authenticated;
revoke execute on function public.is_super_admin(uuid) from public, anon, authenticated;
grant execute on function public.has_client_access(uuid, uuid) to service_role;
grant execute on function public.is_admin(uuid) to service_role;
grant execute on function public.is_super_admin(uuid) to service_role;
