-- Function to append a tag to contacts' tags array only where not already present.
-- Used during Salesforce sync to add source code tags (LSC:/CSC: prefixed).

CREATE OR REPLACE FUNCTION append_tag_to_contacts(
  p_client_id UUID,
  p_tag_name TEXT,
  p_emails TEXT[]
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE contacts
  SET tags = CASE
    WHEN tags IS NULL THEN ARRAY[p_tag_name]
    ELSE array_append(tags, p_tag_name)
  END,
  updated_at = NOW()
  WHERE client_id = p_client_id
    AND email = ANY(p_emails)
    AND (tags IS NULL OR NOT (p_tag_name = ANY(tags)));

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
