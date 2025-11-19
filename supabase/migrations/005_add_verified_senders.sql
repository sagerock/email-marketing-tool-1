-- Add verified_senders field to clients table for SendGrid sender verification
-- This stores a list of verified sender identities (email + name pairs)

ALTER TABLE clients
ADD COLUMN IF NOT EXISTS verified_senders JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN clients.verified_senders IS 'Array of verified sender identities. Each item has {email, name}. These must be verified in SendGrid before use.';

-- Example data structure:
-- [
--   {"email": "hello@example.com", "name": "Marketing Team"},
--   {"email": "support@example.com", "name": "Support Team"}
-- ]
