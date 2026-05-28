-- 056_create_media_library.sql
-- Adds per-client S3 prefix and the discovered-URLs cache table for the media library.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS s3_prefix TEXT;

CREATE TABLE IF NOT EXISTS discovered_media_urls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT,
  first_seen_in TEXT,
  last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, url)
);

CREATE INDEX IF NOT EXISTS idx_discovered_media_urls_client
  ON discovered_media_urls (client_id);

ALTER TABLE discovered_media_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on discovered_media_urls"
  ON discovered_media_urls FOR ALL USING (true);
