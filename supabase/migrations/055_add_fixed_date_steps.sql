-- Migration 055: add fixed-date timing mode to sequence steps
-- timing_anchor: 'previous_step' (default, existing behavior) | 'fixed_date' (new)
-- fixed_send_at: the specific datetime to send (only used when timing_anchor = 'fixed_date')

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS timing_anchor TEXT NOT NULL DEFAULT 'previous_step'
    CHECK (timing_anchor IN ('previous_step', 'fixed_date')),
  ADD COLUMN IF NOT EXISTS fixed_send_at TIMESTAMPTZ;
