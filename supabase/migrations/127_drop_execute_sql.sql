-- 127: drop the generic owner-rights SQL function, 2026-11-18.
-- public.execute_sql(text) ran any SELECT/WITH text as the owner, bypassing RLS for every client on
-- this project. Its only application caller was Alconox Analytics, which now calls the fixed
-- reporting functions from migration 126 instead (its AI chat, which passed model-written SQL here,
-- was removed on 2026-11-18). Apply only after the dashboard build that uses migration 126 is live.
-- Rollback: recreate it from supabase/baseline/schema_2026-07-28.sql (line ~369) plus the grants in
-- migration 095 and the search_path in migration 121.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.execute_sql(text);
COMMIT;
