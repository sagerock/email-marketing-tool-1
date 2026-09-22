-- Salesforce Prospect Activities (Alconox custom object Prospect_Activity__c).
-- One row per website touch that Alconox's site writes into Salesforce: member
-- resource downloads, AI chat, web forms, sample requests, and so on. Synced
-- read-only by api/salesforce-prospect-activities.js; writes are service-role only.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.salesforce_prospect_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  salesforce_id text NOT NULL,
  name text,                    -- PA-00000006
  channel text,                 -- Resource Download, AI Chat, Web Form, ...
  source_detail text,           -- which resource / form
  web_page text,
  touchpoint_at timestamptz,    -- Touchpoint_DateTime__c
  download_count integer,
  email text,                   -- Email__c, else resolved from the linked contact
  sf_lead_id text,
  sf_contact_id text,
  sf_account_id text,
  sf_campaign_id text,
  session_id text,
  sf_created_date timestamptz,
  sf_last_modified timestamptz,
  synced_at timestamptz DEFAULT now(),
  UNIQUE (client_id, salesforce_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_prospect_act_email
  ON public.salesforce_prospect_activities(client_id, email);
CREATE INDEX IF NOT EXISTS idx_sf_prospect_act_channel
  ON public.salesforce_prospect_activities(client_id, channel, touchpoint_at DESC);

ALTER TABLE public.salesforce_prospect_activities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salesforce_prospect_activities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.salesforce_prospect_activities TO authenticated;
GRANT ALL ON public.salesforce_prospect_activities TO service_role;

DROP POLICY IF EXISTS client_read ON public.salesforce_prospect_activities;
CREATE POLICY client_read ON public.salesforce_prospect_activities
  FOR SELECT TO authenticated USING (public.can_access_client(client_id));

COMMIT;
