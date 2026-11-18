-- 126: fixed reporting functions for Alconox Analytics (alconox.sagerock.com), 2026-11-18.
-- The dashboard sent three fixed queries through the generic public.execute_sql(text), which runs
-- as the owner and bypasses RLS for every client on this project. These functions hold exactly
-- those three queries with the Alconox client id fixed inside, take no input, and return the same
-- jsonb array execute_sql returned (COALESCE(jsonb_agg(row_to_json(t)), '[]')), so the dashboard's
-- tab code is unchanged. Once the dashboard calls these, execute_sql can be dropped (migration 127).
--
-- SECURITY INVOKER on purpose: the only caller is the dashboard's service-role key, which already
-- has SELECT on contacts/campaigns/analytics_events and bypasses RLS. No owner rights needed.
-- Convention (migration 121): fixed search_path, no PUBLIC/anon/authenticated EXECUTE.
--
-- Change from the old query: alconox_analytics_email_campaigns() limits the event aggregation to
-- Alconox's qualifying campaigns before grouping. The old version aggregated every client's
-- analytics_events and then LEFT JOINed to Alconox campaigns. Aggregation is per campaign_id and
-- the new filter depends only on campaign_id, using the same conditions as the outer WHERE, so
-- every row the outer query keeps gets the same event_summary row as before. Rows for other
-- campaigns, and the NULL campaign_id group, were never joined anyway.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- Samples tab, "by source": sample-request leads, all time, grouped into readable categories.
CREATE OR REPLACE FUNCTION public.alconox_analytics_sample_sources()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    WITH source_groups AS (
      SELECT
        CASE
          WHEN source_code = 'Sample Request'              THEN 'Direct Sample Request'
          WHEN source_code ILIKE 'WPT%'                   THEN 'White Paper / Technical'
          WHEN source_code ILIKE 'WSTR%'                  THEN 'Webinar Sample Test Report'
          WHEN source_code ILIKE 'STR%'
            OR source_code = 'Sample Test Report'          THEN 'Sample Test Report'
          WHEN source_code ILIKE '%Get Samples%'          THEN 'Website Get Samples'
          WHEN source_code ILIKE '%Facebook%'             THEN 'Facebook'
          WHEN source_code ILIKE '%LinkedIn%'             THEN 'LinkedIn'
          WHEN source_code ILIKE '%YUM%'                  THEN 'YUM Website'
          ELSE source_code
        END AS category
      FROM contacts
      WHERE client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
        AND record_type = 'lead'
        AND (
          source_code ILIKE '%sample%'
          OR source_code ILIKE '%get sample%'
          OR source_code ILIKE 'CGS%'
          OR source_code ILIKE 'FS%'
          OR source_code ILIKE 'WPT%'
          OR source_code ILIKE 'STR%'
          OR source_code ILIKE 'WSTR%'
        )
    )
    SELECT category AS src, COUNT(*) AS cnt
    FROM source_groups
    GROUP BY category
    ORDER BY cnt DESC
  ) t
$$;

-- Email tab: the 15 most recent sent Alconox campaigns with unique-person event counts.
CREATE OR REPLACE FUNCTION public.alconox_analytics_email_campaigns()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    WITH client_campaigns AS (
      SELECT id FROM campaigns
      WHERE client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
        AND status = 'sent'
        AND sent_at IS NOT NULL
        AND name NOT ILIKE '%test%'
    ),
    event_summary AS (
      SELECT
        campaign_id,
        COUNT(DISTINCT CASE WHEN event_type = 'delivered' THEN email END) AS delivered,
        COUNT(DISTINCT CASE WHEN event_type = 'open' THEN email END) AS unique_opens,
        COUNT(DISTINCT CASE WHEN event_type = 'click' AND url NOT LIKE '%/unsubscribe%' THEN email END) AS unique_clicks,
        COUNT(DISTINCT CASE WHEN event_type = 'bounce' THEN email END) AS bounces,
        COUNT(DISTINCT CASE WHEN event_type = 'unsubscribe' THEN email END) AS unsubscribes
      FROM analytics_events
      WHERE campaign_id IN (SELECT id FROM client_campaigns)
      GROUP BY campaign_id
    )
    SELECT
      c.id,
      c.name,
      c.subject,
      c.sent_at,
      COALESCE(c.sent_count, c.recipient_count, 0) AS sent,
      COALESCE(es.delivered, 0) AS delivered,
      COALESCE(es.unique_opens, 0) AS unique_opens,
      COALESCE(es.unique_clicks, 0) AS unique_clicks,
      COALESCE(es.bounces, 0) AS bounces,
      COALESCE(es.unsubscribes, 0) AS unsubscribes
    FROM campaigns c
    LEFT JOIN event_summary es ON es.campaign_id = c.id
    WHERE c.client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
      AND c.status = 'sent'
      AND c.sent_at IS NOT NULL
      AND c.name NOT ILIKE '%test%'
      AND COALESCE(es.delivered, 0) >= 10
    ORDER BY c.sent_at DESC
    LIMIT 15
  ) t
$$;

-- Email tab: unique openers and clickers per month over the last 12 months.
CREATE OR REPLACE FUNCTION public.alconox_analytics_email_trend()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    WITH client_campaigns AS (
      SELECT id FROM campaigns
      WHERE client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
        AND status = 'sent'
        AND name NOT ILIKE '%test%'
    )
    SELECT
      date_trunc('month', ae.timestamp) AS month,
      COUNT(DISTINCT CASE WHEN ae.event_type = 'open' THEN ae.email END) AS unique_opens,
      COUNT(DISTINCT CASE WHEN ae.event_type = 'click' AND ae.url NOT LIKE '%/unsubscribe%' THEN ae.email END) AS unique_clicks
    FROM analytics_events ae
    WHERE ae.campaign_id IN (SELECT id FROM client_campaigns)
      AND ae.timestamp >= NOW() - INTERVAL '12 months'
    GROUP BY date_trunc('month', ae.timestamp)
    ORDER BY month
  ) t
$$;

REVOKE ALL ON FUNCTION public.alconox_analytics_sample_sources() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alconox_analytics_email_campaigns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alconox_analytics_email_trend() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alconox_analytics_sample_sources() TO service_role;
GRANT EXECUTE ON FUNCTION public.alconox_analytics_email_campaigns() TO service_role;
GRANT EXECUTE ON FUNCTION public.alconox_analytics_email_trend() TO service_role;

COMMIT;
