-- Add salesforce_campaign_id to campaigns for merge tag support
ALTER TABLE campaigns
  ADD COLUMN salesforce_campaign_id UUID REFERENCES salesforce_campaigns(id) ON DELETE SET NULL;

-- Index for performance
CREATE INDEX idx_campaigns_salesforce_campaign_id ON campaigns(salesforce_campaign_id);
