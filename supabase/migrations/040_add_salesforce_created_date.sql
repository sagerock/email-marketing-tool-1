-- Add Salesforce CreatedDate to contacts for accurate new-customer-by-month analytics
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS salesforce_created_date TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_contacts_salesforce_created_date ON contacts(salesforce_created_date);
