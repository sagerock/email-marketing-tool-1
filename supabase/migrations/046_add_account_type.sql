-- Add Account.Type from Salesforce so the dealer audience can be filtered at
-- the Account (company) level, not just the Contact level. Contact-level
-- Type__c is unreliably maintained for dealer-affiliated people (only ~43%
-- of contacts at Dealer Accounts are personally flagged Dealer), so the
-- audience filter combines both signals.
--
-- The "Dealers" (plural) picklist value is normalized to "Dealer" at sync
-- time, so this column should only ever contain Customer/Dealer/Partner/etc.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS account_type TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_account_type ON contacts(account_type);
