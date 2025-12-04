-- Create tags table to store unique tags per client
-- This allows fast tag listing without scanning all contacts

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  contact_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(name, client_id)
);

-- Index for fast lookups by client
CREATE INDEX idx_tags_client_id ON tags(client_id);

-- Index for sorting by contact count
CREATE INDEX idx_tags_contact_count ON tags(contact_count DESC);

-- Enable RLS
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

-- Allow all operations (same as other tables)
CREATE POLICY "Allow all operations on tags" ON tags FOR ALL USING (true);
