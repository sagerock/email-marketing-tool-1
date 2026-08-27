-- 084: engagement_overview — true totals (not capped by LIMIT), waiting split by reason,
-- waiting list ranked by engagement score within reason. Applied 2026-08-27.

CREATE OR REPLACE FUNCTION engagement_overview(p_client_id uuid, p_days int DEFAULT 30, p_wait_days int DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
WITH arrivals AS (
  SELECT id, email, first_name, last_name, company, source_code, record_type, industry, state, country,
         salesforce_created_date, salesforce_last_activity_date, salesforce_lead_status,
         last_engaged_at, last_replied_at, engagement_score, total_opens, total_clicks
    FROM contacts
   WHERE client_id = p_client_id
     AND salesforce_created_date >= now() - make_interval(days => p_days)
),
source_counts AS (
  SELECT coalesce(source_code, '(none)') AS source, count(*) AS n
    FROM arrivals GROUP BY 1 ORDER BY 2 DESC
),
replies AS (
  SELECT ec.id, ec.created_at, ec.subject, left(ec.body, 400) AS body,
         c.id AS contact_id, coalesce(c.email, '') AS email, c.first_name, c.last_name, c.company,
         c.source_code, c.salesforce_last_activity_date,
         (SELECT max(o.created_at) FROM email_conversations o
           WHERE o.contact_id = c.id AND o.direction = 'outbound' AND o.created_at > ec.created_at) AS answered_at
    FROM email_conversations ec
    LEFT JOIN contacts c ON c.id = ec.contact_id
   WHERE ec.client_id = p_client_id AND ec.direction = 'inbound'
     AND ec.created_at >= now() - make_interval(days => p_days)
   ORDER BY ec.created_at DESC
   LIMIT 100
),
waiting_raw AS (
  SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.source_code,
         c.last_replied_at, c.last_engaged_at, c.salesforce_last_activity_date, c.total_clicks, c.engagement_score,
         greatest(c.last_replied_at, c.last_engaged_at) AS last_inbound,
         CASE
           WHEN c.last_replied_at IS NOT NULL
                AND (c.salesforce_last_activity_date IS NULL OR c.salesforce_last_activity_date < c.last_replied_at::date)
             THEN 'replied, no response'
           WHEN c.total_clicks > 0 AND c.last_engaged_at IS NOT NULL
                AND (c.salesforce_last_activity_date IS NULL OR c.salesforce_last_activity_date < c.last_engaged_at::date)
             THEN 'clicked, never contacted'
         END AS reason,
         (SELECT max(o.created_at) FROM email_conversations o
           WHERE o.contact_id = c.id AND o.direction = 'outbound') AS last_our_reply
    FROM contacts c
   WHERE c.client_id = p_client_id
     AND c.unsubscribed = false
     AND greatest(c.last_replied_at, c.last_engaged_at) >= now() - make_interval(days => p_days)
     AND greatest(c.last_replied_at, c.last_engaged_at) <  now() - make_interval(days => p_wait_days)
),
waiting_all AS (
  SELECT * FROM waiting_raw
   WHERE reason IS NOT NULL
     AND (last_our_reply IS NULL OR last_our_reply < last_inbound)
),
waiting AS (
  SELECT * FROM waiting_all
   ORDER BY (reason = 'replied, no response') DESC, engagement_score DESC, last_inbound ASC
   LIMIT 200
),
pipeline AS (
  SELECT stage, count(*) AS n
    FROM salesforce_opportunities
   WHERE client_id = p_client_id AND is_closed = false
   GROUP BY 1 ORDER BY 2 DESC
),
stalled_all AS (
  SELECT o.salesforce_id, o.name, o.stage, o.owner_name, o.contact_email, o.sf_created_date,
         o.last_stage_change, o.last_activity_date, o.sample_shipped_at,
         coalesce(o.last_activity_date, o.last_stage_change::date, o.sf_created_date::date) AS last_touch
    FROM salesforce_opportunities o
   WHERE o.client_id = p_client_id AND o.is_closed = false
     AND coalesce(o.last_activity_date, o.last_stage_change::date, o.sf_created_date::date) < current_date - 14
),
stalled AS (
  SELECT * FROM stalled_all ORDER BY last_touch ASC LIMIT 100
),
engaged AS (
  SELECT id, email, first_name, last_name, company, source_code, engagement_score, total_opens, total_clicks,
         last_engaged_at, last_replied_at, salesforce_last_activity_date
    FROM contacts
   WHERE client_id = p_client_id
     AND last_engaged_at >= now() - make_interval(days => p_days)
   ORDER BY engagement_score DESC, last_engaged_at DESC
   LIMIT 100
),
totals AS (
  SELECT (SELECT count(*) FROM arrivals) AS arrivals,
         (SELECT count(*) FROM email_conversations WHERE client_id = p_client_id AND direction = 'inbound'
             AND created_at >= now() - make_interval(days => p_days)) AS replies,
         (SELECT count(*) FROM waiting_all) AS waiting,
         (SELECT count(*) FROM waiting_all WHERE reason = 'replied, no response') AS waiting_replied,
         (SELECT count(*) FROM waiting_all WHERE reason = 'clicked, never contacted') AS waiting_clicked,
         (SELECT count(*) FROM contacts WHERE client_id = p_client_id
             AND last_engaged_at >= now() - make_interval(days => p_days)) AS engaged,
         (SELECT count(*) FROM salesforce_opportunities WHERE client_id = p_client_id AND is_closed = false) AS open_opps,
         (SELECT count(*) FROM stalled_all) AS stalled,
         (SELECT max(synced_at) FROM salesforce_opportunities WHERE client_id = p_client_id) AS opps_synced_at,
         (SELECT last_salesforce_sync FROM clients WHERE id = p_client_id) AS contacts_synced_at
)
SELECT jsonb_build_object(
  'days',     p_days,
  'totals',   (SELECT to_jsonb(t) FROM totals t),
  'sources',  coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM source_counts s), '[]'::jsonb),
  'arrivals', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.salesforce_created_date DESC)
                          FROM (SELECT * FROM arrivals ORDER BY salesforce_created_date DESC LIMIT 200) a), '[]'::jsonb),
  'replies',  coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM replies r), '[]'::jsonb),
  'waiting',  coalesce((SELECT jsonb_agg(to_jsonb(w)) FROM waiting w), '[]'::jsonb),
  'pipeline', coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM pipeline p), '[]'::jsonb),
  'stalled',  coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.last_touch ASC) FROM stalled s), '[]'::jsonb),
  'engaged',  coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.engagement_score DESC) FROM engaged e), '[]'::jsonb)
);
$$;
