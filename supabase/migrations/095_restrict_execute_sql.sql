-- Emergency containment approved by Sage, 2026-09-11.
-- This owner-privileged utility is for trusted server operations only.
-- No function body or client data is changed.
BEGIN;
SET LOCAL lock_timeout = '3s';
REVOKE ALL ON FUNCTION public.execute_sql(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO service_role;
COMMIT;
