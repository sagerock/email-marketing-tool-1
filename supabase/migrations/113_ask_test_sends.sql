-- 113: Ask/Jax campaign test sends (2026-10-15).
--
-- One row per [TEST] copy Jax sends through POST /api/ask/campaign-test-sends
-- (api/ask-test-send.js): the audit trail, the retry guard and the daily caps.
-- Recipients are limited in code to each client's named approvers; this table
-- never drives a send on its own. Service role only.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.ask_test_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  request_key text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_key, recipient)
);

CREATE INDEX IF NOT EXISTS ask_test_sends_campaign_created
  ON public.ask_test_sends (campaign_id, created_at DESC);

ALTER TABLE public.ask_test_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ask_test_sends FROM anon, authenticated;

COMMIT;
