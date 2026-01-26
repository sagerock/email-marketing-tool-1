-- Add 'block' to the allowed event types in analytics_events table
-- Blocks occur when SendGrid cannot deliver due to ISP blocklists, etc.

-- Drop the existing constraint
ALTER TABLE analytics_events DROP CONSTRAINT IF EXISTS analytics_events_event_type_check;

-- Add the new constraint with 'block' included
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_event_type_check
  CHECK (event_type IN ('delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe', 'block'));

-- Also update sequence_analytics if it has the same constraint
ALTER TABLE sequence_analytics DROP CONSTRAINT IF EXISTS sequence_analytics_event_type_check;

ALTER TABLE sequence_analytics ADD CONSTRAINT sequence_analytics_event_type_check
  CHECK (event_type IN ('delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe', 'block'));
