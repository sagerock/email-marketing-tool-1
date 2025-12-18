-- Add Salesforce OAuth fields to clients table for direct integration

-- Salesforce instance URL (e.g., https://yourorg.my.salesforce.com)
ALTER TABLE clients ADD COLUMN salesforce_instance_url TEXT;

-- OAuth tokens (encrypted in production, stored as-is for now)
ALTER TABLE clients ADD COLUMN salesforce_access_token TEXT;
ALTER TABLE clients ADD COLUMN salesforce_refresh_token TEXT;

-- Connection metadata
ALTER TABLE clients ADD COLUMN salesforce_connected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE clients ADD COLUMN salesforce_connected_by TEXT; -- user email who connected

-- Sync tracking
ALTER TABLE clients ADD COLUMN last_salesforce_sync TIMESTAMP WITH TIME ZONE;
ALTER TABLE clients ADD COLUMN salesforce_sync_status TEXT CHECK (salesforce_sync_status IN ('idle', 'syncing', 'success', 'error'));
ALTER TABLE clients ADD COLUMN salesforce_sync_message TEXT; -- last sync result or error message
ALTER TABLE clients ADD COLUMN salesforce_sync_count INTEGER; -- contacts synced in last run
