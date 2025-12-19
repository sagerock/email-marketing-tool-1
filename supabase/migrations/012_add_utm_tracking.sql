-- Add UTM tracking fields
ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_utm_params TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS utm_params TEXT;
