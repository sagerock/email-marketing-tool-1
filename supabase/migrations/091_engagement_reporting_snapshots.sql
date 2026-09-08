-- 091: Versioned Salesforce reporting snapshots and evidence-safe engagement labels.
-- Additive and feature-gated in application code. No Salesforce writes or send paths.

CREATE TABLE IF NOT EXISTS engagement_refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('recent_leads', 'salesforce_people', 'known_people')),
  cohort_type text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  as_of timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end_exclusive timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expected_count integer,
  resolved_count integer NOT NULL DEFAULT 0,
  unresolved_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  cohort_discovery_complete boolean NOT NULL DEFAULT false,
  opportunity_discovery_complete boolean NOT NULL DEFAULT false,
  source_limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS engagement_refresh_runs_latest
  ON engagement_refresh_runs(client_id, scope, completed_at DESC)
  WHERE status = 'complete';

CREATE TABLE IF NOT EXISTS engagement_refresh_records (
  run_id uuid NOT NULL REFERENCES engagement_refresh_runs(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  salesforce_id text NOT NULL,
  salesforce_link text,
  record_type text NOT NULL CHECK (record_type IN ('lead', 'contact')),
  email text,
  first_name text,
  last_name text,
  company text,
  owner_name text,
  source_code text,
  salesforce_status text,
  is_converted boolean,
  salesforce_created_date timestamptz,
  salesforce_last_activity_date date,
  verification_status text NOT NULL CHECK (verification_status IN ('resolved', 'unresolved', 'failed')),
  verified_at timestamptz NOT NULL,
  suppressed boolean,
  human_outbound_at timestamptz,
  automation_outbound_at timestamptz,
  ambiguous_outbound_at timestamptz,
  genuine_reply_at timestamptz,
  human_response_at timestamptz,
  open_opportunity_count integer,
  latest_pipeline_movement_at timestamptz,
  pipeline_coverage_status text,
  opens integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  identity_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, record_type, salesforce_id)
);

ALTER TABLE engagement_refresh_runs
  ADD COLUMN IF NOT EXISTS opportunity_discovery_complete boolean NOT NULL DEFAULT false;
ALTER TABLE engagement_refresh_records
  ADD COLUMN IF NOT EXISTS open_opportunity_count integer,
  ADD COLUMN IF NOT EXISTS latest_pipeline_movement_at timestamptz,
  ADD COLUMN IF NOT EXISTS pipeline_coverage_status text;

CREATE INDEX IF NOT EXISTS engagement_refresh_records_client_contact
  ON engagement_refresh_records(client_id, contact_id);
CREATE INDEX IF NOT EXISTS engagement_refresh_records_created
  ON engagement_refresh_records(run_id, salesforce_created_date DESC, salesforce_id);

