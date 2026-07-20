-- 065: Fix get_campaign_link_stats so the heatmap header numbers make sense.
--
-- Problems with the old version (found 2026-07-20 via the Alconox Scoop campaign):
--   1. LIMIT 50 silently capped the result, so the UI's "Clicked: N" stat pinned
--      at 50 for any campaign with enough click activity.
--   2. Per-recipient unsubscribe URLs (each contains a unique token) counted as
--      distinct "links", padding the result with one-click rows and crowding out
--      real content links.
--   3. The same content link could appear multiple times (with and without UTM
--      params) depending on how the click reached SendGrid.
--
-- Fix: group by the URL stripped of its query string (matching the frontend's
-- normalizeUrl(), which compares on origin+pathname), exclude unsubscribe links,
-- and drop the LIMIT. "Clicked" in the heatmap header now equals the number of
-- real content links that received clicks.

CREATE OR REPLACE FUNCTION public.get_campaign_link_stats(p_campaign_id uuid)
 RETURNS TABLE(url text, total_clicks bigint, unique_clicks bigint)
 LANGUAGE sql
 STABLE
AS $function$
    SELECT split_part(ae.url, '?', 1) AS url,
           COUNT(*)::BIGINT AS total_clicks,
           COUNT(DISTINCT ae.email)::BIGINT AS unique_clicks
    FROM analytics_events ae
    WHERE ae.campaign_id = p_campaign_id
      AND ae.event_type = 'click'
      AND ae.url IS NOT NULL
      AND split_part(ae.url, '?', 1) NOT ILIKE '%/unsubscribe'
    GROUP BY 1
    ORDER BY 2 DESC;
  $function$;
