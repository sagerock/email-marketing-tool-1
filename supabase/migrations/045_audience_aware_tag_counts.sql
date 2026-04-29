-- Add audience filter to get_tag_counts so the contacts page can show tag
-- counts scoped to the currently selected audience (Leads/Customers/Dealers).
-- p_audience_filter NULL or empty array = no filter (current behavior).

DROP FUNCTION IF EXISTS get_tag_counts(uuid);

CREATE OR REPLACE FUNCTION get_tag_counts(
  p_client_id uuid,
  p_audience_filter text[] DEFAULT NULL
)
RETURNS TABLE(tag_name text, cnt bigint)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT t::text, COUNT(*)::bigint
  FROM contacts, UNNEST(tags) AS t
  WHERE client_id = p_client_id
    AND (
      p_audience_filter IS NULL
      OR array_length(p_audience_filter, 1) IS NULL
      OR ('lead' = ANY(p_audience_filter) AND record_type = 'lead')
      OR ('customer' = ANY(p_audience_filter) AND record_type = 'contact' AND contact_type = 'Customer')
      OR ('dealer' = ANY(p_audience_filter) AND record_type = 'contact' AND contact_type = 'Dealer')
    )
  GROUP BY t
  ORDER BY t
$$;

GRANT EXECUTE ON FUNCTION get_tag_counts(uuid, text[]) TO anon, authenticated;
