-- 114_sr_partner_status.sql
--
-- Partners (Sage, 2026-10-17): people and firms who aren't buying from us but
-- can lead to clients, and whom we might help in return. Denese Giordano and
-- Vicki at Alma Partners are the first two. They sit in sr_orgs like any other
-- organization, with status 'partner', so the Gmail sync logs their threads and
-- the CRM can answer "who are our partners and when did we last talk".
--
-- sr_worklist already shows only orgs with an open finding, so partners never
-- appear there as cold-outreach targets.

ALTER TABLE public.sr_orgs DROP CONSTRAINT IF EXISTS sr_orgs_status_check;
ALTER TABLE public.sr_orgs ADD CONSTRAINT sr_orgs_status_check
  CHECK (status IN ('new','researching','ready','contacted','conversation',
                    'client','partner','dead','do_not_contact'));
