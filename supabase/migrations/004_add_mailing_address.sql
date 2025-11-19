-- Add mailing_address field to clients table for CAN-SPAM compliance
-- CAN-SPAM requires a physical mailing address in all commercial emails

ALTER TABLE clients
ADD COLUMN IF NOT EXISTS mailing_address TEXT;

COMMENT ON COLUMN clients.mailing_address IS 'Physical mailing address for CAN-SPAM compliance. Required in all commercial emails.';
