-- Add unique constraints to prevent duplicate analytics events
-- Run AFTER the deduplicate-analytics.js script has cleaned up existing duplicates

-- Drop the old unique constraint on sg_event_id (it doesn't prevent logical duplicates)
ALTER TABLE analytics_events DROP CONSTRAINT IF EXISTS analytics_events_sg_event_id_key;

-- For delivered/bounce/spam/unsubscribe/block: one per email per campaign
-- Using partial unique index since different event types should allow same email
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique_delivery
ON analytics_events (campaign_id, email, event_type)
WHERE event_type IN ('delivered', 'bounce', 'spam', 'unsubscribe', 'block');

-- For opens: one per email per campaign
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique_open
ON analytics_events (campaign_id, email)
WHERE event_type = 'open';

-- For clicks: one per email per URL per campaign
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique_click
ON analytics_events (campaign_id, email, COALESCE(url, ''))
WHERE event_type = 'click';

-- Add index on email for faster lookups (if not exists)
CREATE INDEX IF NOT EXISTS idx_analytics_email ON analytics_events(email);
