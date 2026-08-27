-- 087: weekly engagement digest config (2026-08-27)
-- Per-client: who gets the Monday email, how many days back it looks, on/off.
-- Sent by api/engagement-digest.js (node-cron, Mondays 12:00 UTC = 8am ET).
-- Default recipients are internal until the client says yes; adding them is a row edit.

CREATE TABLE IF NOT EXISTS engagement_digest_config (
  client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  recipients text[] NOT NULL DEFAULT '{}',
  bcc text[] NOT NULL DEFAULT '{}',
  days int NOT NULL DEFAULT 14,
  subject_prefix text,
  last_sent_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE engagement_digest_config ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Admins can select engagement_digest_config" ON engagement_digest_config
    FOR SELECT USING (can_access_client(client_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Alconox: internal-only until Stacy opts in (then add stacy's address to recipients)
INSERT INTO engagement_digest_config (client_id, enabled, recipients, bcc, days, subject_prefix)
VALUES ('ea7f1422-2d20-4299-85a7-c1201e953409', true, ARRAY['sage@sagerock.com'], '{}', 14, 'Alconox, LLC')
ON CONFLICT (client_id) DO NOTHING;
