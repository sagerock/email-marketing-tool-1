-- Migration: Add Email Automation Sequences
-- This adds support for drip campaigns / automated email sequences

-- Enum for sequence status
CREATE TYPE sequence_status AS ENUM ('draft', 'active', 'paused', 'archived');

-- Enum for enrollment status
CREATE TYPE enrollment_status AS ENUM ('active', 'completed', 'paused', 'cancelled', 'failed');

-- Main sequences table
CREATE TABLE email_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status sequence_status DEFAULT 'draft',
  -- Trigger configuration
  trigger_type VARCHAR(50) DEFAULT 'manual', -- manual, tag_added, contact_created
  trigger_config JSONB DEFAULT '{}', -- e.g., {"tag": "new-lead"}
  -- Sender settings
  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(255) NOT NULL,
  reply_to VARCHAR(255),
  -- Targeting
  filter_tags TEXT[] DEFAULT '{}',
  -- Tracking
  total_enrolled INTEGER DEFAULT 0,
  total_completed INTEGER DEFAULT 0,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sequence steps (individual emails in the sequence)
CREATE TABLE sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL, -- 1, 2, 3...
  -- Email content
  subject VARCHAR(255) NOT NULL,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  html_content TEXT, -- Can use template or custom content
  -- Timing
  delay_days INTEGER DEFAULT 0, -- Days after previous step (or enrollment for first step)
  delay_hours INTEGER DEFAULT 0, -- Additional hours
  send_time TIME, -- Preferred send time (null = send immediately when due)
  -- Tracking
  sent_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(sequence_id, step_order)
);

-- Enrollments - tracks contacts in sequences
CREATE TABLE sequence_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status enrollment_status DEFAULT 'active',
  current_step INTEGER DEFAULT 0, -- 0 = not started, 1 = completed step 1, etc.
  enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  paused_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  last_email_sent_at TIMESTAMP WITH TIME ZONE,
  next_email_scheduled_at TIMESTAMP WITH TIME ZONE,
  -- Prevent duplicate enrollments
  UNIQUE(sequence_id, contact_id)
);

-- Scheduled emails queue
CREATE TABLE scheduled_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, sent, failed, cancelled
  sent_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sequence analytics events (separate from campaign analytics)
CREATE TABLE sequence_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL, -- delivered, open, click, bounce, spam, unsubscribe
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  url TEXT,
  user_agent TEXT,
  ip_address VARCHAR(45),
  sg_event_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_sequences_client_id ON email_sequences(client_id);
CREATE INDEX idx_sequences_status ON email_sequences(status);
CREATE INDEX idx_sequence_steps_sequence_id ON sequence_steps(sequence_id);
CREATE INDEX idx_enrollments_sequence_id ON sequence_enrollments(sequence_id);
CREATE INDEX idx_enrollments_contact_id ON sequence_enrollments(contact_id);
CREATE INDEX idx_enrollments_status ON sequence_enrollments(status);
CREATE INDEX idx_enrollments_next_email ON sequence_enrollments(next_email_scheduled_at) WHERE status = 'active';
CREATE INDEX idx_scheduled_emails_scheduled_for ON scheduled_emails(scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_scheduled_emails_enrollment_id ON scheduled_emails(enrollment_id);
CREATE INDEX idx_sequence_analytics_sequence_id ON sequence_analytics(sequence_id);
CREATE INDEX idx_sequence_analytics_step_id ON sequence_analytics(step_id);
CREATE INDEX idx_sequence_analytics_event_type ON sequence_analytics(event_type);

-- Enable RLS
ALTER TABLE email_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_analytics ENABLE ROW LEVEL SECURITY;

-- Basic RLS policies (similar to existing tables)
CREATE POLICY "Allow all for email_sequences" ON email_sequences FOR ALL USING (true);
CREATE POLICY "Allow all for sequence_steps" ON sequence_steps FOR ALL USING (true);
CREATE POLICY "Allow all for sequence_enrollments" ON sequence_enrollments FOR ALL USING (true);
CREATE POLICY "Allow all for scheduled_emails" ON scheduled_emails FOR ALL USING (true);
CREATE POLICY "Allow all for sequence_analytics" ON sequence_analytics FOR ALL USING (true);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_sequence_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_email_sequences_updated_at
  BEFORE UPDATE ON email_sequences
  FOR EACH ROW
  EXECUTE FUNCTION update_sequence_updated_at();

CREATE TRIGGER update_sequence_steps_updated_at
  BEFORE UPDATE ON sequence_steps
  FOR EACH ROW
  EXECUTE FUNCTION update_sequence_updated_at();
