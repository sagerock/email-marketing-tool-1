-- Store email addresses from failed send batches for investigation
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS failed_recipients JSONB DEFAULT '[]'::jsonb;
