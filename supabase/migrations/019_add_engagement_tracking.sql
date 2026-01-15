-- Add bounce status and engagement tracking columns to contacts
ALTER TABLE contacts
ADD COLUMN IF NOT EXISTS bounce_status TEXT CHECK (bounce_status IN ('none', 'soft', 'hard')) DEFAULT 'none',
ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_bounce_campaign_id UUID REFERENCES campaigns(id),
ADD COLUMN IF NOT EXISTS engagement_score INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_opens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_clicks INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_engaged_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_contacts_bounce_status ON contacts(bounce_status);
CREATE INDEX IF NOT EXISTS idx_contacts_engagement_score ON contacts(engagement_score DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_email ON analytics_events(email);