ALTER TABLE engagement_refresh_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_refresh_records ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Admins can select engagement refresh runs" ON engagement_refresh_runs
    FOR SELECT USING (can_access_client(client_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Admins can select engagement refresh records" ON engagement_refresh_records
    FOR SELECT USING (can_access_client(client_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS salesforce_activity_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS salesforce_activity_verification_status text,
  ADD COLUMN IF NOT EXISTS salesforce_owner_name text;

ALTER TABLE salesforce_opportunities
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS visible_in_last_snapshot boolean NOT NULL DEFAULT true;

-- The dashboard and digest only display recent arrivals, form leads, replies,
-- and engaged people. Enumerate that exact bounded contact cohort rather than
-- treating an arbitrary prefix of the full contact table as complete.
CREATE OR REPLACE FUNCTION engagement_reporting_candidates(
  p_client_id uuid,
  p_start timestamptz,
  p_end_exclusive timestamptz,
  p_limit integer DEFAULT 5000
) RETURNS TABLE(
  id uuid,
  salesforce_id text,
  record_type text,
  email text,
  total_count bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH form_people AS (
  SELECT DISTINCT fs.contact_id
    FROM form_submissions(
      p_client_id,
      (p_start AT TIME ZONE 'America/New_York')::date
    ) fs
   WHERE fs.submitted_on < (p_end_exclusive AT TIME ZONE 'America/New_York')::date + 1
),
eligible AS (
  SELECT c.id, c.salesforce_id, c.record_type, c.email
    FROM contacts c
   WHERE c.client_id = p_client_id
     AND c.salesforce_id IS NOT NULL
     AND (
       (c.salesforce_created_date >= p_start AND c.salesforce_created_date < p_end_exclusive)
       OR (c.last_engaged_at >= p_start AND c.last_engaged_at < p_end_exclusive)
       OR (c.last_replied_at >= p_start AND c.last_replied_at < p_end_exclusive)
       OR EXISTS (SELECT 1 FROM form_people fp WHERE fp.contact_id = c.id)
       OR EXISTS (
         SELECT 1 FROM email_conversations ec
          WHERE ec.client_id = p_client_id AND ec.contact_id = c.id
            AND ec.created_at >= p_start AND ec.created_at < p_end_exclusive
       )
     )
)
SELECT e.id, e.salesforce_id, e.record_type, e.email, count(*) OVER () AS total_count
  FROM eligible e
 ORDER BY e.id
 LIMIT least(greatest(p_limit, 1), 20000);
$$;
REVOKE ALL ON FUNCTION engagement_reporting_candidates(uuid, timestamptz, timestamptz, integer)
  FROM anon, authenticated;

-- Only exact Salesforce-ID matches update the shared cache. A resolved null clears
-- an obsolete LastActivityDate; unresolved records leave the previous value intact.
CREATE OR REPLACE FUNCTION apply_engagement_snapshot(p_run_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  UPDATE contacts c
     SET salesforce_last_activity_date = r.salesforce_last_activity_date,
         salesforce_activity_verified_at = r.verified_at,
         salesforce_activity_verification_status = r.verification_status,
         salesforce_owner_name = r.owner_name
    FROM engagement_refresh_records r
   WHERE r.run_id = p_run_id
     AND r.verification_status = 'resolved'
     AND r.contact_id = c.id
     AND r.client_id = c.client_id
     AND r.salesforce_id = c.salesforce_id;
  GET DIAGNOSTICS changed = ROW_COUNT;

  UPDATE contacts c
     SET salesforce_activity_verified_at = r.verified_at,
         salesforce_activity_verification_status = r.verification_status
    FROM engagement_refresh_records r
   WHERE r.run_id = p_run_id
     AND r.verification_status <> 'resolved'
     AND r.contact_id = c.id
     AND r.client_id = c.client_id
     AND r.salesforce_id = c.salesforce_id;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION apply_engagement_snapshot(uuid) FROM anon, authenticated;

-- Freeze local email evidence into the same immutable snapshot as the Salesforce
-- rows. Later pages therefore cannot drift as conversations/events arrive.
CREATE OR REPLACE FUNCTION freeze_engagement_snapshot_evidence(
  p_run_id uuid,
  p_opportunity_verified boolean DEFAULT false
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  UPDATE engagement_refresh_records r
     SET suppressed = c.unsubscribed,
         human_outbound_at = (
           SELECT max(created_at) FROM email_conversations
            WHERE client_id = r.client_id AND contact_id = r.contact_id
              AND direction = 'outbound' AND ai_generated = false
              AND created_at >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                    ELSE coalesce(r.salesforce_created_date, run.window_start) END
              AND created_at <= run.as_of
         ),
         automation_outbound_at = (
           SELECT max(at) FROM (
             SELECT sent_at AS at FROM ai_followup_drafts
              WHERE client_id = r.client_id AND contact_id = r.contact_id
                AND status = 'sent' AND sent_at <= run.as_of
                AND sent_at >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                      ELSE coalesce(r.salesforce_created_date, run.window_start) END
             UNION ALL
             SELECT created_at AS at FROM email_conversations
              WHERE client_id = r.client_id AND contact_id = r.contact_id
                AND direction = 'outbound' AND ai_generated = true
                AND created_at >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                      ELSE coalesce(r.salesforce_created_date, run.window_start) END
                AND created_at <= run.as_of
           ) automation
         ),
         ambiguous_outbound_at = (
           SELECT max(created_at) FROM email_conversations
            WHERE client_id = r.client_id AND contact_id = r.contact_id
              AND direction = 'outbound' AND ai_generated IS NULL
              AND created_at >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                    ELSE coalesce(r.salesforce_created_date, run.window_start) END
              AND created_at <= run.as_of
         ),
         genuine_reply_at = (
           SELECT max(created_at) FROM email_conversations
            WHERE client_id = r.client_id AND contact_id = r.contact_id
              AND direction = 'inbound' AND created_at <= run.as_of
              AND created_at >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                    ELSE coalesce(r.salesforce_created_date, run.window_start) END
              AND coalesce(body, '') !~* '^\[auto-response\]'
              AND coalesce(subject, '') !~* '^(automatic reply|auto.?reply|out of office|undeliverable|delivery status|test($|:))'
         ),
         opens = (
           SELECT count(*) FROM analytics_events ae JOIN campaigns cp ON cp.id = ae.campaign_id
            WHERE cp.client_id = r.client_id AND lower(ae.email) = lower(r.email)
              AND ae.event_type = 'open'
              AND ae.timestamp >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                    ELSE coalesce(r.salesforce_created_date, run.window_start) END
              AND ae.timestamp < run.window_end_exclusive
         ),
         clicks = (
           SELECT count(*) FROM analytics_events ae JOIN campaigns cp ON cp.id = ae.campaign_id
            WHERE cp.client_id = r.client_id AND lower(ae.email) = lower(r.email)
              AND ae.event_type = 'click'
              AND ae.timestamp >= CASE WHEN run.scope = 'salesforce_people' THEN run.window_start
                    ELSE coalesce(r.salesforce_created_date, run.window_start) END
              AND ae.timestamp < run.window_end_exclusive
         )
    FROM contacts c, engagement_refresh_runs run
   WHERE r.run_id = p_run_id AND run.id = r.run_id
     AND r.contact_id = c.id AND r.client_id = c.client_id;

  -- Opportunity.ContactId is a Salesforce identity, so pipeline evidence can
  -- be frozen for source rows even when the person is not cached locally.
  UPDATE engagement_refresh_records r
     SET open_opportunity_count = CASE WHEN p_opportunity_verified THEN (
           SELECT count(*) FROM salesforce_opportunities o
            WHERE o.client_id = r.client_id
              AND o.sf_contact_id = r.salesforce_id
              AND o.is_closed = false
              AND o.visible_in_last_snapshot = true
              AND o.verification_status = 'resolved'
         ) END,
         latest_pipeline_movement_at = CASE WHEN p_opportunity_verified THEN (
           SELECT max(greatest(
             o.last_activity_date::timestamp AT TIME ZONE 'America/New_York',
             o.last_stage_change, o.sf_created_date, o.sample_shipped_at
           )) FROM salesforce_opportunities o
            WHERE o.client_id = r.client_id
              AND o.sf_contact_id = r.salesforce_id
              AND o.visible_in_last_snapshot = true
              AND o.verification_status = 'resolved'
         ) END,
         pipeline_coverage_status = CASE
           WHEN NOT p_opportunity_verified THEN 'unavailable'
           WHEN r.record_type = 'lead' THEN 'not directly linkable'
           ELSE 'verified' END
   WHERE r.run_id = p_run_id;

  UPDATE engagement_refresh_records r
     SET human_response_at = (
       SELECT max(created_at) FROM email_conversations
        WHERE client_id = r.client_id AND contact_id = r.contact_id
          AND direction = 'outbound' AND ai_generated = false
          AND r.genuine_reply_at IS NOT NULL AND created_at > r.genuine_reply_at
          AND created_at <= run.as_of
     )
    FROM engagement_refresh_runs run
   WHERE r.run_id = p_run_id AND run.id = r.run_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION freeze_engagement_snapshot_evidence(uuid, boolean) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION engagement_evidence_classification(
  p_arrival_at timestamptz,
  p_sf_activity date,
  p_verification_status text,
  p_human_outbound timestamptz,
  p_automation_outbound timestamptz,
  p_ambiguous_outbound timestamptz,
  p_genuine_reply timestamptz,
  p_human_response timestamptz,
  p_as_of timestamptz,
  p_grace_days integer DEFAULT 3
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN coalesce(p_verification_status, 'unresolved') <> 'resolved' THEN 'unable to verify'
    WHEN p_genuine_reply IS NOT NULL
         AND p_genuine_reply >= p_arrival_at
         AND (p_human_response IS NULL OR p_human_response <= p_genuine_reply)
      THEN 'reply awaiting verified response'
    WHEN p_human_outbound IS NOT NULL AND p_human_outbound >= p_arrival_at THEN 'verified human follow-up'
    WHEN p_sf_activity > (p_as_of AT TIME ZONE 'America/New_York')::date THEN 'future activity date — ambiguous'
    WHEN p_sf_activity > (p_arrival_at AT TIME ZONE 'America/New_York')::date THEN 'Salesforce activity recorded'
    WHEN p_sf_activity = (p_arrival_at AT TIME ZONE 'America/New_York')::date THEN 'same-day activity — sequence unknown'
    WHEN p_ambiguous_outbound IS NOT NULL AND p_ambiguous_outbound >= p_arrival_at THEN 'outbound provenance unknown'
    WHEN p_automation_outbound IS NOT NULL AND p_automation_outbound >= p_arrival_at THEN 'automation only'
    WHEN p_arrival_at > p_as_of - make_interval(days => greatest(p_grace_days, 0)) THEN 'new — within follow-up window'
    ELSE 'no follow-up recorded'
  END;
$$;

-- Shared report contract consumed by the dashboard/API/digest and Athena.
CREATE OR REPLACE FUNCTION engagement_snapshot_report(
  p_client_id uuid,
  p_snapshot_id uuid,
  p_query_type text DEFAULT 'recent_leads',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_grace_days integer DEFAULT 3
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH run AS (
  SELECT * FROM engagement_refresh_runs
   WHERE id = p_snapshot_id AND client_id = p_client_id
),
evidence AS (
  SELECT r.* FROM engagement_refresh_records r
   WHERE r.run_id = p_snapshot_id AND r.client_id = p_client_id
),
classified AS (
  SELECT e.*,
         engagement_evidence_classification(
           coalesce(e.salesforce_created_date, (SELECT window_start FROM run)),
           e.salesforce_last_activity_date, e.verification_status,
           e.human_outbound_at, e.automation_outbound_at, e.ambiguous_outbound_at,
           e.genuine_reply_at, e.human_response_at, (SELECT as_of FROM run), p_grace_days
         ) AS classification,
         greatest(
           e.human_outbound_at,
           CASE WHEN e.salesforce_last_activity_date IS NOT NULL
                     AND e.salesforce_last_activity_date <= ((SELECT as_of FROM run) AT TIME ZONE 'America/New_York')::date
                THEN (e.salesforce_last_activity_date::timestamp AT TIME ZONE 'America/New_York') END
         ) AS latest_recorded_contact_at
    FROM evidence e
),
eligible AS (
  SELECT * FROM classified
   WHERE (p_query_type <> 'inactive_people'
          OR latest_recorded_contact_at IS NULL
          OR latest_recorded_contact_at < (SELECT window_start FROM run))
     AND (p_query_type <> 'recent_leads'
          OR classification NOT IN ('verified human follow-up', 'Salesforce activity recorded'))
     AND (nullif(p_filters->>'owner', '') IS NULL OR lower(coalesce(owner_name, '')) LIKE '%' || lower(p_filters->>'owner') || '%')
     AND (nullif(p_filters->>'source', '') IS NULL OR lower(coalesce(source_code, '')) LIKE '%' || lower(p_filters->>'source') || '%')
     AND (nullif(p_filters->>'record_type', '') IS NULL OR record_type = p_filters->>'record_type')
     AND (nullif(p_filters->>'classification', '') IS NULL OR classification = p_filters->>'classification')
),
page AS (
  SELECT * FROM eligible
   ORDER BY salesforce_created_date DESC NULLS LAST, record_type, salesforce_id
   OFFSET greatest(p_offset, 0) LIMIT least(greatest(p_limit, 1), 100)
),
breakdown AS (
  SELECT classification, count(*) AS n FROM eligible GROUP BY classification ORDER BY n DESC
),
totals AS (
  SELECT
    (SELECT count(*) FROM classified) AS population_count,
    (SELECT count(*) FROM eligible) AS matching_count,
    (SELECT count(*) FROM eligible WHERE human_outbound_at IS NOT NULL) AS verified_human_outbound,
    (SELECT count(*) FROM eligible WHERE automation_outbound_at IS NOT NULL) AS automation_outbound,
    (SELECT count(*) FROM eligible WHERE genuine_reply_at IS NOT NULL) AS genuine_replies,
    (SELECT count(*) FROM eligible WHERE genuine_reply_at IS NOT NULL AND human_response_at IS NULL) AS replies_awaiting_response,
    (SELECT count(*) FROM eligible
      WHERE salesforce_last_activity_date >= CASE
              WHEN (SELECT scope FROM run) = 'salesforce_people'
                THEN ((SELECT window_start FROM run) AT TIME ZONE 'America/New_York')::date
              ELSE (salesforce_created_date AT TIME ZONE 'America/New_York')::date END
        AND salesforce_last_activity_date <= ((SELECT as_of FROM run) AT TIME ZONE 'America/New_York')::date
    ) AS salesforce_activity_recorded,
    (SELECT count(*) FROM eligible WHERE verification_status <> 'resolved') AS unable_to_verify,
    (SELECT coalesce(sum(open_opportunity_count), 0) FROM eligible) AS open_opportunities,
    (SELECT count(*) FROM eligible WHERE open_opportunity_count > 0) AS people_with_open_opportunities,
    (SELECT count(*) FROM eligible WHERE latest_pipeline_movement_at IS NOT NULL) AS people_with_pipeline_movement,
    (SELECT count(*) FROM eligible WHERE pipeline_coverage_status IS DISTINCT FROM 'verified') AS pipeline_coverage_unavailable
)
SELECT jsonb_build_object(
  'schema_version', 1,
  'snapshot_id', p_snapshot_id,
  'query_type', p_query_type,
  'cohort', jsonb_build_object(
    'type', (SELECT cohort_type FROM run),
    'source', 'Salesforce',
    'population_rule', CASE
      WHEN p_query_type = 'inactive_people' THEN 'Accessible Salesforce Leads; Contacts are included only when explicitly requested. Converted and disqualified visibility follows the integration user.'
      ELSE 'Accessible Salesforce Lead records created inside the stated half-open window.'
    END,
    'filters', p_filters,
    'timezone', (SELECT timezone FROM run),
    'start', (SELECT window_start FROM run),
    'end_exclusive', (SELECT window_end_exclusive FROM run),
    'exclusions', jsonb_build_array('Records not visible to the Salesforce integration user')
  ),
  'as_of', (SELECT as_of FROM run),
  'freshness', jsonb_build_object(
    'status', (SELECT status FROM run),
    'verification_started_at', (SELECT started_at FROM run),
    'verification_completed_at', (SELECT completed_at FROM run),
    'expected_count', (SELECT expected_count FROM run),
    'resolved_count', (SELECT resolved_count FROM run),
    'unresolved_count', (SELECT unresolved_count FROM run),
    'failed_count', (SELECT failed_count FROM run),
    'cohort_discovery_complete', (SELECT cohort_discovery_complete FROM run),
    'opportunity_discovery_complete', (SELECT opportunity_discovery_complete FROM run),
    'source_limitations', (SELECT source_limitations FROM run)
  ),
  'totals', (SELECT to_jsonb(t) || jsonb_build_object(
    'classification_breakdown', coalesce((SELECT jsonb_object_agg(classification, n) FROM breakdown), '{}'::jsonb)
  ) FROM totals t),
  'results', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'person_id', contact_id,
    'display_identity', coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email, salesforce_id),
    'email', email,
    'company', company,
    'salesforce_id', salesforce_id,
    'salesforce_record_type', record_type,
    'salesforce_link', salesforce_link,
    'owner', owner_name,
    'source', source_code,
    'arrival_date', salesforce_created_date,
    'salesforce_activity_date', salesforce_last_activity_date,
    'verified_human_outbound_at', human_outbound_at,
    'automation_outbound_at', automation_outbound_at,
    'ambiguous_outbound_at', ambiguous_outbound_at,
    'genuine_reply_at', genuine_reply_at,
    'human_response_at', human_response_at,
    'open_opportunity_count', open_opportunity_count,
    'latest_pipeline_movement_at', latest_pipeline_movement_at,
    'pipeline_coverage_status', pipeline_coverage_status,
    'marketing_engagement', jsonb_build_object('opens', opens, 'clicks', clicks),
    'suppressed', suppressed,
    'classification', classification,
    'reason', CASE classification
      WHEN 'no follow-up recorded' THEN 'No post-arrival Salesforce activity date or verified human outbound was recorded in the available evidence.'
      WHEN 'same-day activity — sequence unknown' THEN 'Salesforce records activity on the arrival date, but its date-only rollup cannot establish whether it followed the arrival.'
      WHEN 'unable to verify' THEN 'The source record could not be resolved in this verification run.'
      ELSE classification END,
    'verification_status', verification_status,
    'verified_at', verified_at,
    'detail_link', CASE WHEN contact_id IS NOT NULL THEN '/contacts/' || contact_id::text END
  ) ORDER BY salesforce_created_date DESC NULLS LAST, record_type, salesforce_id) FROM page), '[]'::jsonb),
  'pagination', jsonb_build_object(
    'returned_count', (SELECT count(*) FROM page),
    'limit', least(greatest(p_limit, 1), 100),
    'next_offset', CASE WHEN greatest(p_offset, 0) + (SELECT count(*) FROM page) < (SELECT matching_count FROM totals)
                        THEN greatest(p_offset, 0) + (SELECT count(*) FROM page) END,
    'has_more', greatest(p_offset, 0) + (SELECT count(*) FROM page) < (SELECT matching_count FROM totals)
  ),
  'warnings', CASE WHEN (SELECT status FROM run) = 'complete'
                         AND coalesce((SELECT unresolved_count FROM run), 0) = 0
                         AND coalesce((SELECT failed_count FROM run), 0) = 0
                         AND coalesce((SELECT cohort_discovery_complete FROM run), false)
                         AND coalesce((SELECT opportunity_discovery_complete FROM run), false)
                   THEN CASE WHEN (SELECT pipeline_coverage_unavailable FROM totals) > 0
                     THEN jsonb_build_array('Opportunity population was verified, but some people have no safe exact-ID pipeline linkage; those rows are marked unavailable.')
                     ELSE '[]'::jsonb END
                   ELSE jsonb_build_array('Coverage is incomplete; do not treat missing evidence as zero activity.') END
);
$$;
REVOKE ALL ON FUNCTION engagement_snapshot_report(uuid, uuid, text, integer, integer, jsonb, integer) FROM anon, authenticated;

-- Fix the pipeline metric used by existing consumers: choose the newest eligible
-- movement/activity evidence rather than first-non-null precedence.
CREATE OR REPLACE FUNCTION engagement_opportunity_last_touch(
  p_activity date, p_stage_change timestamptz, p_created timestamptz
) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT greatest(p_activity, p_stage_change::date, p_created::date);
$$;

-- Existing page and digest contract, now using the same evidence classifier as
-- snapshot reports. Legacy total keys remain during the UI transition.
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
),
form_leads_all AS (
  SELECT *,
         human_outbound_at AS our_reply_at,
         (salesforce_last_activity_date IS NOT NULL AND salesforce_last_activity_date > last_form_on) AS sf_touched,
         engagement_evidence_classification(
           last_form_on::timestamp AT TIME ZONE 'America/New_York',
           salesforce_last_activity_date, verification_status,
           human_outbound_at, last_auto_followup_at, ambiguous_outbound_at,
           genuine_reply_at, human_response_at, now(), p_wait_days
         ) AS status
    FROM form_evidence
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
    (SELECT count(*) FROM form_leads_all WHERE status = 'automation only') AS form_leads_automation,
    (SELECT count(*) FROM form_leads_all WHERE status = 'new — within follow-up window') AS form_leads_within_grace,
    (SELECT count(*) FROM form_leads_all WHERE status IN ('same-day activity — sequence unknown', 'future activity date — ambiguous', 'outbound provenance unknown')) AS form_leads_ambiguous,
    (SELECT count(*) FROM form_leads_all WHERE status = 'unable to verify') AS form_leads_unable_to_verify,
    (SELECT count(*) FROM form_leads_all WHERE status = 'no follow-up recorded') AS form_leads_uncontacted,
    (SELECT count(*) FROM form_leads_all WHERE status = 'reply awaiting verified response') AS form_leads_replied,
    (SELECT count(*) FROM form_leads_all WHERE status IN ('verified human follow-up', 'Salesforce activity recorded')) AS form_leads_contacted,
    (SELECT count(*) FROM form_leads_all WHERE status = 'automation only') AS form_leads_auto,
    (SELECT count(*) FROM form_leads_all WHERE status = 'new — within follow-up window') AS form_leads_new,
    (SELECT count(*) FROM subs) AS form_submissions,
    (SELECT count(*) FROM replies_all) AS replies,
    (SELECT count(*) FROM contacts WHERE client_id = p_client_id AND last_engaged_at >= now() - make_interval(days => p_days)) AS engaged,
    (SELECT count(*) FROM salesforce_opportunities WHERE client_id = p_client_id AND is_closed = false AND coalesce(visible_in_last_snapshot, true)) AS open_opps,
    (SELECT count(*) FROM stalled_all) AS stalled,
    (SELECT max(last_verified_at) FROM salesforce_opportunities WHERE client_id = p_client_id AND coalesce(visible_in_last_snapshot, true)) AS opps_synced_at,
    (SELECT max(completed_at) FROM engagement_refresh_runs WHERE client_id = p_client_id AND scope = 'known_people' AND status = 'complete') AS contacts_synced_at
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
REVOKE ALL ON FUNCTION engagement_overview(uuid, int, int) FROM anon, authenticated;
