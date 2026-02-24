-- Add campaign sync tracking fields to clients table
-- Mirrors the contact sync pattern from migration 010

ALTER TABLE clients ADD COLUMN IF NOT EXISTS campaign_sync_status TEXT CHECK (campaign_sync_status IN ('idle', 'syncing', 'success', 'error'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS campaign_sync_message TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_campaign_sync TIMESTAMPTZ;
