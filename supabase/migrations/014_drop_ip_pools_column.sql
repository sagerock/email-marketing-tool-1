-- Drop the legacy ip_pools array column (replaced by ip_pool string)
ALTER TABLE clients DROP COLUMN IF EXISTS ip_pools;
