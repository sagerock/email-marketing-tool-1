-- 093: Page exact dashboard candidates past PostgREST's 1,000-row response cap.

CREATE OR REPLACE FUNCTION engagement_reporting_candidates(
  p_client_id uuid,
  p_start timestamptz,
  p_end_exclusive timestamptz,
  p_limit integer,
  p_offset integer
) RETURNS TABLE(
  id uuid,
  salesforce_id text,
  record_type text,
  email text,
  total_count bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH form_people AS (
  SELECT DISTINCT fs.contact_id
    FROM form_submissions(
      p_client_id,
      (p_start AT TIME ZONE 'America/New_York')::date
    ) fs
   WHERE fs.submitted_on < (p_end_exclusive AT TIME ZONE 'America/New_York')::date + 1
),
eligible AS (
  SELECT c.id, c.salesforce_id, c.record_type, c.email
    FROM contacts c
   WHERE c.client_id = p_client_id
     AND c.salesforce_id IS NOT NULL
     AND (
       (c.salesforce_created_date >= p_start AND c.salesforce_created_date < p_end_exclusive)
       OR (c.last_engaged_at >= p_start AND c.last_engaged_at < p_end_exclusive)
       OR (c.last_replied_at >= p_start AND c.last_replied_at < p_end_exclusive)
       OR EXISTS (SELECT 1 FROM form_people fp WHERE fp.contact_id = c.id)
       OR EXISTS (
         SELECT 1 FROM email_conversations ec
          WHERE ec.client_id = p_client_id AND ec.contact_id = c.id
            AND ec.created_at >= p_start AND ec.created_at < p_end_exclusive
       )
     )
)
SELECT e.id, e.salesforce_id, e.record_type, e.email, count(*) OVER () AS total_count
  FROM eligible e
 ORDER BY e.id
 OFFSET greatest(p_offset, 0)
 LIMIT least(greatest(p_limit, 1), 1000);
$$;
REVOKE ALL ON FUNCTION engagement_reporting_candidates(uuid, timestamptz, timestamptz, integer, integer)
  FROM anon, authenticated;
