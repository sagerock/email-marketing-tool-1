-- 108: Ask Alconox questions keep their Salesforce owner.
--
-- last_modified_by only says who touched a record last (usually Stacy or Michelle moving
-- Status). OwnerId says who the question is assigned to, which is what shows whether a
-- Reviewed question is sitting with the right person. Read-only against Salesforce;
-- populated by the daily Ask Alconox sync and scripts/backfill-ask-alconox-threads.js.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.salesforce_ask_questions
  ADD COLUMN IF NOT EXISTS owner_id text,
  ADD COLUMN IF NOT EXISTS owner_name text;

CREATE INDEX IF NOT EXISTS idx_sf_ask_questions_owner
  ON public.salesforce_ask_questions(client_id, owner_name);

COMMIT;
