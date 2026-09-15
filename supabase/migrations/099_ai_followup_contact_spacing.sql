-- A contact may be enrolled in more than one resource-specific agent. Keep
-- those valid series, but never select two AI emails for the same person in one
-- batch or within the normal three-day follow-up cadence.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

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
  WITH one_per_contact AS MATERIALIZED (
    SELECT DISTINCT ON (fc.contact_id)
      fc.id, fc.contact_id, fc.config_id, fc.next_followup_at AS due_at
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
      AND NOT EXISTS (
        SELECT 1
        FROM public.ai_followup_drafts AS recent
        WHERE recent.client_id = fc.client_id
          AND recent.contact_id = fc.contact_id
          AND recent.status = 'sent'
          AND recent.sent_at > statement_timestamp() - interval '72 hours'
      )
    ORDER BY fc.contact_id, fc.next_followup_at, fc.id
  ), due AS (
    SELECT fc.id, candidate.contact_id, candidate.config_id, candidate.due_at
    FROM one_per_contact AS candidate
    JOIN public.ai_followup_contacts AS fc ON fc.id = candidate.id
    ORDER BY candidate.due_at, fc.id
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
