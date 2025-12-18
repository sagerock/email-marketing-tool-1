-- Add source_code_history field for Salesforce sync
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_code_history TEXT;

-- Index for filtering by source code history
CREATE INDEX IF NOT EXISTS idx_contacts_source_code_history ON contacts(source_code_history);
