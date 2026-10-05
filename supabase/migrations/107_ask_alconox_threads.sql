-- 107: Ask Alconox questions with their text and the email conversation that answered them.
--
-- Migration 106 mirrors each Ask_Alconox__c record's status. Sage asked (2026-10-05) to keep
-- the question and the answer too, for later projects (the satisfaction check-in Stacy wants,
-- response times, what people ask about). Salesforce saves the staff answer on the person's
-- Lead/Contact, not on the question record, for most questions (23 of 135 answered in the last
-- 90 days had it on the record). scripts/backfill-ask-alconox-threads.js matches the emails
-- back to the question and writes them here. Read-only against Salesforce.
--
-- match on salesforce_ask_messages:
--   record   EmailMessage.RelatedToId is the question record
--   subject  the person's email whose subject carries the AA number
--   person   the person's first staff email after the question (+ same-subject replies)
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.salesforce_ask_questions
  ADD COLUMN IF NOT EXISTS question_text text,
  ADD COLUMN IF NOT EXISTS first_answer_at timestamptz,   -- first staff email that isn't the auto confirmation
  ADD COLUMN IF NOT EXISTS first_answer_by text,          -- sender address
  ADD COLUMN IF NOT EXISTS answer_match text,             -- record | subject | person | none
  ADD COLUMN IF NOT EXISTS message_count int,
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_message_incoming boolean, -- true = the customer wrote last
  ADD COLUMN IF NOT EXISTS threads_synced_at timestamptz;

CREATE TABLE IF NOT EXISTS public.salesforce_ask_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  question_salesforce_id text NOT NULL,   -- Ask_Alconox__c Id
  question_name text,                     -- AA-3627
  email_message_id text NOT NULL,         -- EmailMessage Id
  message_at timestamptz,
  incoming boolean,
  is_confirmation boolean NOT NULL DEFAULT false,  -- the automatic "working on a response" email
  from_address text,
  to_address text,
  subject text,
  body text,
  match text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, question_salesforce_id, email_message_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_ask_messages_question
  ON public.salesforce_ask_messages(client_id, question_salesforce_id, message_at);

ALTER TABLE public.salesforce_ask_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salesforce_ask_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.salesforce_ask_messages TO authenticated;
GRANT ALL ON public.salesforce_ask_messages TO service_role;
DROP POLICY IF EXISTS client_read ON public.salesforce_ask_messages;
CREATE POLICY client_read ON public.salesforce_ask_messages
  FOR SELECT TO authenticated USING (public.can_access_client(client_id));

COMMIT;
