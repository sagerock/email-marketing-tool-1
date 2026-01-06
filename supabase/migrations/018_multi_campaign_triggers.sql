-- Add array column for multiple Salesforce Campaign triggers
ALTER TABLE email_sequences
  ADD COLUMN trigger_salesforce_campaign_ids UUID[] DEFAULT '{}';

-- Migrate existing single campaign ID to new array column
UPDATE email_sequences
SET trigger_salesforce_campaign_ids = ARRAY[trigger_salesforce_campaign_id]
WHERE trigger_salesforce_campaign_id IS NOT NULL;

-- Create index for array contains queries
CREATE INDEX idx_sequences_trigger_campaign_ids ON email_sequences USING GIN (trigger_salesforce_campaign_ids);
