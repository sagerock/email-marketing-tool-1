-- 110: Template version lineage.
--
-- "Save a new version" in the builder and Polaris revisions both create a new
-- template row. source_template_id records which template it was made from, so
-- a Polaris revision requested from an older review link can follow the chain
-- to the newest version instead of silently revising a stale one.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.templates
  ADD COLUMN IF NOT EXISTS source_template_id uuid REFERENCES public.templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_templates_source_template
  ON public.templates(source_template_id) WHERE source_template_id IS NOT NULL;

COMMIT;
