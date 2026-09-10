-- Migration 094: RSS "new post" auto-notifications
-- Lets any client be watched for new RSS/blog posts, auto-emailing an
-- excerpt + link to that client's active contacts through the existing
-- campaign send pipeline. Mirrors the Salesforce/WooCommerce sync-state
-- column convention on `clients`.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS rss_feed_url        text,
  ADD COLUMN IF NOT EXISTS last_rss_item_link  text,
  ADD COLUMN IF NOT EXISTS last_rss_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS rss_sync_status     text CHECK (rss_sync_status IN ('idle','syncing','success','error')),
  ADD COLUMN IF NOT EXISTS rss_sync_message    text;
