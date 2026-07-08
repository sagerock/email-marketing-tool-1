-- Starter layouts for the AI Email Builder.
-- A "starter" is a proven, Outlook-hardened template a user can pick as the
-- basis for a new email (e.g. the Alconox Scoop monthly newsletter). Starters
-- are client-scoped like every other template; a client only sees its own.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS is_starter boolean NOT NULL DEFAULT false;

-- Partial index: the builder only ever queries the (small) set of starters.
CREATE INDEX IF NOT EXISTS idx_templates_is_starter
  ON templates (client_id)
  WHERE is_starter = true;
