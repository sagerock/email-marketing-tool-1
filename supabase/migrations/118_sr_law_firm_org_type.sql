-- 118_sr_law_firm_org_type.sql
--
-- Lawyers as a second outreach line (Sage, 2026-10-19). Concierge, the AI
-- practice-admin service built for Mindful Legacy, is offered to solo lawyers,
-- MetLife Legal Plans network attorneys first. Sage is the outreach person for
-- lawyers the way Rocky is for schools: he emails as usual, the Gmail sync logs
-- the threads. Law firms get their own org_type; `affiliation` carries the plan
-- network ('MetLife Legal Plans'), like 'AWSNA' does for schools.
-- Plan: sagerock-legal/docs/concierge-for-solo-attorneys-concept.md

ALTER TABLE public.sr_orgs DROP CONSTRAINT IF EXISTS sr_orgs_org_type_check;
ALTER TABLE public.sr_orgs ADD CONSTRAINT sr_orgs_org_type_check
  CHECK (org_type IN ('school','nonprofit','business','law_firm','other'));
