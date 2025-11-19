-- ============================================================================
-- ADD MAILING ADDRESS COLUMN TO CLIENTS TABLE
-- Copy and paste this into Supabase SQL Editor
-- Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new
-- ============================================================================

ALTER TABLE clients ADD COLUMN IF NOT EXISTS mailing_address TEXT;

-- Done! Now refresh your app and you can add mailing addresses in Settings.
