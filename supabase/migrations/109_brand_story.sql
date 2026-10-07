-- 109: Brand Story — the client's own description of who they are and how their
-- email should feel, plus a light "look" (logo, colors, fonts, website).
--
-- The AI email builder and the Ask/Polaris draft endpoint read both on every
-- generation. Written through the backend (/api/brand-story), which applies the
-- same client-access rule as other per-client endpoints, so client admins can
-- edit their own story even though clients-table RLS only lets super admins update.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS brand_story text,
  ADD COLUMN IF NOT EXISTS brand_look jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_story_updated_at timestamptz;

COMMIT;
