-- Add Salesforce integration fields to contacts table

-- Salesforce ID for syncing (works for both Leads and Contacts)
ALTER TABLE contacts ADD COLUMN salesforce_id TEXT;

-- Record type to distinguish between Leads and Contacts
ALTER TABLE contacts ADD COLUMN record_type TEXT CHECK (record_type IN ('lead', 'contact'));

-- Company name
ALTER TABLE contacts ADD COLUMN company TEXT;

-- Source code (normalized from Salesforce "Source Code" and "Source code")
ALTER TABLE contacts ADD COLUMN source_code TEXT;

-- Industry classification
ALTER TABLE contacts ADD COLUMN industry TEXT;

-- Index for Salesforce ID lookups and upserts
CREATE UNIQUE INDEX idx_contacts_salesforce_id ON contacts(salesforce_id) WHERE salesforce_id IS NOT NULL;

-- Indexes for common filtering/segmentation
CREATE INDEX idx_contacts_record_type ON contacts(record_type);
CREATE INDEX idx_contacts_source_code ON contacts(source_code);
CREATE INDEX idx_contacts_industry ON contacts(industry);
