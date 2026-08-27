-- 082: Engagement view groundwork (2026-08-27)
--
-- Why: the client wants one place that answers "where did this person come from,
-- when, and when did anyone last touch them" — across our sends/opens/clicks/replies
-- AND what Salesforce knows. Salesforce won't show us activities (Task/Event/Case are
-- not visible to the integration user) but it does expose the rolled-up
-- LastActivityDate on Lead/Contact, Lead.Status, and the Opportunity (sample-request)
-- pipeline. This pulls those in next to our own engagement data.

-- 1. Salesforce rollups on contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS salesforce_last_activity_date date;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS salesforce_lead_status text;
-- last inbound reply we received (set by api/campaign-replies.js)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_replied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_contacts_sf_last_activity ON contacts(client_id, salesforce_last_activity_date);
CREATE INDEX IF NOT EXISTS idx_contacts_last_replied ON contacts(client_id, last_replied_at);

-- 2. Salesforce Opportunities (Alconox uses these for sample requests + deals)
CREATE TABLE IF NOT EXISTS salesforce_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  salesforce_id text NOT NULL,
  name text,
  stage text,
  is_closed boolean,
  is_won boolean,
  type text,
  source_code text,
  owner_name text,
  sf_contact_id text,          -- Opportunity.ContactId (Salesforce Id, joins contacts.salesforce_id)
  sf_account_id text,
  contact_email text,          -- Email__c on the opp when present, else resolved from contact
  amount numeric(14,2),
  sf_created_date timestamptz,
  close_date date,
  last_stage_change timestamptz,
  last_activity_date date,
  sample_shipped_at date,
  email_reply_date timestamptz,
  email_total_sent integer,
  email_total_opens integer,
  survey_completed boolean,
  raw jsonb,
  synced_at timestamptz DEFAULT now(),
  UNIQUE (client_id, salesforce_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_opps_contact ON salesforce_opportunities(client_id, sf_contact_id);
CREATE INDEX IF NOT EXISTS idx_sf_opps_email ON salesforce_opportunities(client_id, contact_email);
CREATE INDEX IF NOT EXISTS idx_sf_opps_open ON salesforce_opportunities(client_id, is_closed, stage);

ALTER TABLE salesforce_opportunities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Admins can select salesforce_opportunities" ON salesforce_opportunities
    FOR SELECT USING (can_access_client(client_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- writes are server-side (service role) only

-- 3. Resolve opp → contact email via contacts.salesforce_id when the opp carries no Email__c
CREATE OR REPLACE FUNCTION fill_opportunity_emails(p_client_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n integer;
BEGIN
  UPDATE salesforce_opportunities o
     SET contact_email = c.email
    FROM contacts c
   WHERE o.client_id = p_client_id
     AND o.contact_email IS NULL
     AND o.sf_contact_id IS NOT NULL
     AND c.client_id = o.client_id
     AND c.salesforce_id = o.sf_contact_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION fill_opportunity_emails(uuid) FROM anon, authenticated;
