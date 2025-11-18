-- Add unsubscribe fields to contacts table
ALTER TABLE contacts
ADD COLUMN unsubscribed BOOLEAN DEFAULT FALSE,
ADD COLUMN unsubscribed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN unsubscribe_token TEXT UNIQUE;

-- Create index for unsubscribe_token lookups
CREATE INDEX idx_contacts_unsubscribe_token ON contacts(unsubscribe_token);
CREATE INDEX idx_contacts_unsubscribed ON contacts(unsubscribed);

-- Function to generate unsubscribe token
CREATE OR REPLACE FUNCTION generate_unsubscribe_token()
RETURNS TRIGGER AS $$
BEGIN
  -- Only generate token if it doesn't exist
  IF NEW.unsubscribe_token IS NULL THEN
    NEW.unsubscribe_token = encode(gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-generate unsubscribe tokens for new contacts
CREATE TRIGGER generate_contact_unsubscribe_token
BEFORE INSERT ON contacts
FOR EACH ROW
EXECUTE FUNCTION generate_unsubscribe_token();

-- Backfill unsubscribe tokens for existing contacts
UPDATE contacts
SET unsubscribe_token = encode(gen_random_bytes(32), 'hex')
WHERE unsubscribe_token IS NULL;
