-- 106: Ask Alconox answers count as follow-up on the Engagement page and digest.
--
-- The report only saw a lead's Salesforce LastActivityDate, so a form lead whose
-- Ask Alconox question was already answered could show as "no follow-up
-- recorded" (Maria Sereni, 2026-09-29). Cheyenne opened read access to
-- Ask_Alconox__c on 2026-10-01. api/salesforce-ask-questions.js mirrors recent
-- questions here on every engagement refresh; engagement_overview marks a form
-- lead "Ask Alconox answered" when the question from that form fill has Status
-- "Response Emailed". "Reviewed" and "New Question" stay visible as ask_status.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.salesforce_ask_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  salesforce_id text NOT NULL,
  name text,                       -- AA-3627
  status text,                     -- New Question | Reviewed | Response Emailed
  source_form text,                -- Ask Alconox Form, TechNotes Short Form, ...
  source_code text,
  email text,
  sf_lead_id text,                 -- Associated_Lead__c
  sf_contact_id text,              -- Associated_Contact__c
  sf_created_at timestamptz,
  sf_last_modified_at timestamptz,
  last_modified_by text,
  visible_in_last_snapshot boolean NOT NULL DEFAULT true,
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, salesforce_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_ask_questions_lead ON public.salesforce_ask_questions(client_id, sf_lead_id);
CREATE INDEX IF NOT EXISTS idx_sf_ask_questions_contact ON public.salesforce_ask_questions(client_id, sf_contact_id);
CREATE INDEX IF NOT EXISTS idx_sf_ask_questions_email ON public.salesforce_ask_questions(client_id, lower(email));

ALTER TABLE public.salesforce_ask_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salesforce_ask_questions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.salesforce_ask_questions TO authenticated;
GRANT ALL ON public.salesforce_ask_questions TO service_role;
DROP POLICY IF EXISTS client_read ON public.salesforce_ask_questions;
CREATE POLICY client_read ON public.salesforce_ask_questions
  FOR SELECT TO authenticated USING (public.can_access_client(client_id));

