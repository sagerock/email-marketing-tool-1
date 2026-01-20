-- Migration to prevent duplicate scheduled emails
-- This addresses a race condition where the same email could be scheduled multiple times

-- First, clean up any existing duplicates (keep the oldest one)
DELETE FROM scheduled_emails a
USING scheduled_emails b
WHERE a.enrollment_id = b.enrollment_id
  AND a.step_id = b.step_id
  AND a.status = 'pending'
  AND b.status = 'pending'
  AND a.created_at > b.created_at;

-- Add unique constraint to prevent duplicate pending emails for the same enrollment/step
-- Using a partial unique index so we only enforce uniqueness for pending emails
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_emails_enrollment_step_pending_unique
ON scheduled_emails (enrollment_id, step_id)
WHERE status = 'pending';

-- Add comment explaining the constraint
COMMENT ON INDEX scheduled_emails_enrollment_step_pending_unique IS
'Prevents duplicate pending emails for the same enrollment and step. Race condition fix.';
