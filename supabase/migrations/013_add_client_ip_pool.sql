-- Add ip_pool column to clients table for SendGrid IP pool routing
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ip_pool TEXT;

-- Comment explaining the field
COMMENT ON COLUMN clients.ip_pool IS 'SendGrid IP pool name for routing emails from this client';
