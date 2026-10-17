-- 116_sr_opportunities.sql
--
-- Clients become prospects too (Sage, 2026-10-17). A client like AWSNA can be a
-- buyer for a new service (e.g. registration and payments admin, the work we do
-- for CfA). sr_orgs.status says what an organization IS to us; an opportunity
-- is one specific thing we might sell them, with its own stage. Any org can have
-- several: prospects, partners and clients alike.
--
-- The Gmail sync still skips client mail wholesale (CfA privacy). An opportunity
-- names the threads that belong to it in gmail_thread_ids, added by hand/Jax.

CREATE TABLE IF NOT EXISTS public.sr_opportunities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.sr_orgs(id) ON DELETE CASCADE,
  person_id        uuid REFERENCES public.sr_people(id) ON DELETE SET NULL,
  title            text NOT NULL,           -- "Registration & payments admin"
  kind             text NOT NULL DEFAULT 'new_business'
                     CHECK (kind IN ('new_business','expansion','referral')),
  stage            text NOT NULL DEFAULT 'idea'
                     CHECK (stage IN ('idea','pitched','conversation','proposal',
                                      'won','lost','parked')),
  owner            text CHECK (owner IS NULL OR owner IN ('sage','rocky')),
  next_action      text,
  next_check       date,
  gmail_thread_ids text[] NOT NULL DEFAULT '{}',
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sr_opportunities_org_idx   ON public.sr_opportunities (org_id);
CREATE INDEX IF NOT EXISTS sr_opportunities_check_idx ON public.sr_opportunities (next_check)
  WHERE stage NOT IN ('won','lost');

ALTER TABLE public.sr_opportunities ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text := 'sr_opportunities';
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
