-- 061_add_cc_mirror.sql
-- Phase 1 of pulling Constant Contact in live: a read-only MIRROR of CfA's
-- Constant Contact contacts and lists, plus a durable OAuth token store so a
-- Railway cron can run the nightly sync.
--
-- IMPORTANT: these cc_* tables are a reflection of Constant Contact ONLY. They
-- are deliberately separate from `contacts` and are NEVER a sending source.
-- CC's list is ~12.7k people but mostly implicit/unsubscribed with a ~20% bounce
-- rate; merging it into the live send list would recreate exactly the over-mail
-- problem this work is meant to expose. Identity resolution into the real
-- `contacts`/people view is Phase 2, not here.

-- The mirror of CC contacts.
CREATE TABLE IF NOT EXISTS cc_contacts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  cc_contact_id  TEXT NOT NULL,                 -- Constant Contact's contact_id
  email          TEXT,
  first_name     TEXT,
  last_name      TEXT,
  permission     TEXT,                          -- explicit | implicit | unsubscribed | pending
  opt_in_source  TEXT,
  opt_in_date    TIMESTAMPTZ,
  opt_out_date   TIMESTAMPTZ,
  created_at_cc  TIMESTAMPTZ,
  updated_at_cc  TIMESTAMPTZ,                    -- drives the incremental watermark
  custom_fields  JSONB,
  raw            JSONB,                          -- full CC payload for anything not column-ized
  synced_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, cc_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_contacts_client_email
  ON cc_contacts (client_id, email);
CREATE INDEX IF NOT EXISTS idx_cc_contacts_client_updated
  ON cc_contacts (client_id, updated_at_cc);

-- The CC lists themselves (so "who is on Center & Periphery Newsletter" stays
-- answerable by name, not just by opaque list_id).
CREATE TABLE IF NOT EXISTS cc_lists (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  cc_list_id    TEXT NOT NULL,
  name          TEXT,
  member_count  INTEGER,
  raw           JSONB,
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, cc_list_id)
);

-- Which contact is on which list. Refreshed per-contact (delete-then-insert) so
-- removals are reflected, not just additions.
CREATE TABLE IF NOT EXISTS cc_list_memberships (
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  cc_contact_id  TEXT NOT NULL,
  cc_list_id     TEXT NOT NULL,
  UNIQUE (client_id, cc_contact_id, cc_list_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_list_memberships_list
  ON cc_list_memberships (client_id, cc_list_id);

-- Durable OAuth token store + incremental watermark, one row per client.
-- CC access tokens last ~2h and the refresh token ROTATES on every refresh, so
-- the pair has to live somewhere writable (not an env var) for the cron to use.
CREATE TABLE IF NOT EXISTS cc_sync_state (
  client_id          UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  access_token       TEXT,
  refresh_token      TEXT,
  token_expires_at   TIMESTAMPTZ,
  updated_watermark  TIMESTAMPTZ,   -- max(updated_at_cc) seen; next run pulls updated_after this
  last_run_at        TIMESTAMPTZ,
  last_run_status    TEXT
);

ALTER TABLE cc_contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cc_lists             ENABLE ROW LEVEL SECURITY;
ALTER TABLE cc_list_memberships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cc_sync_state        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on cc_contacts"
  ON cc_contacts FOR ALL USING (true);
CREATE POLICY "Allow all operations on cc_lists"
  ON cc_lists FOR ALL USING (true);
CREATE POLICY "Allow all operations on cc_list_memberships"
  ON cc_list_memberships FOR ALL USING (true);
CREATE POLICY "Allow all operations on cc_sync_state"
  ON cc_sync_state FOR ALL USING (true);
