ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_filter TEXT[];

COMMENT ON COLUMN campaigns.audience_filter IS
  'Array of audience segments to send to: "lead", "customer", "dealer". NULL or empty means send to all (backwards-compatible default).';
