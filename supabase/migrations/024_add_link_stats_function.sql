-- Function to get link click statistics for a campaign
-- This aggregates clicks by URL in the database, much faster than client-side

CREATE OR REPLACE FUNCTION get_campaign_link_stats(p_campaign_id UUID)
RETURNS TABLE (
  url TEXT,
  total_clicks BIGINT,
  unique_clicks BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ae.url,
    COUNT(*)::BIGINT as total_clicks,
    COUNT(DISTINCT ae.email)::BIGINT as unique_clicks
  FROM analytics_events ae
  WHERE ae.campaign_id = p_campaign_id
    AND ae.event_type = 'click'
    AND ae.url IS NOT NULL
  GROUP BY ae.url
  ORDER BY total_clicks DESC;
END;
$$ LANGUAGE plpgsql;
