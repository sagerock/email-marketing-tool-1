-- 088: form-lead status 'auto follow-up only' (2026-08-27)
-- Sage: book/white-paper leads got our AI follow-up email, so 'not contacted' was misleading.
-- No human touched them, but they heard from the company. Counted from ai_followup_drafts (status sent).

CREATE OR REPLACE FUNCTION engagement_overview(p_client_id uuid, p_days int DEFAULT 30, p_wait_days int DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
WITH since AS (SELECT (current_date - p_days)::date AS d),
arrivals AS (
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
-- ---- form leads ----
subs AS (SELECT * FROM form_submissions(p_client_id, (SELECT d FROM since))),
form_counts AS (
  SELECT coalesce(f.label, s.code) AS form, count(*) AS n, count(DISTINCT s.contact_id) AS people
    FROM subs s LEFT JOIN engagement_form_sources f ON f.client_id = p_client_id AND f.code = s.code
   GROUP BY 1 ORDER BY 2 DESC
),
lead_base AS (
  SELECT s.contact_id,
         max(s.submitted_on) AS last_form_on,
         min(s.submitted_on) AS first_form_on,
         count(*) AS forms_in_window,
         (array_agg(coalesce(f.label, s.code) ORDER BY s.submitted_on DESC))[1] AS last_form,
         string_agg(DISTINCT coalesce(f.label, s.code), ', ') AS forms
    FROM subs s LEFT JOIN engagement_form_sources f ON f.client_id = p_client_id AND f.code = s.code
   GROUP BY s.contact_id
),
form_leads_all AS (
  SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.industry, c.state, c.country,
         c.record_type, c.salesforce_lead_status, c.salesforce_created_date,
         b.last_form, b.forms, b.last_form_on, b.first_form_on, b.forms_in_window,
         c.salesforce_last_activity_date, c.last_engaged_at, c.last_replied_at,
         c.total_opens, c.total_clicks, c.engagement_score,
         (SELECT count(*) FROM analytics_events e JOIN campaigns cp ON cp.id = e.campaign_id
           WHERE e.email = c.email AND cp.client_id = p_client_id AND e.event_type = 'open'
             AND e.timestamp >= b.last_form_on) AS opens_since_form,
         (SELECT count(*) FROM analytics_events e JOIN campaigns cp ON cp.id = e.campaign_id
           WHERE e.email = c.email AND cp.client_id = p_client_id AND e.event_type = 'click'
             AND e.timestamp >= b.last_form_on) AS clicks_since_form,
         (SELECT max(o.created_at) FROM email_conversations o
           WHERE o.contact_id = c.id AND o.direction = 'outbound' AND o.created_at >= b.last_form_on) AS our_reply_at,
         (c.salesforce_last_activity_date IS NOT NULL AND c.salesforce_last_activity_date >= b.last_form_on) AS sf_touched,
         (SELECT count(*) FROM ai_followup_drafts d
           WHERE d.contact_id = c.id AND d.client_id = p_client_id AND d.status = 'sent'
             AND d.sent_at >= b.last_form_on) AS auto_followups,
         (SELECT max(d.sent_at) FROM ai_followup_drafts d
           WHERE d.contact_id = c.id AND d.client_id = p_client_id AND d.status = 'sent'
             AND d.sent_at >= b.last_form_on) AS last_auto_followup_at,
         (SELECT count(*) FROM salesforce_opportunities o
           WHERE o.client_id = p_client_id AND o.is_closed = false
             AND (o.sf_contact_id = c.salesforce_id OR o.contact_email = c.email)) AS open_opps
    FROM lead_base b JOIN contacts c ON c.id = b.contact_id
   WHERE c.unsubscribed = false
),
form_leads_status AS (
  SELECT *,
         CASE
           WHEN last_replied_at IS NOT NULL AND last_replied_at::date >= last_form_on
                AND NOT (salesforce_last_activity_date IS NOT NULL AND salesforce_last_activity_date >= last_replied_at::date)
                AND (our_reply_at IS NULL OR our_reply_at < last_replied_at)
             THEN 'replied, no response'
           WHEN sf_touched OR our_reply_at IS NOT NULL THEN 'contacted'
           WHEN last_form_on > current_date - p_wait_days THEN 'new'
           WHEN auto_followups > 0 THEN 'auto follow-up only'
           ELSE 'not contacted'
         END AS status
    FROM form_leads_all
),
form_leads AS (
  SELECT * FROM form_leads_status
   ORDER BY (status = 'replied, no response') DESC, (status = 'not contacted') DESC, (status = 'auto follow-up only') DESC,
            (clicks_since_form + opens_since_form) DESC, last_form_on ASC
   LIMIT 300
),
-- ---- replies ----
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
-- ---- pipeline ----
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
stalled AS (SELECT * FROM stalled_all ORDER BY last_touch DESC LIMIT 100),
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
         (SELECT count(*) FROM form_leads_status) AS form_leads,
         (SELECT count(*) FROM form_leads_status WHERE status = 'not contacted') AS form_leads_uncontacted,
         (SELECT count(*) FROM form_leads_status WHERE status = 'replied, no response') AS form_leads_replied,
         (SELECT count(*) FROM form_leads_status WHERE status = 'contacted') AS form_leads_contacted,
         (SELECT count(*) FROM form_leads_status WHERE status = 'auto follow-up only') AS form_leads_auto,
         (SELECT count(*) FROM form_leads_status WHERE status = 'new') AS form_leads_new,
         (SELECT count(*) FROM subs) AS form_submissions,
         (SELECT count(*) FROM email_conversations WHERE client_id = p_client_id AND direction = 'inbound'
             AND created_at >= now() - make_interval(days => p_days)) AS replies,
         (SELECT count(*) FROM contacts WHERE client_id = p_client_id
             AND last_engaged_at >= now() - make_interval(days => p_days)) AS engaged,
         (SELECT count(*) FROM salesforce_opportunities WHERE client_id = p_client_id AND is_closed = false) AS open_opps,
         (SELECT count(*) FROM stalled_all) AS stalled,
         (SELECT max(synced_at) FROM salesforce_opportunities WHERE client_id = p_client_id) AS opps_synced_at,
         (SELECT last_salesforce_sync FROM clients WHERE id = p_client_id) AS contacts_synced_at
)
SELECT jsonb_build_object(
  'days',       p_days,
  'wait_days',  p_wait_days,
  'totals',     (SELECT to_jsonb(t) FROM totals t),
  'sources',    coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM source_counts s), '[]'::jsonb),
  'forms',      coalesce((SELECT jsonb_agg(to_jsonb(f)) FROM form_counts f), '[]'::jsonb),
  'form_leads', coalesce((SELECT jsonb_agg(to_jsonb(l)) FROM form_leads l), '[]'::jsonb),
  'arrivals',   coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.salesforce_created_date DESC)
                            FROM (SELECT * FROM arrivals ORDER BY salesforce_created_date DESC LIMIT 200) a), '[]'::jsonb),
  'replies',    coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM replies r), '[]'::jsonb),
  'pipeline',   coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM pipeline p), '[]'::jsonb),
  'stalled',    coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.last_touch DESC) FROM stalled s), '[]'::jsonb),
  'engaged',    coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.engagement_score DESC) FROM engaged e), '[]'::jsonb)
);
$$;
