-- Add start_time column to email_sequences
-- This allows scheduling when the first email should be sent

ALTER TABLE email_sequences
ADD COLUMN start_time TIME;

COMMENT ON COLUMN email_sequences.start_time IS 'Preferred time of day to send the first email (HH:MM). NULL means send immediately.';
