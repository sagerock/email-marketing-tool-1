-- Add form submission storage to contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS form_submissions JSONB DEFAULT '[]';

-- Add webhook trigger support to AI followup configs
ALTER TABLE ai_followup_config
  ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(20) DEFAULT 'tag' CHECK (trigger_type IN ('tag', 'webhook')),
  ADD COLUMN IF NOT EXISTS webhook_key VARCHAR(64);

-- Unique index on webhook_key for fast lookup (only where not null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_config_webhook_key
  ON ai_followup_config(webhook_key) WHERE webhook_key IS NOT NULL;
