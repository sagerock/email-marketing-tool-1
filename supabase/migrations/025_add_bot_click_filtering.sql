-- Bot click filtering for analytics
-- Security scanners (Barracuda, Proofpoint, Mimecast) pre-scan all links in emails,
-- causing inflated click counts.
--
-- Bot detection: 3+ unique URLs clicked within 10 seconds = bot
--
-- This migration provides simplified functions after one-time bot cleanup.
-- Bot filtering is now done at ingestion time in the webhook handler.

-- Simplified get_campaign_unique_clicks (no runtime bot filtering needed)
CREATE OR REPLACE FUNCTION get_campaign_unique_clicks(p_campaign_id UUID)
RETURNS TABLE (engaged_clicks BIGINT, unsub_clicks BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(DISTINCT CASE WHEN url NOT LIKE '%/unsubscribe%' THEN email END)::BIGINT,
    COUNT(DISTINCT CASE WHEN url LIKE '%/unsubscribe%' THEN email END)::BIGINT
  FROM analytics_events
  WHERE campaign_id = p_campaign_id AND event_type = 'click';
$$;

-- Simplified get_campaign_link_stats (no runtime bot filtering needed)
CREATE OR REPLACE FUNCTION get_campaign_link_stats(p_campaign_id UUID)
RETURNS TABLE (url TEXT, total_clicks BIGINT, unique_clicks BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT ae.url, COUNT(*)::BIGINT, COUNT(DISTINCT ae.email)::BIGINT
  FROM analytics_events ae
  WHERE ae.campaign_id = p_campaign_id AND ae.event_type = 'click' AND ae.url IS NOT NULL
  GROUP BY ae.url ORDER BY COUNT(*) DESC LIMIT 50;
$$;
