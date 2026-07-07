-- Add auto_send flag to AI follow-up agents.
-- When true, drafts are sent immediately upon generation instead of
-- waiting in the approval queue. If the immediate send fails, the draft
-- stays 'pending' and falls back to the manual queue.
ALTER TABLE ai_followup_config
  ADD COLUMN IF NOT EXISTS auto_send boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN ai_followup_config.auto_send IS
  'Send drafts immediately on generation (skip the approval queue). Failed sends fall back to pending.';
