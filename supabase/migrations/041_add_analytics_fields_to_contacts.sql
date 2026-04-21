ALTER TABLE contacts ADD COLUMN IF NOT EXISTS product_classification TEXT[];
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_converted BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS converted_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS job_function TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_product_classification ON contacts USING GIN(product_classification);
CREATE INDEX IF NOT EXISTS idx_contacts_state ON contacts(state);
CREATE INDEX IF NOT EXISTS idx_contacts_country ON contacts(country);
CREATE INDEX IF NOT EXISTS idx_contacts_job_function ON contacts(job_function);
CREATE INDEX IF NOT EXISTS idx_contacts_is_converted ON contacts(is_converted);
