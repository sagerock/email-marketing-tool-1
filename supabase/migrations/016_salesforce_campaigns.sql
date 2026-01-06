-- Salesforce Campaigns table - stores synced Campaign records
CREATE TABLE salesforce_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesforce_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,                    -- e.g., "Tradeshow", "Webinar", "Conference"
  status TEXT,                  -- e.g., "Planned", "In Progress", "Completed"
  start_date TIMESTAMP WITH TIME ZONE,
  end_date TIMESTAMP WITH TIME ZONE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(salesforce_id, client_id)
);

-- Salesforce Campaign Members - links contacts to campaigns
CREATE TABLE salesforce_campaign_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesforce_id TEXT NOT NULL,         -- CampaignMember ID from Salesforce
  salesforce_campaign_id UUID REFERENCES salesforce_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT,                          -- e.g., "Sent", "Responded"
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(salesforce_id, client_id)
);

-- Industry Links - maps industry to URL for dynamic email content
CREATE TABLE industry_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  industry TEXT NOT NULL,
  link_url TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(industry, client_id)
);

-- Add trigger_campaign_id to sequence_enrollments to track what triggered the enrollment
ALTER TABLE sequence_enrollments
  ADD COLUMN trigger_campaign_id UUID REFERENCES salesforce_campaigns(id) ON DELETE SET NULL;

-- Add trigger_salesforce_campaign_id to automation_sequences for campaign-based triggers
ALTER TABLE automation_sequences
  ADD COLUMN trigger_salesforce_campaign_id UUID REFERENCES salesforce_campaigns(id) ON DELETE SET NULL;

-- Indexes for performance
CREATE INDEX idx_salesforce_campaigns_client_id ON salesforce_campaigns(client_id);
CREATE INDEX idx_salesforce_campaigns_salesforce_id ON salesforce_campaigns(salesforce_id);
CREATE INDEX idx_salesforce_campaign_members_client_id ON salesforce_campaign_members(client_id);
CREATE INDEX idx_salesforce_campaign_members_campaign_id ON salesforce_campaign_members(salesforce_campaign_id);
CREATE INDEX idx_salesforce_campaign_members_contact_id ON salesforce_campaign_members(contact_id);
CREATE INDEX idx_industry_links_client_id ON industry_links(client_id);
CREATE INDEX idx_sequence_enrollments_trigger_campaign ON sequence_enrollments(trigger_campaign_id);

-- Enable RLS
ALTER TABLE salesforce_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE salesforce_campaign_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on salesforce_campaigns" ON salesforce_campaigns FOR ALL USING (true);
CREATE POLICY "Allow all operations on salesforce_campaign_members" ON salesforce_campaign_members FOR ALL USING (true);
CREATE POLICY "Allow all operations on industry_links" ON industry_links FOR ALL USING (true);

-- Add updated_at triggers
CREATE TRIGGER update_salesforce_campaigns_updated_at BEFORE UPDATE ON salesforce_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_industry_links_updated_at BEFORE UPDATE ON industry_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
