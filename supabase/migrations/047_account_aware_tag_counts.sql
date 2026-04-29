-- Update get_tag_counts to use the broader dealer signal:
-- a contact is a "dealer" if either Account.Type is Dealer OR Contact.Type__c is Dealer.
-- Customer excludes anyone at a Dealer Account.

DROP FUNCTION IF EXISTS get_tag_counts(uuid, text[]);

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
      OR (
        'customer' = ANY(p_audience_filter)
        AND record_type = 'contact'
        AND contact_type = 'Customer'
        AND (account_type IS NULL OR account_type <> 'Dealer')
      )
      OR (
        'dealer' = ANY(p_audience_filter)
        AND record_type = 'contact'
        AND (account_type = 'Dealer' OR contact_type = 'Dealer')
      )
    )
  GROUP BY t
  ORDER BY t
$$;

GRANT EXECUTE ON FUNCTION get_tag_counts(uuid, text[]) TO anon, authenticated;
