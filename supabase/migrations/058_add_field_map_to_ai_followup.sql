-- Map a webhook payload's field keys to our logical contact fields.
-- Gravity Forms sends field IDs (e.g. "2", "1.3", "16") rather than labels,
-- and they differ per form. field_map lets each agent declare which key holds
-- email / first_name / last_name / company / industry, e.g.
--   {"email":"2","first_name":"1.3","last_name":"1.6","company":"5","industry":"16"}
-- The webhook honors it, then falls back to common named keys (and an email
-- regex scan) when a mapping is absent.
ALTER TABLE ai_followup_config
  ADD COLUMN IF NOT EXISTS field_map JSONB DEFAULT '{}'::jsonb;
