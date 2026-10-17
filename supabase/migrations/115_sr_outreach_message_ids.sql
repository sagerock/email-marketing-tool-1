-- 115_sr_outreach_message_ids.sql
--
-- One conversation, one row (2026-10-17). sage@ and rocky@ see the same email
-- under different Gmail thread ids, so syncing both mailboxes counted Rocky's
-- cc'd follow-ups twice. Every email's RFC Message-ID is the same in both
-- mailboxes; the sync stores them and merges rows that share one.

ALTER TABLE public.sr_outreach
  ADD COLUMN IF NOT EXISTS rfc_message_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mailboxes       text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS sr_outreach_msgids_gin
  ON public.sr_outreach USING gin (rfc_message_ids);
