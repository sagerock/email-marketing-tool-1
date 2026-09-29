-- 104: freeze snapshot evidence in batches.
--
-- The Monday digest's verification failed on 2026-09-21 and 2026-09-28 with
-- "canceling statement due to statement timeout". The one-shot freeze ran
-- ~13s per correlated opens/clicks pass on a cold cache for ~3,800 records,
-- over the API role's 8s statement_timeout (a function-level SET does not
-- extend an already-armed statement timeout; verified 2026-09-29). The
-- 3-argument form freezes only the listed Salesforce IDs so the caller can
-- keep each call small. The 2-argument form keeps its old whole-run behavior.

CREATE OR REPLACE FUNCTION freeze_engagement_snapshot_evidence(
  p_run_id uuid,
  p_opportunity_verified boolean,
  p_salesforce_ids text[]
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
     AND r.contact_id = c.id AND r.client_id = c.client_id
     AND (p_salesforce_ids IS NULL OR r.salesforce_id = ANY(p_salesforce_ids));

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
   WHERE r.run_id = p_run_id
     AND (p_salesforce_ids IS NULL OR r.salesforce_id = ANY(p_salesforce_ids));

  UPDATE engagement_refresh_records r
     SET human_response_at = (
       SELECT max(created_at) FROM email_conversations
        WHERE client_id = r.client_id AND contact_id = r.contact_id
          AND direction = 'outbound' AND ai_generated = false
          AND r.genuine_reply_at IS NOT NULL AND created_at > r.genuine_reply_at
          AND created_at <= run.as_of
     )
    FROM engagement_refresh_runs run
   WHERE r.run_id = p_run_id AND run.id = r.run_id
     AND (p_salesforce_ids IS NULL OR r.salesforce_id = ANY(p_salesforce_ids));
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION freeze_engagement_snapshot_evidence(uuid, boolean, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION freeze_engagement_snapshot_evidence(uuid, boolean, text[]) TO service_role;

CREATE OR REPLACE FUNCTION freeze_engagement_snapshot_evidence(
  p_run_id uuid,
  p_opportunity_verified boolean DEFAULT false
)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT freeze_engagement_snapshot_evidence(p_run_id, p_opportunity_verified, NULL::text[]);
$$;
REVOKE ALL ON FUNCTION freeze_engagement_snapshot_evidence(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION freeze_engagement_snapshot_evidence(uuid, boolean) TO service_role;
