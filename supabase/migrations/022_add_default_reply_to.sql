-- Add default reply-to email field for clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_reply_to_email TEXT;
COMMENT ON COLUMN clients.default_reply_to_email IS 'Default reply-to email for campaigns. Used to pre-populate campaign reply-to field.';
