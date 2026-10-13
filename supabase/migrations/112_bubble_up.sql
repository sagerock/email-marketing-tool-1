-- 112: Bubble-up, phase 1 (Alconox, 2026-10-13).
--
-- A living list of people who showed a buying or "help me" signal and haven't heard from a
-- human. Spec: sagerock/clients/alconox/specs/2026-10-13-bubble-up-spec.md. Phase 1 detects
-- and reports to Sage only; nothing goes to Alconox staff or customers from this migration.
--
-- Adds:
--   salesforce_opportunities  sample-survey answers, owner id, record type, sample contact
--   salesforce_tasks          open Tasks + anything touched in the last 120 days
--   salesforce_email_messages last 90 days of EmailMessage, both directions, first 2 KB of body
--   bubble_items / bubble_events / bubble_config
-- Read-only against Salesforce.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.salesforce_opportunities
  ADD COLUMN IF NOT EXISTS owner_id text,
  ADD COLUMN IF NOT EXISTS record_type text,
  ADD COLUMN IF NOT EXISTS sample_request_contact_id text,
  ADD COLUMN IF NOT EXISTS survey_completed_date date,
  ADD COLUMN IF NOT EXISTS survey_met_needs text,
  ADD COLUMN IF NOT EXISTS survey_speak_with_expert text,
  ADD COLUMN IF NOT EXISTS survey_planning_purchase text,
  ADD COLUMN IF NOT EXISTS survey_purchase_from text,
  ADD COLUMN IF NOT EXISTS survey_why_not text,
  ADD COLUMN IF NOT EXISTS survey_additional text,
  ADD COLUMN IF NOT EXISTS survey_sends integer,
  ADD COLUMN IF NOT EXISTS survey_opens integer;

CREATE TABLE IF NOT EXISTS public.salesforce_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  salesforce_id text NOT NULL,
  subject text,
  status text,
  priority text,
  is_closed boolean,
  task_subtype text,
  activity_date date,
  sf_created_at timestamptz,
  sf_last_modified_at timestamptz,
  completed_at timestamptz,
  owner_id text,
  owner_name text,
  created_by_name text,
  who_id text,                 -- Lead / Contact
  who_name text,
  what_id text,                -- Opportunity / Account / Ask_Alconox__c ...
  what_name text,
  description text,            -- first 2 KB
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, salesforce_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_tasks_who ON public.salesforce_tasks(client_id, who_id, sf_created_at);
CREATE INDEX IF NOT EXISTS idx_sf_tasks_what ON public.salesforce_tasks(client_id, what_id, sf_created_at);
CREATE INDEX IF NOT EXISTS idx_sf_tasks_open ON public.salesforce_tasks(client_id, is_closed, sf_created_at);

CREATE TABLE IF NOT EXISTS public.salesforce_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  salesforce_id text NOT NULL,
  message_at timestamptz,
  incoming boolean,
  from_address text,           -- lower-cased
  from_name text,
  to_address text,             -- as Salesforce stores it, ; separated
  cc_address text,
  subject text,
  body text,                   -- first 2 KB of TextBody
  related_to_id text,
  related_to_name text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, salesforce_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_email_from ON public.salesforce_email_messages(client_id, from_address, message_at);
CREATE INDEX IF NOT EXISTS idx_sf_email_at ON public.salesforce_email_messages(client_id, message_at);

CREATE TABLE IF NOT EXISTS public.bubble_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,            -- '<signal>:<salesforce id or address>'
  signal text NOT NULL,                -- S1..S8
  person_sf_id text,
  person_name text,
  person_email text,
  company text,
  owner_name text,                     -- Salesforce owner; null = unassigned
  evidence text,                       -- one line: why this person is here
  quote text,                          -- what they said, short
  sf_url text,
  score integer NOT NULL DEFAULT 0,
  signal_at timestamptz,               -- when the person did the thing
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'notified', 'handled', 'not_useful', 'snoozed', 'expired')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  nudge_count integer NOT NULL DEFAULT 0,
  snooze_until timestamptz,
  closed_at timestamptz,
  closed_by text,                      -- 'auto' or a person
  close_reason text,
  close_evidence text,
  UNIQUE (client_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_bubble_items_open ON public.bubble_items(client_id, status, score DESC);

CREATE TABLE IF NOT EXISTS public.bubble_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.bubble_items(id) ON DELETE CASCADE,
  event text NOT NULL,                 -- detected | notified | replied | snoozed | reassigned | auto_closed | expired | reopened | useful | not_useful
  actor text,
  detail text,
  email_log_id text,                   -- Ask email_log message id when it came from mail
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bubble_events_item ON public.bubble_events(item_id, created_at);

CREATE TABLE IF NOT EXISTS public.bubble_config (
  client_id uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  recipients text[] NOT NULL DEFAULT '{}',   -- phase 1: Sage only
  last_run_at timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['salesforce_tasks', 'salesforce_email_messages', 'bubble_items', 'bubble_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS client_read ON public.%I', t);
    EXECUTE format('CREATE POLICY client_read ON public.%I FOR SELECT TO authenticated USING (public.can_access_client(client_id))', t);
  END LOOP;
END $$;
ALTER TABLE public.bubble_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bubble_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bubble_config TO service_role;

COMMIT;