CREATE OR REPLACE FUNCTION engagement_overview(p_client_id uuid, p_days int DEFAULT 30, p_wait_days int DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH since AS (SELECT (current_date - p_days)::date AS d),
arrivals AS (
  SELECT id, email, first_name, last_name, company, source_code, record_type, industry, state, country,
         salesforce_created_date, salesforce_last_activity_date, salesforce_lead_status,
         salesforce_activity_verified_at, salesforce_activity_verification_status,
         salesforce_owner_name, unsubscribed AS suppressed,
         last_engaged_at, last_replied_at, engagement_score, total_opens, total_clicks
    FROM contacts
   WHERE client_id = p_client_id
     AND salesforce_created_date >= now() - make_interval(days => p_days)
),
source_counts AS (
  SELECT coalesce(source_code, '(none)') AS source, count(*) AS n
    FROM arrivals GROUP BY 1 ORDER BY 2 DESC
),
subs AS (SELECT * FROM form_submissions(p_client_id, (SELECT d FROM since))),
form_counts AS (
  SELECT coalesce(f.label, s.code) AS form, count(*) AS n, count(DISTINCT s.contact_id) AS people
    FROM subs s LEFT JOIN engagement_form_sources f ON f.client_id = p_client_id AND f.code = s.code
   GROUP BY 1 ORDER BY 2 DESC
),
lead_base AS (
  SELECT s.contact_id, max(s.submitted_on) AS last_form_on, min(s.submitted_on) AS first_form_on,
         count(*) AS forms_in_window,
         (array_agg(coalesce(f.label, s.code) ORDER BY s.submitted_on DESC))[1] AS last_form,
         string_agg(DISTINCT coalesce(f.label, s.code), ', ') AS forms
    FROM subs s LEFT JOIN engagement_form_sources f ON f.client_id = p_client_id AND f.code = s.code
   GROUP BY s.contact_id
),
form_evidence AS (
  SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.industry, c.state, c.country,
         c.record_type, c.salesforce_lead_status, c.salesforce_created_date, c.salesforce_owner_name,
         c.unsubscribed AS suppressed,
         b.last_form, b.forms, b.last_form_on, b.first_form_on, b.forms_in_window,
         c.salesforce_last_activity_date, c.salesforce_activity_verified_at,
         coalesce(c.salesforce_activity_verification_status, 'unresolved') AS verification_status,
         c.last_engaged_at, c.last_replied_at, c.total_opens, c.total_clicks, c.engagement_score,
         coalesce(metrics.opens, 0) AS opens_since_form,
         coalesce(metrics.clicks, 0) AS clicks_since_form,
         human.last_at AS human_outbound_at,
         ambiguous.last_at AS ambiguous_outbound_at,
         auto.last_at AS last_auto_followup_at,
         coalesce(auto.n, 0) AS auto_followups,
         inbound.last_at AS genuine_reply_at,
         response.last_at AS human_response_at,
         ask.salesforce_id AS ask_salesforce_id, ask.name AS ask_name, ask.status AS ask_status,
         ask.sf_created_at AS ask_created_at,
         CASE WHEN ask.status = 'Response Emailed' THEN ask.sf_last_modified_at END AS ask_answered_at,
         (SELECT count(*) FROM salesforce_opportunities o
           WHERE o.client_id = p_client_id AND o.is_closed = false
             AND coalesce(o.visible_in_last_snapshot, true)
             AND (o.sf_contact_id = c.salesforce_id OR lower(o.contact_email) = lower(c.email))) AS open_opps
    FROM lead_base b JOIN contacts c ON c.id = b.contact_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.event_type = 'open') AS opens,
             count(*) FILTER (WHERE e.event_type = 'click') AS clicks
        FROM analytics_events e JOIN campaigns cp ON cp.id = e.campaign_id
       WHERE lower(e.email) = lower(c.email) AND cp.client_id = p_client_id
         AND e.timestamp >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
    ) metrics ON true
    LEFT JOIN LATERAL (
      SELECT max(created_at) AS last_at FROM email_conversations
       WHERE client_id = p_client_id AND contact_id = c.id AND direction = 'outbound'
         AND ai_generated = false
         AND created_at >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
    ) human ON true
    LEFT JOIN LATERAL (
      SELECT max(created_at) AS last_at FROM email_conversations
       WHERE client_id = p_client_id AND contact_id = c.id AND direction = 'outbound'
         AND ai_generated IS NULL
         AND created_at >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
    ) ambiguous ON true
    LEFT JOIN LATERAL (
      SELECT max(at) AS last_at, count(*) AS n FROM (
        SELECT sent_at AS at FROM ai_followup_drafts
         WHERE client_id = p_client_id AND contact_id = c.id AND status = 'sent'
           AND sent_at >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
        UNION ALL
        SELECT created_at AS at FROM email_conversations
         WHERE client_id = p_client_id AND contact_id = c.id
           AND direction = 'outbound' AND ai_generated = true
           AND created_at >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
      ) automation
    ) auto ON true
    LEFT JOIN LATERAL (
      SELECT max(created_at) AS last_at FROM email_conversations
       WHERE client_id = p_client_id AND contact_id = c.id AND direction = 'inbound'
         AND created_at >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
         AND coalesce(body, '') !~* '^\[auto-response\]'
         AND coalesce(subject, '') !~* '^(automatic reply|auto.?reply|out of office|undeliverable|delivery status|test($|:))'
    ) inbound ON true
    LEFT JOIN LATERAL (
      SELECT max(created_at) AS last_at FROM email_conversations
       WHERE client_id = p_client_id AND contact_id = c.id AND direction = 'outbound'
         AND ai_generated = false AND inbound.last_at IS NOT NULL AND created_at > inbound.last_at
    ) response ON true
    LEFT JOIN LATERAL (
      -- The question this form fill created (Ask Alconox and TechNotes forms write
      -- one record each). Salesforce keeps no date for the status change, so the
      -- record's last-modified time stands in as "answered by".
      SELECT q.salesforce_id, q.name, q.status, q.sf_created_at, q.sf_last_modified_at
        FROM salesforce_ask_questions q
       WHERE q.client_id = p_client_id AND q.visible_in_last_snapshot
         AND q.sf_created_at >= (b.last_form_on::timestamp AT TIME ZONE 'America/New_York')
         AND (q.sf_lead_id = c.salesforce_id OR q.sf_contact_id = c.salesforce_id
              OR (q.email IS NOT NULL AND lower(q.email) = lower(c.email)))
       ORDER BY (q.status = 'Response Emailed') DESC, q.sf_created_at DESC
       LIMIT 1
    ) ask ON true
),
form_classified AS (
  SELECT *,
         human_outbound_at AS our_reply_at,
         (salesforce_last_activity_date IS NOT NULL AND salesforce_last_activity_date > last_form_on) AS sf_touched,
         engagement_evidence_classification(
           last_form_on::timestamp AT TIME ZONE 'America/New_York',
           salesforce_last_activity_date, verification_status,
           human_outbound_at, last_auto_followup_at, ambiguous_outbound_at,
           genuine_reply_at, human_response_at, now(), p_wait_days
         ) AS evidence_status
    FROM form_evidence
),
form_leads_all AS (
  -- A "Response Emailed" Ask Alconox record is a person at Alconox answering the
  -- question, recorded in Salesforce itself, so it outranks date-only activity,
  -- automation, and unresolved Lead/Contact lookups. A newer reply still waits.
  SELECT *,
         CASE WHEN ask_answered_at IS NOT NULL
               AND evidence_status NOT IN ('reply awaiting verified response', 'verified human follow-up')
              THEN 'Ask Alconox answered' ELSE evidence_status END AS status
    FROM form_classified
),
form_leads AS (
  SELECT * FROM form_leads_all
   ORDER BY
     (status = 'reply awaiting verified response') DESC,
     (status = 'no follow-up recorded') DESC,
     (status = 'automation only') DESC,
     (status = 'unable to verify') DESC,
     (clicks_since_form + opens_since_form) DESC,
     last_form_on ASC
   LIMIT 300
),
replies_all AS (
  SELECT ec.id, ec.created_at, ec.subject, left(ec.body, 400) AS body,
         c.id AS contact_id, coalesce(c.email, '') AS email, c.first_name, c.last_name, c.company,
         c.source_code, c.salesforce_last_activity_date,
         (SELECT max(o.created_at) FROM email_conversations o
           WHERE o.client_id = p_client_id AND o.contact_id = c.id
             AND o.direction = 'outbound' AND o.ai_generated = false AND o.created_at > ec.created_at) AS answered_at
    FROM email_conversations ec LEFT JOIN contacts c ON c.id = ec.contact_id
   WHERE ec.client_id = p_client_id AND ec.direction = 'inbound'
     AND ec.created_at >= now() - make_interval(days => p_days)
     AND coalesce(ec.body, '') !~* '^\[auto-response\]'
     AND coalesce(ec.subject, '') !~* '^(automatic reply|auto.?reply|out of office|undeliverable|delivery status|test($|:))'
),
replies AS (SELECT * FROM replies_all ORDER BY created_at DESC LIMIT 100),
pipeline AS (
  SELECT stage, count(*) AS n FROM salesforce_opportunities
   WHERE client_id = p_client_id AND is_closed = false AND coalesce(visible_in_last_snapshot, true)
   GROUP BY 1 ORDER BY 2 DESC
),
stalled_all AS (
  SELECT o.salesforce_id, o.name, o.stage, o.owner_name, o.contact_email, o.sf_created_date,
         o.last_stage_change, o.last_activity_date, o.sample_shipped_at,
         engagement_opportunity_last_touch(o.last_activity_date, o.last_stage_change, o.sf_created_date) AS last_touch
    FROM salesforce_opportunities o
   WHERE o.client_id = p_client_id AND o.is_closed = false AND coalesce(o.visible_in_last_snapshot, true)
     AND engagement_opportunity_last_touch(o.last_activity_date, o.last_stage_change, o.sf_created_date) < current_date - 14
),
stalled AS (SELECT * FROM stalled_all ORDER BY last_touch DESC LIMIT 100),
engaged AS (
  SELECT id, email, first_name, last_name, company, source_code, engagement_score, total_opens, total_clicks,
         last_engaged_at, last_replied_at, salesforce_last_activity_date,
         salesforce_activity_verification_status AS verification_status
    FROM contacts
   WHERE client_id = p_client_id AND last_engaged_at >= now() - make_interval(days => p_days)
   ORDER BY engagement_score DESC, last_engaged_at DESC LIMIT 100
),
totals AS (
  SELECT
    (SELECT count(*) FROM arrivals) AS arrivals,
    (SELECT count(*) FROM form_leads_all) AS form_leads,
    (SELECT count(*) FROM form_leads_all WHERE status = 'no follow-up recorded') AS form_leads_no_follow_up,
    (SELECT count(*) FROM form_leads_all WHERE status = 'reply awaiting verified response') AS form_leads_reply_waiting,
    (SELECT count(*) FROM form_leads_all WHERE status = 'verified human follow-up') AS form_leads_human_follow_up,
    (SELECT count(*) FROM form_leads_all WHERE status = 'Salesforce activity recorded') AS form_leads_salesforce_activity,
    (SELECT count(*) FROM form_leads_all WHERE status = 'Ask Alconox answered') AS form_leads_ask_answered,
    (SELECT count(*) FROM form_leads_all WHERE status = 'automation only') AS form_leads_automation,
    (SELECT count(*) FROM form_leads_all WHERE status = 'new — within follow-up window') AS form_leads_within_grace,
    (SELECT count(*) FROM form_leads_all WHERE status IN ('same-day activity — sequence unknown', 'future activity date — ambiguous', 'outbound provenance unknown')) AS form_leads_ambiguous,
    (SELECT count(*) FROM form_leads_all WHERE status = 'unable to verify') AS form_leads_unable_to_verify,
    (SELECT count(*) FROM form_leads_all WHERE status = 'no follow-up recorded') AS form_leads_uncontacted,
    (SELECT count(*) FROM form_leads_all WHERE status = 'reply awaiting verified response') AS form_leads_replied,
    (SELECT count(*) FROM form_leads_all WHERE status IN ('verified human follow-up', 'Salesforce activity recorded', 'Ask Alconox answered')) AS form_leads_contacted,
    (SELECT count(*) FROM form_leads_all WHERE status = 'automation only') AS form_leads_auto,
    (SELECT count(*) FROM form_leads_all WHERE status = 'new — within follow-up window') AS form_leads_new,
    (SELECT count(*) FROM subs) AS form_submissions,
    (SELECT count(*) FROM replies_all) AS replies,
    (SELECT count(*) FROM contacts WHERE client_id = p_client_id AND last_engaged_at >= now() - make_interval(days => p_days)) AS engaged,
    (SELECT count(*) FROM salesforce_opportunities WHERE client_id = p_client_id AND is_closed = false AND coalesce(visible_in_last_snapshot, true)) AS open_opps,
    (SELECT count(*) FROM stalled_all) AS stalled,
    (SELECT max(last_verified_at) FROM salesforce_opportunities WHERE client_id = p_client_id AND coalesce(visible_in_last_snapshot, true)) AS opps_synced_at,
    (SELECT max(completed_at) FROM engagement_refresh_runs WHERE client_id = p_client_id AND scope = 'known_people' AND status = 'complete') AS contacts_synced_at,
    (SELECT max(last_verified_at) FROM salesforce_ask_questions WHERE client_id = p_client_id) AS ask_synced_at
)
SELECT jsonb_build_object(
  'schema_version', 1,
  'days', p_days,
  'wait_days', p_wait_days,
  'totals', (SELECT to_jsonb(t) FROM totals t),
  'sources', coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM source_counts s), '[]'::jsonb),
  'forms', coalesce((SELECT jsonb_agg(to_jsonb(f)) FROM form_counts f), '[]'::jsonb),
  'form_leads', coalesce((SELECT jsonb_agg(to_jsonb(l)) FROM form_leads l), '[]'::jsonb),
  'arrivals', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.salesforce_created_date DESC) FROM (SELECT * FROM arrivals ORDER BY salesforce_created_date DESC LIMIT 200) a), '[]'::jsonb),
  'replies', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM replies r), '[]'::jsonb),
  'pipeline', coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM pipeline p), '[]'::jsonb),
  'stalled', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.last_touch DESC) FROM stalled s), '[]'::jsonb),
  'engaged', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.engagement_score DESC) FROM engaged e), '[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION engagement_overview(uuid, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION engagement_overview(uuid, int, int) TO service_role;

COMMIT;
