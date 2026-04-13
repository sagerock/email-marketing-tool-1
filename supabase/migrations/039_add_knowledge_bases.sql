-- Knowledge bases for AI email bots
-- Stores editable content that AI uses to answer questions and generate emails

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_knowledge_bases_client_id ON knowledge_bases(client_id);
CREATE INDEX idx_knowledge_bases_active ON knowledge_bases(client_id, is_active) WHERE is_active = true;

-- RLS policies
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on knowledge_bases"
  ON knowledge_bases
  FOR ALL
  USING (true)
  WITH CHECK (true);
