-- 072_prospecting_sync.sql
--
-- Reshapes the sr_* prospecting tables around one idea that came out of
-- actually looking at how Rocky works:
--
--   THE MAILBOX IS THE SOURCE OF TRUTH FOR ACTIVITY. THE DATABASE ONLY STORES
--   THE REASON TO WRITE AND THE DECISIONS A HUMAN MADE.
--
-- Rocky reads and sends from rocky@sagerock.com and her sends land in that
-- account's Sent folder (verified 2026-07-28). So "did we contact them, when,
-- did they answer" is observable. It should never be typed by hand.
--
-- This matters because the evidence in this very database says hand-maintained
-- CRM state does not survive: contact_notes has 17 rows and contact_tasks has 0.
-- Those tables were built and abandoned. Recording activity is a chore that pays
-- off later for somebody else, so it doesn't get done. Derived activity has no
-- such problem.
--
-- Run after 071. If 071 has not been applied yet, just apply both in order.

-- ---------------------------------------------------------------------------
-- sr_orgs: who owns it, and when to look again
-- ---------------------------------------------------------------------------

ALTER TABLE public.sr_orgs
  ADD COLUMN IF NOT EXISTS owner          text
    CHECK (owner IS NULL OR owner IN ('sage', 'rocky')),
  -- "Not now, ask me in September" is the single most common real outcome of
  -- outreach and there is nowhere to put it in most CRMs, so it becomes a
  -- forgotten lead instead of a scheduled one.
  ADD COLUMN IF NOT EXISTS snoozed_until  date,
  ADD COLUMN IF NOT EXISTS next_action    text;

