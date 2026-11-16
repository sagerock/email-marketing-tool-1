-- 124_sr_mail_sync.sql
--
-- Everything reaches the CRM automatically (Sage, 2026-11-16: "Everything should absolutely automatically get put
-- into the CRM so that we know where people are"). Ask's crm_mail_sync job (ask jobs/_custom/sagerock/
-- crm_mail_sync.py, every 15 minutes) writes:
--   - one sr_outreach row per email in Ask's email_log between a Jax mailbox and a CRM person or org
--     (body_ref 'ask:email_log:<id>', gmail_thread_id NULL; lead-sync keeps doing sage@/rocky@ Gmail threads);
--   - SendGrid bounces, blocks and invalid addresses onto the person (bounced_at / bounce_reason), plus a row on
--     the org's timeline (outcome 'bounced', body_ref 'sendgrid:<list>:<email>:<created>').
-- Additive only.
--
-- Undo (destructive, only on Sage's word): DROP INDEX sr_outreach_org_body_ref_uniq; drop the two columns.

ALTER TABLE public.sr_people
  ADD COLUMN IF NOT EXISTS bounced_at    timestamptz,
  ADD COLUMN IF NOT EXISTS bounce_reason text;

COMMENT ON COLUMN public.sr_people.bounced_at IS
  'SendGrid reported a bounce, block or invalid address. Outreach senders skip this address.';

-- One timeline row per email per org: the sync, outreach/neo-schools/send.py and the import backfill all write
-- body_ref 'ask:email_log:<id>' and upsert on this pair, so none of them duplicates another.
CREATE UNIQUE INDEX IF NOT EXISTS sr_outreach_org_body_ref_uniq
  ON public.sr_outreach (org_id, body_ref);
