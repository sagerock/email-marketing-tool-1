-- Trigger AI follow-up agents from synced Salesforce Prospect Activities
-- (member resource downloads) instead of the retired Gravity download forms.
--
-- ai_followup_config.trigger_download_resource
--   NULL  = agent is not fed by downloads (unchanged behaviour)
--   '*'   = catch-all: any Resource Download not matched by a specific agent
--   other = exact Source_Detail__c match, e.g. 'Aqueous Cleaning Handbook'
-- ai_followup_config.download_trigger_since
--   Cutover. Only activities whose touchpoint_at is after this timestamp
--   enroll; NULL keeps the trigger inert even when the resource is set.
--
-- salesforce_prospect_activities.followup_processed_at / _skip_reason /
-- _enrollment_id record the one-time decision per activity so re-syncs and
-- overlapping runs can never enroll the same download twice.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.ai_followup_config
  ADD COLUMN IF NOT EXISTS trigger_download_resource text,
  ADD COLUMN IF NOT EXISTS download_trigger_since timestamptz;

ALTER TABLE public.ai_followup_contacts
  ADD COLUMN IF NOT EXISTS source_activity_id uuid
    REFERENCES public.salesforce_prospect_activities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resource_url text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_followup_contacts_source_activity
  ON public.ai_followup_contacts (source_activity_id)
  WHERE source_activity_id IS NOT NULL;

ALTER TABLE public.salesforce_prospect_activities
  ADD COLUMN IF NOT EXISTS followup_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS followup_skip_reason text,
  ADD COLUMN IF NOT EXISTS followup_enrollment_id uuid
    REFERENCES public.ai_followup_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sf_prospect_act_followup_pending
  ON public.salesforce_prospect_activities (client_id, touchpoint_at)
  WHERE channel = 'Resource Download' AND followup_processed_at IS NULL;

-- Alconox: the Aqueous Cleaning Handbook has its own agent; every other
-- resource goes to the White Paper agent. download_trigger_since stays NULL
-- here on purpose; enabling is a separate, explicit step after the dry run.
UPDATE public.ai_followup_config
  SET trigger_download_resource = 'Aqueous Cleaning Handbook'
  WHERE id = '743a4aa9-92a6-4cf4-991a-2f973e9a05d4'
    AND trigger_download_resource IS NULL;
UPDATE public.ai_followup_config
  SET trigger_download_resource = '*'
  WHERE id = '30bca9c2-1479-4720-83c5-b0235d47d5cd'
    AND trigger_download_resource IS NULL;

COMMIT;
