-- 123_sr_guide_import.sql
--
-- Northeast Ohio schools guide in the CRM (Sage, 2026-11-16). The guide at
-- openhouseforschools.com/neoschools lists ~540 schools and child care centers
-- with published contact addresses. Outreach that offers SageRock's work to
-- them goes from jax@sagerock.com and is tracked here, like the Waldorf
-- prospects, not in a Markdown log (openhouse-guide/AGENTS.md "Outreach sender").
--
-- Rows come from openhouse-guide/scripts/crm_import.py with
--   sr_orgs.source      = 'openhouse-guide'
--   sr_orgs.affiliation = 'NEO Schools Guide'   (how they cluster, like 'AWSNA')
-- and keep the guide's own id so the import is rerunnable and every org links
-- back to its public page. Additive only.
--
-- Undo (destructive, only on Sage's word): remove the imported rows with
--   DELETE FROM sr_orgs WHERE source = 'openhouse-guide';   (cascades to people)
-- then drop the three columns below.

ALTER TABLE public.sr_orgs
  ADD COLUMN IF NOT EXISTS guide_id   text,   -- openhouse-guide data/schools.csv guide_id (irn-... / lic-...)
  ADD COLUMN IF NOT EXISTS guide_kind text;   -- child_care_center, public_school, private_school, ...

CREATE UNIQUE INDEX IF NOT EXISTS sr_orgs_guide_id_uniq
  ON public.sr_orgs (guide_id) WHERE guide_id IS NOT NULL;

-- Free-mail addresses (gmail, yahoo, ...) are imported so the record is
-- complete, but outreach batches leave them out: a personal address is not the
-- school's published business contact.
ALTER TABLE public.sr_people
  ADD COLUMN IF NOT EXISTS free_mail boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sr_orgs.guide_id IS
  'Open House NEO schools guide id (openhouse-guide data/schools.csv). Set by scripts/crm_import.py.';
COMMENT ON COLUMN public.sr_people.free_mail IS
  'Address is at a free-mail provider. Imported, but left out of outreach batches.';
