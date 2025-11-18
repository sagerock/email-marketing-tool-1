-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Clients table (for multi-client support)
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  sendgrid_api_key TEXT NOT NULL,
  ip_pools TEXT[], -- Array of available IP pool names
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Contacts table
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  tags TEXT[] DEFAULT '{}', -- Array of tags
  custom_fields JSONB DEFAULT '{}', -- Additional custom fields
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(email, client_id)
);

-- Templates table
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  preview_text TEXT,
  thumbnail TEXT, -- URL or base64 thumbnail
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Campaigns table
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT NOT NULL,
  reply_to TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  recipient_count INTEGER DEFAULT 0,
  filter_tags TEXT[], -- Tags used to filter recipients
  ip_pool TEXT, -- SendGrid IP pool name
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Analytics events table (from SendGrid webhooks)
CREATE TABLE analytics_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe')),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  url TEXT, -- For click events
  user_agent TEXT,
  ip_address TEXT,
  sg_event_id TEXT UNIQUE, -- SendGrid event ID to prevent duplicates
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_tags ON contacts USING GIN(tags);
CREATE INDEX idx_contacts_client_id ON contacts(client_id);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_client_id ON campaigns(client_id);
CREATE INDEX idx_analytics_campaign_id ON analytics_events(campaign_id);
CREATE INDEX idx_analytics_event_type ON analytics_events(event_type);
CREATE INDEX idx_analytics_timestamp ON analytics_events(timestamp);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_templates_updated_at BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Create policies (basic - can be enhanced with auth)
-- For now, allow all operations (you'll want to restrict this based on your auth setup)
CREATE POLICY "Allow all operations on clients" ON clients FOR ALL USING (true);
CREATE POLICY "Allow all operations on contacts" ON contacts FOR ALL USING (true);
CREATE POLICY "Allow all operations on templates" ON templates FOR ALL USING (true);
CREATE POLICY "Allow all operations on campaigns" ON campaigns FOR ALL USING (true);
CREATE POLICY "Allow all operations on analytics_events" ON analytics_events FOR ALL USING (true);
