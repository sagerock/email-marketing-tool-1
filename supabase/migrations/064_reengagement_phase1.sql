-- Re-engagement / sunset — Phase 1 (report-only).
-- Adds an engagement lifecycle label + per-client config + a classifier that
-- labels cold contacts. NOTHING here changes send behavior: sendCampaignById is
-- untouched, so 'cold' contacts still receive normal sends. This phase only
-- gives visibility into the unengaged cohort per client.

-- 1. Lifecycle label on contacts. Default 'active' for everyone; the classifier
--    only ever moves rows between 'active' and 'cold' (reengaging/sunset are
--    reserved for later phases and are never clobbered by this classifier).
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS engagement_status text NOT NULL DEFAULT 'active';

DO $$ BEGIN
  ALTER TABLE contacts ADD CONSTRAINT contacts_engagement_status_check
    CHECK (engagement_status IN ('active','cold','reengaging','sunset'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_engagement_status
  ON contacts (client_id, engagement_status);

-- 2. Per-client config. Opt-in (enabled defaults false) so this never touches a
--    client until switched on. Thresholds are tunable per client.
CREATE TABLE IF NOT EXISTS reengagement_config (
  client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  cold_after_days int NOT NULL DEFAULT 120,        -- no open/click in this window = candidate
  min_received int NOT NULL DEFAULT 3,             -- must have received >= N emails in the window
  protect_customers boolean NOT NULL DEFAULT true, -- never cold a buyer/converted contact
  protected_tags text[] NOT NULL DEFAULT '{}',     -- contacts carrying any of these tags are never cold
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Health report for a client (defined first so the classifier can return it).
CREATE OR REPLACE FUNCTION reengagement_health(p_client uuid)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object(
    'total', count(*),
    'sendable', count(*) FILTER (WHERE unsubscribed = false AND (bounce_status IS NULL OR bounce_status <> 'hard')),
    'active', count(*) FILTER (WHERE engagement_status = 'active'),
    'cold', count(*) FILTER (WHERE engagement_status = 'cold'),
    'reengaging', count(*) FILTER (WHERE engagement_status = 'reengaging'),
    'sunset', count(*) FILTER (WHERE engagement_status = 'sunset'),
    'protected_customers', count(*) FILTER (WHERE is_converted IS TRUE OR coalesce(order_count,0) > 0 OR coalesce(total_spent,0) > 0)
  )
  FROM contacts WHERE client_id = p_client;
$$;

-- 4. Classifier: set-based, idempotent, single client. No-op if not enabled.
--    Only rewrites rows currently 'active'/'cold' (leaves reengaging/sunset alone).
CREATE OR REPLACE FUNCTION reengagement_classify(p_client uuid)
RETURNS json LANGUAGE plpgsql AS $$
DECLARE cfg reengagement_config;
BEGIN
  SELECT * INTO cfg FROM reengagement_config WHERE client_id = p_client;
  IF NOT FOUND OR NOT cfg.enabled THEN
    RETURN json_build_object('ran', false, 'reason', 'not enabled');
  END IF;

  WITH recv AS (
    -- how many emails each address actually received (delivered) in the window
    SELECT lower(e.email) AS email, count(*) AS delivered_recent
    FROM analytics_events e
    JOIN campaigns cam ON cam.id = e.campaign_id
    WHERE cam.client_id = p_client
      AND e.event_type = 'delivered'
      AND e.timestamp > now() - (cfg.cold_after_days || ' days')::interval
    GROUP BY lower(e.email)
  ),
  classified AS (
    SELECT c.id,
      CASE WHEN
            c.unsubscribed = false
        AND (c.bounce_status IS NULL OR c.bounce_status <> 'hard')
        AND c.created_at < now() - (cfg.cold_after_days || ' days')::interval
        AND (c.last_engaged_at IS NULL OR c.last_engaged_at < now() - (cfg.cold_after_days || ' days')::interval)
        AND NOT (cfg.protect_customers AND (c.is_converted IS TRUE OR coalesce(c.order_count,0) > 0 OR coalesce(c.total_spent,0) > 0))
        AND NOT (coalesce(c.tags,'{}') && cfg.protected_tags)
        AND coalesce(r.delivered_recent,0) >= cfg.min_received
      THEN 'cold' ELSE 'active' END AS new_status
    FROM contacts c
    LEFT JOIN recv r ON r.email = lower(c.email)
    WHERE c.client_id = p_client
      AND coalesce(c.engagement_status,'active') IN ('active','cold')
  )
  UPDATE contacts c SET engagement_status = cl.new_status
  FROM classified cl
  WHERE c.id = cl.id AND coalesce(c.engagement_status,'active') <> cl.new_status;

  RETURN reengagement_health(p_client);
END $$;

-- 5. Run the classifier for every enabled client (daily cron entry point).
CREATE OR REPLACE FUNCTION reengagement_classify_all()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT client_id FROM reengagement_config WHERE enabled LOOP
    PERFORM reengagement_classify(r.client_id);
  END LOOP;
END $$;
