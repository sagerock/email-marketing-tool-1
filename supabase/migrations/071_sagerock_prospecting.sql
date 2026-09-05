-- 071_sagerock_prospecting.sql
--
-- SageRock's own outbound pipeline: organizations we might sell to, the people
-- there, what we found broken on their site, and what we sent them.
--
-- WHY THESE ARE SEPARATE TABLES AND NOT `contacts` / `prospects`:
--
--   `contacts`   is client constituent data (CfA donors, SGWS families, Alconox
--                customers). Different consent basis, different retention rules,
--                different people allowed to read it. SageRock's sales list does
--                not belong in there even under a separate client_id.
--
--   `prospects`, `families`, `tours`, `pipeline_stages` are SGWS's live
--                admissions pipeline. Those rows are prospective *families*, and
--                Linden's Monday digest reads off them. Reusing them for sales
--                leads would put our pipeline inside a client's production system.
--
-- The organizing idea: the FINDING is the asset, not the contact. A row with a
-- name is a name. A row with "their giving page 404s and 41 people hit it last
-- quarter" is an email that writes itself. Hence sr_findings is first-class and
-- sr_outreach records which finding carried which send.

-- ---------------------------------------------------------------------------
-- Access: internal staff only.
-- ---------------------------------------------------------------------------
-- Deliberately NOT can_access_client(). That helper also admits client_admins,
-- and a CfA or SGWS client_admin must never see who SageRock is prospecting.
-- This is super_admin + admin only.

CREATE OR REPLACE FUNCTION public.is_internal_staff()
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = auth.uid()
      AND role IN ('super_admin', 'admin')
  );
$$;

COMMENT ON FUNCTION public.is_internal_staff() IS
  'True for super_admin and admin only. Used by the sr_* prospecting tables so '
  'client_admins cannot read SageRock''s own sales pipeline.';

CREATE OR REPLACE FUNCTION public.sr_set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- sr_orgs — the organizations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sr_orgs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name            text NOT NULL,
  -- Bare hostname, lowercased, no scheme and no leading www. This is the
  -- dedupe key: one row per organization website.
  domain          text UNIQUE,

  org_type        text DEFAULT 'school'
                    CHECK (org_type IN ('school','nonprofit','business','other')),
  affiliation     text,          -- 'AWSNA', 'NAIS', ... how they cluster
  city            text,
  state_region    text,
  country         text DEFAULT 'US',

  -- Filled by outreach/site-scan/scan.py. `platform` is the CMS, denormalised
  -- out of `tech` because it gets filtered on constantly.
  platform            text,
  platform_checked_at timestamptz,

  -- Full stack fingerprint: {"cms":[...], "analytics":[...], "ads":[...],
  -- "email":[...], "sis_admissions":[...], "donations":[...]}. Each key answers
  -- a sales question -- whether they measure anything, whether there's ad spend
  -- to account for, whether the FACTS/Ravenna connector applies, who owns
  -- giving internally.
  tech                jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Where this row came from, so a bad import can be undone in one statement.
  source          text NOT NULL DEFAULT 'manual',

  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','researching','ready','contacted',
                                      'conversation','client','dead','do_not_contact')),
  -- Existing or former client? Points at the tenant so we never cold-pitch
  -- somebody we already work with. Cornerstone is exactly this case.
  client_id       uuid REFERENCES public.clients(id) ON DELETE SET NULL,

  do_not_contact  boolean NOT NULL DEFAULT false,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sr_orgs_status_idx      ON public.sr_orgs (status);
CREATE INDEX IF NOT EXISTS sr_orgs_affiliation_idx ON public.sr_orgs (affiliation);
CREATE INDEX IF NOT EXISTS sr_orgs_platform_idx    ON public.sr_orgs (platform);
CREATE INDEX IF NOT EXISTS sr_orgs_tech_idx        ON public.sr_orgs USING gin (tech);

CREATE OR REPLACE TRIGGER sr_orgs_updated_at BEFORE UPDATE ON public.sr_orgs
  FOR EACH ROW EXECUTE FUNCTION public.sr_set_updated_at();

