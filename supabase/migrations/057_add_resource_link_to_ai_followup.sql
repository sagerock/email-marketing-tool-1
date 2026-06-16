-- Add opt-in resource-link injection to AI follow-up agents.
-- When true, the draft generator looks up the contact's approved industry_links
-- URL and passes it into the prompt as the ONLY URL the AI may reference.
-- Used by resource-nudge style agents (e.g. white-paper follow-up) so the AI
-- links a vetted page instead of inventing one. Defaults false so existing
-- agents (e.g. "Free Sample Follow-up") are unaffected.
ALTER TABLE ai_followup_config
  ADD COLUMN IF NOT EXISTS include_resource_link BOOLEAN DEFAULT false;
