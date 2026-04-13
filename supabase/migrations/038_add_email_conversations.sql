-- Email conversations table for tracking AI-generated email threads
-- Used by the public signup welcome email flow and future inbound reply processing

CREATE TABLE IF NOT EXISTS email_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  subject TEXT,
  body TEXT NOT NULL,
  ai_generated BOOLEAN DEFAULT false,
  escalated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_email_conversations_contact_id ON email_conversations(contact_id);
CREATE INDEX idx_email_conversations_client_id ON email_conversations(client_id);
CREATE INDEX idx_email_conversations_created_at ON email_conversations(created_at DESC);

-- RLS policies
ALTER TABLE email_conversations ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (backend API uses service key)
CREATE POLICY "Service role full access on email_conversations"
  ON email_conversations
  FOR ALL
  USING (true)
  WITH CHECK (true);