-- ---------------------------------------------------------------------------
-- sr_people — who to write to
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sr_people (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.sr_orgs(id) ON DELETE CASCADE,

  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  title           text,
  -- Which finding should reach them. A broken donate page goes to advancement;
  -- a broken redirect goes to whoever owns the website.
  role_category   text CHECK (role_category IN ('head','marketing','advancement',
                                                'admissions','technology','finance','other')),

  source          text,          -- 'website', 'email signature', 'linkedin'
  verified_at     timestamptz,   -- last time we confirmed this address is real
  do_not_contact  boolean NOT NULL DEFAULT false,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sr_people_email_per_org UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS sr_people_org_idx   ON public.sr_people (org_id);
CREATE INDEX IF NOT EXISTS sr_people_email_idx ON public.sr_people (lower(email));
CREATE INDEX IF NOT EXISTS sr_people_role_idx  ON public.sr_people (role_category);

CREATE OR REPLACE TRIGGER sr_people_updated_at BEFORE UPDATE ON public.sr_people
  FOR EACH ROW EXECUTE FUNCTION public.sr_set_updated_at();

-- ---------------------------------------------------------------------------
-- sr_findings — the actual asset
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sr_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.sr_orgs(id) ON DELETE CASCADE,

  kind            text NOT NULL
                    CHECK (kind IN ('broken_donate_link','broken_apply_link',
                                    'broken_link','missing_analytics',
                                    'broken_analytics','no_ssl','mixed_content',
                                    'slow_page','missing_redirect','other')),
  -- One plain sentence, written the way it would appear in an email.
  -- e.g. "Giving page 404s; 41 hits in 90 days"
  summary         text NOT NULL,
  url             text,          -- the specific affected page
  severity        text NOT NULL DEFAULT 'medium'
                    CHECK (severity IN ('high','medium','low')),

  -- Whatever proves it: status codes, hit counts, redirect chains, timings.
  -- Kept loose on purpose; each detector writes its own shape.
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,

  detector        text,          -- which script found it, for re-running
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when a later scan finds it fixed. Also the honest way to close the loop
  -- after we fix something for them.
  resolved_at     timestamptz,

  -- A crawler result is a candidate. Nothing goes in an email until a human has
  -- looked at it. The Cornerstone donate link would have failed a naive check
  -- twice: the giving page renders its form in an iframe, and /faqs looks like
  -- a FAQ page but 301s to the About page.
  verified_at     timestamptz,
  verified_by     text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sr_findings_org_idx  ON public.sr_findings (org_id);
CREATE INDEX IF NOT EXISTS sr_findings_kind_idx ON public.sr_findings (kind);
CREATE INDEX IF NOT EXISTS sr_findings_open_idx ON public.sr_findings (org_id, severity)
  WHERE resolved_at IS NULL;
-- One live finding per kind+url per org; re-scans update last_seen_at instead
-- of piling up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS sr_findings_dedupe_idx
  ON public.sr_findings (org_id, kind, coalesce(url, ''));

CREATE OR REPLACE TRIGGER sr_findings_updated_at BEFORE UPDATE ON public.sr_findings
  FOR EACH ROW EXECUTE FUNCTION public.sr_set_updated_at();

-- ---------------------------------------------------------------------------
-- sr_outreach — what we sent and what came back
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sr_outreach (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.sr_orgs(id) ON DELETE CASCADE,
  person_id       uuid REFERENCES public.sr_people(id) ON DELETE SET NULL,
  -- The finding that carried this send. Null means we reached out without one,
  -- which is worth being able to measure separately.
  finding_id      uuid REFERENCES public.sr_findings(id) ON DELETE SET NULL,

  channel         text NOT NULL DEFAULT 'email'
                    CHECK (channel IN ('email','linkedin','phone','in_person','other')),
  subject         text,
  body_ref        text,          -- path in the repo, or a Gmail draft id

  -- Joins to the existing gmail_threads / gmail_messages sync, so replies can
  -- be picked up without a second integration.
  gmail_thread_id text,

  sent_at         timestamptz,
  replied_at      timestamptz,
  outcome         text NOT NULL DEFAULT 'sent'
                    CHECK (outcome IN ('draft','sent','bounced','no_reply','replied',
                                       'meeting','won','lost','unsubscribed')),
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sr_outreach_org_idx     ON public.sr_outreach (org_id);
CREATE INDEX IF NOT EXISTS sr_outreach_outcome_idx ON public.sr_outreach (outcome);
CREATE INDEX IF NOT EXISTS sr_outreach_thread_idx  ON public.sr_outreach (gmail_thread_id);

CREATE OR REPLACE TRIGGER sr_outreach_updated_at BEFORE UPDATE ON public.sr_outreach
  FOR EACH ROW EXECUTE FUNCTION public.sr_set_updated_at();

-- The sr_worklist view is defined in 072, not here. It depends on columns
-- that 072 adds (snoozed_until, opted_out_at, last_message_at), so there is
-- no correct version of it at this point in the history.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.sr_orgs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_people   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_outreach ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sr_orgs','sr_people','sr_findings','sr_outreach'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can select %1$s" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can insert %1$s" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can update %1$s" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can delete %1$s" ON public.%1$I;', t);
    EXECUTE format(
      'CREATE POLICY "Internal staff can select %1$s" ON public.%1$I
         FOR SELECT USING (public.is_internal_staff());', t);
    EXECUTE format(
      'CREATE POLICY "Internal staff can insert %1$s" ON public.%1$I
         FOR INSERT WITH CHECK (public.is_internal_staff());', t);
    EXECUTE format(
      'CREATE POLICY "Internal staff can update %1$s" ON public.%1$I
         FOR UPDATE USING (public.is_internal_staff());', t);
    EXECUTE format(
      'CREATE POLICY "Internal staff can delete %1$s" ON public.%1$I
         FOR DELETE USING (public.is_internal_staff());', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.sr_orgs IS
  'SageRock outbound pipeline: organizations. Internal sales data, NOT client '
  'constituent data. See contacts/prospects for those.';
COMMENT ON TABLE public.sr_findings IS
  'What is broken or notable at a prospect org. The reason an email is worth '
  'sending. Nothing should go out on an unverified finding.';
