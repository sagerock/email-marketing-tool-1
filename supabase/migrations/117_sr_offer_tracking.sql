-- 117_sr_offer_tracking.sql
--
-- Pricing test for the Waldorf cold emails (Sage, 2026-10-19). Every email leads
-- with the free five-item problem list; the price only comes up when a school
-- replies, and it changes by the week the school was first emailed:
--   founding  week of Oct 26  $1,250 founding-school audit, first 5 schools
--   waived    week of Nov 2   audit waived with 6 months at $250/mo
--   credited  week of Nov 9   $2,500 audit credited against the subscription
-- The weeks live in sagerock/outreach/waldorf-outbound/pricing-test.json.
--
-- sr_orgs.offer_variant is frozen the first time the tracker (outreach/nudge,
-- `nudge.py track`) sees the org's first-ever prospect email inside a test week.
-- sr_offer_events records what happened after: problem list sent and calls
-- booked are filled automatically (Gmail, Cal.com); the rest by hand or by Jax.
-- Replies are not stored here; they come from sr_outreach.

ALTER TABLE public.sr_orgs
  ADD COLUMN IF NOT EXISTS offer_variant    text,
  ADD COLUMN IF NOT EXISTS offer_started_at timestamptz;

CREATE TABLE IF NOT EXISTS public.sr_offer_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.sr_orgs(id) ON DELETE CASCADE,
  kind        text NOT NULL
                CHECK (kind IN ('problem_list_sent','call_booked','audit_sold',
                                'subscribed','declined')),
  at          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL CHECK (source IN ('gmail','calcom','manual')),
  source_ref  text NOT NULL DEFAULT '',   -- Gmail message id / Cal.com booking uid; '' for manual
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, source_ref)
);

CREATE INDEX IF NOT EXISTS sr_offer_events_org_idx ON public.sr_offer_events (org_id);

ALTER TABLE public.sr_offer_events ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text := 'sr_offer_events';
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS "Internal staff can select %1$s" ON public.%1$I;', t);
  EXECUTE format('DROP POLICY IF EXISTS "Internal staff can insert %1$s" ON public.%1$I;', t);
  EXECUTE format('DROP POLICY IF EXISTS "Internal staff can update %1$s" ON public.%1$I;', t);
  EXECUTE format('DROP POLICY IF EXISTS "Internal staff can delete %1$s" ON public.%1$I;', t);
  EXECUTE format('CREATE POLICY "Internal staff can select %1$s" ON public.%1$I FOR SELECT USING (public.is_internal_staff());', t);
  EXECUTE format('CREATE POLICY "Internal staff can insert %1$s" ON public.%1$I FOR INSERT WITH CHECK (public.is_internal_staff());', t);
  EXECUTE format('CREATE POLICY "Internal staff can update %1$s" ON public.%1$I FOR UPDATE USING (public.is_internal_staff());', t);
  EXECUTE format('CREATE POLICY "Internal staff can delete %1$s" ON public.%1$I FOR DELETE USING (public.is_internal_staff());', t);
END $$;
