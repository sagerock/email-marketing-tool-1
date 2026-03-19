-- Add send_breakdown JSONB column to campaigns for tracking recipient filtering
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_breakdown jsonb;
