-- Make AI follow-up generation safe across overlapping cron ticks and replicas.
-- Historical duplicate rows are preserved; new rows receive an idempotency key.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.ai_followup_drafts
  ADD COLUMN IF NOT EXISTS generation_key text;

ALTER TABLE public.ai_followup_drafts
  DROP CONSTRAINT IF EXISTS ai_followup_drafts_status_check;
ALTER TABLE public.ai_followup_drafts
  ADD CONSTRAINT ai_followup_drafts_status_check
  CHECK (status::text = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'sending'::text,
    'rejected'::text,
    'sent'::text,
    'failed'::text
  ]));

-- Backfill only unambiguous historical rows. Duplicate historical sends retain
-- NULL keys so the audit trail remains intact without blocking this index.
WITH unambiguous AS (
  SELECT followup_contact_id, step_number
  FROM public.ai_followup_drafts
  WHERE followup_contact_id IS NOT NULL
    AND status IN ('pending', 'approved', 'sending', 'sent')
  GROUP BY followup_contact_id, step_number
  HAVING count(*) = 1
)
UPDATE public.ai_followup_drafts AS d
SET generation_key = d.followup_contact_id::text || ':' || d.step_number::text
FROM unambiguous AS u
WHERE d.followup_contact_id = u.followup_contact_id
  AND d.step_number = u.step_number
  AND d.status IN ('pending', 'approved', 'sending', 'sent')
  AND d.generation_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_followup_drafts_generation_key
  ON public.ai_followup_drafts (generation_key)
  WHERE generation_key IS NOT NULL
    AND status IN ('pending', 'approved', 'sending', 'sent');

-- Claim due rows in the database. FOR UPDATE SKIP LOCKED prevents two scheduler
-- workers from selecting the same contact, while the lease prevents a second
-- claim after this short transaction commits but before generation completes.
-- Pending/sending/sent drafts for the next step are excluded before LIMIT so
-- old review-queue rows cannot starve every contact behind them.
CREATE OR REPLACE FUNCTION public.claim_due_ai_followups(
  p_limit integer DEFAULT 2,
  p_lease_seconds integer DEFAULT 900
)
RETURNS TABLE (
  id uuid,
  contact_id uuid,
  config_id uuid,
  due_at timestamptz,
  lease_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 2), 25));
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT fc.id, fc.contact_id, fc.config_id, fc.next_followup_at AS due_at
    FROM public.ai_followup_contacts AS fc
    JOIN public.ai_followup_config AS cfg ON cfg.id = fc.config_id
    JOIN public.contacts AS contact ON contact.id = fc.contact_id
    WHERE fc.status = 'in_progress'
      AND fc.current_step < cfg.max_followups
      AND fc.next_followup_at IS NOT NULL
      AND fc.next_followup_at <= statement_timestamp()
      AND cfg.enabled = true
      AND contact.unsubscribed = false
      AND NOT EXISTS (
        SELECT 1
        FROM public.ai_followup_drafts AS d
        WHERE d.followup_contact_id = fc.id
          AND d.step_number = fc.current_step + 1
          AND d.status IN ('pending', 'approved', 'sending', 'sent')
      )
    ORDER BY fc.next_followup_at, fc.id
    FOR UPDATE OF fc SKIP LOCKED
    LIMIT v_limit
  ), claimed AS (
    UPDATE public.ai_followup_contacts AS fc
    SET next_followup_at = statement_timestamp() + make_interval(secs => v_lease_seconds)
    FROM due
    WHERE fc.id = due.id
    RETURNING fc.id, fc.contact_id, fc.config_id, fc.next_followup_at AS lease_until
  )
  SELECT claimed.id, claimed.contact_id, claimed.config_id, due.due_at, claimed.lease_until
  FROM claimed
  JOIN due ON due.id = claimed.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_due_ai_followups(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_ai_followups(integer, integer)
  TO service_role;

COMMIT;
