ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_contact_type ON contacts(contact_type);
