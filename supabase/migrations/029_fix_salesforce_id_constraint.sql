-- Fix: Replace partial unique index on salesforce_id with a proper UNIQUE constraint.
-- The partial index (WHERE salesforce_id IS NOT NULL) cannot be targeted by
-- Supabase's onConflict, causing batch upserts to silently fail when a contact's
-- email changes in Salesforce.
-- PostgreSQL UNIQUE constraints allow multiple NULLs, so contacts without a
-- salesforce_id won't conflict.

DROP INDEX IF EXISTS idx_contacts_salesforce_id;
ALTER TABLE contacts ADD CONSTRAINT contacts_salesforce_id_unique UNIQUE (salesforce_id);
