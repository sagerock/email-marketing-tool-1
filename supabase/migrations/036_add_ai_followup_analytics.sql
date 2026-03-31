-- Migration 036: AI follow-up email analytics
-- Tracks SendGrid webhook events (opens, clicks, bounces, etc.) for AI-sent emails

CREATE TABLE ai_followup_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES ai_followup_drafts(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  url TEXT,
  user_agent TEXT,
  ip_address VARCHAR(45),
  sg_event_id VARCHAR(255) UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_ai_followup_analytics_draft_id ON ai_followup_analytics(draft_id);
CREATE INDEX idx_ai_followup_analytics_event_type ON ai_followup_analytics(event_type);
CREATE INDEX idx_ai_followup_analytics_email ON ai_followup_analytics(email);

ALTER TABLE ai_followup_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can select ai_followup_analytics" ON ai_followup_analytics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM ai_followup_drafts d
      WHERE d.id = ai_followup_analytics.draft_id
        AND can_access_client(d.client_id)
    )
  );

CREATE POLICY "Admins can insert ai_followup_analytics" ON ai_followup_analytics
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM ai_followup_drafts d
      WHERE d.id = ai_followup_analytics.draft_id
        AND can_access_client(d.client_id)
    )
  );
