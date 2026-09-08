-- 092: Keep snapshot evidence freezing inside the production statement budget.
-- The reporting query compares canonical email values and aggregates a bounded
-- time window for each resolved Salesforce person.

CREATE INDEX IF NOT EXISTS idx_analytics_events_email_type_time
  ON analytics_events(lower(email), event_type, timestamp, campaign_id);

CREATE INDEX IF NOT EXISTS idx_email_conversations_reporting
  ON email_conversations(client_id, contact_id, direction, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_followup_drafts_reporting
  ON ai_followup_drafts(client_id, contact_id, status, sent_at DESC);
