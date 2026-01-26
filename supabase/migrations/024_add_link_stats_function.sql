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

-- Function to get unique open count for a campaign
CREATE OR REPLACE FUNCTION get_campaign_unique_opens(p_campaign_id UUID)
RETURNS BIGINT AS $$
BEGIN
  RETURN (
    SELECT COUNT(DISTINCT email)
    FROM analytics_events
    WHERE campaign_id = p_campaign_id
      AND event_type = 'open'
  );
END;
$$ LANGUAGE plpgsql;

-- Function to get unique click counts for a campaign (engaged vs unsubscribe clicks)
CREATE OR REPLACE FUNCTION get_campaign_unique_clicks(p_campaign_id UUID)
RETURNS TABLE (
  engaged_clicks BIGINT,
  unsub_clicks BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(DISTINCT CASE WHEN url NOT LIKE '%/unsubscribe%' THEN email END)::BIGINT as engaged_clicks,
    COUNT(DISTINCT CASE WHEN url LIKE '%/unsubscribe%' THEN email END)::BIGINT as unsub_clicks
  FROM analytics_events
  WHERE campaign_id = p_campaign_id
    AND event_type = 'click';
END;
$$ LANGUAGE plpgsql;
