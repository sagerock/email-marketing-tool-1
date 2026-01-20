-- Fix: Partial indexes don't work with ON CONFLICT upsert
-- Need a regular unique constraint instead

-- Drop the partial index (doesn't work with upsert)
DROP INDEX IF EXISTS scheduled_emails_enrollment_step_pending_unique;

-- Clean up any existing duplicates (keep the oldest one based on status priority: pending > sent > others)
-- First delete duplicate pending where a sent version exists
DELETE FROM scheduled_emails a
USING scheduled_emails b
WHERE a.enrollment_id = b.enrollment_id
  AND a.step_id = b.step_id
  AND a.id != b.id
  AND a.status = 'pending'
  AND b.status = 'sent';

-- Then delete newer duplicates of same status (keep oldest)
DELETE FROM scheduled_emails a
USING scheduled_emails b
WHERE a.enrollment_id = b.enrollment_id
  AND a.step_id = b.step_id
  AND a.id != b.id
  AND a.created_at > b.created_at;

-- Add regular unique constraint that works with ON CONFLICT
ALTER TABLE scheduled_emails
ADD CONSTRAINT scheduled_emails_enrollment_step_unique
UNIQUE (enrollment_id, step_id);