CREATE INDEX IF NOT EXISTS sr_orgs_owner_idx   ON public.sr_orgs (owner);
CREATE INDEX IF NOT EXISTS sr_orgs_snoozed_idx ON public.sr_orgs (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sr_people: opt-out is a contractual obligation, not a preference
-- ---------------------------------------------------------------------------
-- AWSNA supplied the conference attendee list on written condition that we
-- provide an opt-out and be discerning about volume (Beverly Amico, 2026-07-07).
-- That makes suppression structural. It lives in the data model and is enforced
-- by the worklist view, not remembered by a person.

ALTER TABLE public.sr_people
  ADD COLUMN IF NOT EXISTS opted_out_at   timestamptz,
  ADD COLUMN IF NOT EXISTS opt_out_source text;

CREATE INDEX IF NOT EXISTS sr_people_optout_idx ON public.sr_people (opted_out_at)
  WHERE opted_out_at IS NOT NULL;

COMMENT ON COLUMN public.sr_people.opted_out_at IS
  'Set once, never cleared. An opt-out is permanent. Enforced by sr_worklist.';

-- ---------------------------------------------------------------------------
-- sr_outreach becomes a sync target, not a form
-- ---------------------------------------------------------------------------

ALTER TABLE public.sr_outreach
  ADD COLUMN IF NOT EXISTS direction        text
    CHECK (direction IS NULL OR direction IN ('outbound', 'inbound', 'mixed')),
  ADD COLUMN IF NOT EXISTS mailbox          text,     -- which account saw it
  ADD COLUMN IF NOT EXISTS participants     text[],
  ADD COLUMN IF NOT EXISTS last_message_at  timestamptz,
  ADD COLUMN IF NOT EXISTS message_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS matched_on       text,     -- 'person_email' | 'org_domain'
  ADD COLUMN IF NOT EXISTS synced_at        timestamptz;

-- One row per Gmail thread. The sync upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS sr_outreach_thread_uniq
  ON public.sr_outreach (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

COMMENT ON TABLE public.sr_outreach IS
  'Mostly DERIVED. gmail_thread_id, direction, participants, subject, sent_at, '
  'replied_at, last_message_at, message_count and mailbox are written by the '
  'sync job and should never be hand-edited -- an edit will be overwritten on '
  'the next run. The only human column is `outcome`, and only for terminal '
  'decisions (won, lost, unsubscribed). Everything else is observation.';

-- ---------------------------------------------------------------------------
-- sr_sync_state: one cursor per mailbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sr_sync_state (
  mailbox           text PRIMARY KEY,
  -- Gmail's historyId. Lets the job ask "what changed since last time" instead
  -- of re-reading 60 days of mail every quarter hour.
  last_history_id   text,
  last_run_at       timestamptz,
  last_ok_at        timestamptz,
  last_error        text,
  threads_seen      integer NOT NULL DEFAULT 0,
  threads_matched   integer NOT NULL DEFAULT 0
);

ALTER TABLE public.sr_sync_state ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sr_sync_state'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can select %1$s" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can insert %1$s" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can update %1$s" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Internal staff can delete %1$s" ON public.%1$I;', t);
    EXECUTE format('CREATE POLICY "Internal staff can select %1$s" ON public.%1$I
                      FOR SELECT USING (public.is_internal_staff());', t);
    EXECUTE format('CREATE POLICY "Internal staff can insert %1$s" ON public.%1$I
                      FOR INSERT WITH CHECK (public.is_internal_staff());', t);
    EXECUTE format('CREATE POLICY "Internal staff can update %1$s" ON public.%1$I
                      FOR UPDATE USING (public.is_internal_staff());', t);
    EXECUTE format('CREATE POLICY "Internal staff can delete %1$s" ON public.%1$I
                      FOR DELETE USING (public.is_internal_staff());', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- sr_worklist, stricter
-- ---------------------------------------------------------------------------
-- The rule for this view: every row is somebody worth writing to TODAY. If a
-- row cannot say why, it does not belong here. A list that includes people you
-- should not contact is a list nobody trusts, and a list nobody trusts is a
-- list nobody opens.

DROP VIEW IF EXISTS public.sr_worklist;

CREATE VIEW public.sr_worklist AS
SELECT
  o.id                AS org_id,
  o.name,
  o.domain,
  o.platform,
  o.tech,
  o.status,
  o.owner,
  o.next_action,

  f.id                AS finding_id,
  f.summary           AS why_now,
  f.kind              AS finding_kind,
  f.severity,
  f.url               AS finding_url,
  f.verified_at IS NOT NULL AS finding_verified,
  (SELECT count(*) FROM public.sr_findings fx
    WHERE fx.org_id = o.id AND fx.resolved_at IS NULL) AS open_findings,

  p.id                AS person_id,
  nullif(trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), '')
                      AS contact_name,
  p.email             AS contact_email,
  p.title             AS contact_title,

  x.last_message_at   AS last_touch_at,
  x.mailbox           AS last_touch_mailbox,
  x.gmail_thread_id,
  x.replied_at IS NOT NULL AS replied,
  CASE
    WHEN x.replied_at IS NOT NULL                       THEN 'replied'
    WHEN x.sent_at    IS NOT NULL                       THEN 'awaiting reply'
    ELSE 'never contacted'
  END                 AS touch_state

FROM public.sr_orgs o

-- Best unresolved finding: verified first, then severity, then oldest.
LEFT JOIN LATERAL (
  SELECT * FROM public.sr_findings f2
  WHERE f2.org_id = o.id AND f2.resolved_at IS NULL
  ORDER BY (f2.verified_at IS NOT NULL) DESC,
           CASE f2.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           f2.first_seen_at
  LIMIT 1
) f ON true

-- Best contactable person: a real title beats no title, verified beats not.
LEFT JOIN LATERAL (
  SELECT * FROM public.sr_people p2
  WHERE p2.org_id = o.id
    AND p2.email IS NOT NULL
    AND NOT p2.do_not_contact
    AND p2.opted_out_at IS NULL
  ORDER BY (p2.title IS NOT NULL) DESC,
           (p2.verified_at IS NOT NULL) DESC,
           p2.created_at
  LIMIT 1
) p ON true

-- Most recent thread with anyone at this org, from the sync.
LEFT JOIN LATERAL (
  SELECT * FROM public.sr_outreach x2
  WHERE x2.org_id = o.id
  ORDER BY x2.last_message_at DESC NULLS LAST
  LIMIT 1
) x ON true

WHERE NOT o.do_not_contact
  AND o.status NOT IN ('dead', 'do_not_contact', 'client')
  AND (o.snoozed_until IS NULL OR o.snoozed_until <= current_date)
  AND p.id IS NOT NULL          -- no contact, nothing to do
  AND f.id IS NOT NULL          -- no reason to write, nothing to say
  -- Don't resurface someone contacted in the last two weeks unless they
  -- answered, in which case they belong at the top rather than hidden.
  AND (x.last_message_at IS NULL
       OR x.replied_at IS NOT NULL
       OR x.last_message_at < now() - interval '14 days');

ALTER VIEW public.sr_worklist SET (security_invoker = true);

COMMENT ON VIEW public.sr_worklist IS
  'One row per organisation worth contacting today, with the reason attached. '
  'Excludes opted-out, snoozed, dead, existing clients, anyone with no contact '
  'or no finding, and anyone written to in the last 14 days who has not '
  'replied. Replies are NOT excluded -- they sort to the top.';
