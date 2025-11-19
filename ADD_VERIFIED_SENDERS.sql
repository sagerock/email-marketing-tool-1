-- ============================================================================
-- ADD VERIFIED SENDERS TO CLIENTS TABLE
-- Copy and paste this into Supabase SQL Editor
-- Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new
-- ============================================================================

ALTER TABLE clients ADD COLUMN IF NOT EXISTS verified_senders JSONB DEFAULT '[]'::jsonb;

-- Done! Now refresh your app and you can add verified senders in Settings.
