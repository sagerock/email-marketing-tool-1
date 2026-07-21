-- Re-engagement configuration is managed exclusively through the authenticated
-- API, which uses the service role. Do not expose it through PostgREST.
ALTER TABLE public.reengagement_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reengagement_config FROM anon, authenticated;

-- These RPCs are backend and cron entry points. PostgreSQL grants function
-- execution to PUBLIC by default, so restrict them explicitly.
REVOKE EXECUTE ON FUNCTION public.reengagement_health(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reengagement_classify(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reengagement_classify_all() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reengagement_health(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reengagement_classify(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reengagement_classify_all() TO service_role;
