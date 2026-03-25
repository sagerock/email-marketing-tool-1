-- Migration: Add AI Follow-up Agent System
-- Supports multiple AI agents per client, each triggered by a tag,
-- with human approval queue and optional Salesforce logging.

-- AI agent configurations (multiple per client)
CREATE TABLE ai_followup_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  enabled BOOLEAN DEFAULT false,
  trigger_tag VARCHAR(255) NOT NULL DEFAULT 'Sample Request',
  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(255) NOT NULL,
  reply_to VARCHAR(255),
  max_followups INTEGER DEFAULT 3,
  followup_delays INTEGER[] DEFAULT '{1,3,7}',
  system_prompt TEXT,
  log_to_salesforce BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Contacts enrolled in AI follow-up pipelines
CREATE TABLE ai_followup_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES ai_followup_config(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'opted_out')),
  current_step INTEGER DEFAULT 0,
  enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  last_email_sent_at TIMESTAMP WITH TIME ZONE,
  next_followup_at TIMESTAMP WITH TIME ZONE,
  replied BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(config_id, contact_id)
);

-- AI-generated email drafts awaiting approval
CREATE TABLE ai_followup_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_contact_id UUID REFERENCES ai_followup_contacts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  config_id UUID NOT NULL REFERENCES ai_followup_config(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  subject VARCHAR(255),
  html_content TEXT,
  plain_text TEXT,
  ai_model VARCHAR(100),
  ai_prompt_context JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'failed')),
  reviewed_by UUID,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  sendgrid_message_id VARCHAR(255),
  salesforce_task_id VARCHAR(255),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_ai_config_client_id ON ai_followup_config(client_id);
CREATE INDEX idx_ai_config_enabled ON ai_followup_config(client_id, enabled) WHERE enabled = true;
CREATE INDEX idx_ai_contacts_config_id ON ai_followup_contacts(config_id);
CREATE INDEX idx_ai_contacts_client_id ON ai_followup_contacts(client_id);
CREATE INDEX idx_ai_contacts_status ON ai_followup_contacts(status);
CREATE INDEX idx_ai_contacts_next_followup ON ai_followup_contacts(next_followup_at) WHERE status = 'in_progress';
CREATE INDEX idx_ai_drafts_client_id ON ai_followup_drafts(client_id);
CREATE INDEX idx_ai_drafts_config_id ON ai_followup_drafts(config_id);
CREATE INDEX idx_ai_drafts_status ON ai_followup_drafts(status);
CREATE INDEX idx_ai_drafts_followup_contact ON ai_followup_drafts(followup_contact_id);

-- Enable RLS
ALTER TABLE ai_followup_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_followup_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_followup_drafts ENABLE ROW LEVEL SECURITY;

-- RLS policies (permissive - backend uses service key)
CREATE POLICY "Allow all for ai_followup_config" ON ai_followup_config FOR ALL USING (true);
CREATE POLICY "Allow all for ai_followup_contacts" ON ai_followup_contacts FOR ALL USING (true);
CREATE POLICY "Allow all for ai_followup_drafts" ON ai_followup_drafts FOR ALL USING (true);

-- Updated_at triggers
CREATE TRIGGER update_ai_followup_config_updated_at
  BEFORE UPDATE ON ai_followup_config
  FOR EACH ROW
  EXECUTE FUNCTION update_sequence_updated_at();

CREATE TRIGGER update_ai_followup_drafts_updated_at
  BEFORE UPDATE ON ai_followup_drafts
  FOR EACH ROW
  EXECUTE FUNCTION update_sequence_updated_at();
