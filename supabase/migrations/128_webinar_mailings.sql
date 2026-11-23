-- Event mail to webinar registrants (reminders, recording + checklist), Jax item #4351.
-- One row per (registration, kind): the reservation that makes each email send at most once,
-- same pattern as webinar_registrations.confirmation_status. Additive only.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE public.webinar_mailings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES public.webinar_registrations(id),
  kind text NOT NULL CHECK (kind IN ('reminder-day','reminder-hour','followup')),
  status text NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending','sent','failed','uncertain','skipped')),
  provider_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registration_id, kind)
);
ALTER TABLE public.webinar_mailings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webinar_mailings FROM anon, authenticated;
GRANT ALL ON public.webinar_mailings TO service_role;

COMMIT;
