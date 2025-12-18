-- Add Salesforce integration fields to clients table
-- Uses OAuth 2.0 Client Credentials Flow (server-to-server, no user interaction needed)

-- Salesforce instance URL (e.g., https://yourorg.my.salesforce.com)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_instance_url TEXT;

-- Client Credentials (from Connected App in Salesforce)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_client_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_client_secret TEXT;

-- Legacy OAuth tokens (kept for backwards compatibility, may be removed later)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_access_token TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_refresh_token TEXT;

-- Connection metadata
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_connected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_connected_by TEXT;

-- Sync tracking
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_salesforce_sync TIMESTAMP WITH TIME ZONE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_sync_status TEXT CHECK (salesforce_sync_status IN ('idle', 'syncing', 'success', 'error'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_sync_message TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS salesforce_sync_count INTEGER;
