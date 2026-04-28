-- Fast tag count aggregation using unnest on the tags array column.
-- Called via supabase.rpc('get_tag_counts', { p_client_id: ... })
CREATE OR REPLACE FUNCTION get_tag_counts(p_client_id uuid)
RETURNS TABLE(tag_name text, cnt bigint)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT t::text, COUNT(*)::bigint
  FROM contacts, UNNEST(tags) AS t
  WHERE client_id = p_client_id
  GROUP BY t
  ORDER BY t
$$;

GRANT EXECUTE ON FUNCTION get_tag_counts(uuid) TO anon, authenticated;
