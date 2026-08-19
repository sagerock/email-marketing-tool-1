-- Schema-qualify pgcrypto in the unsubscribe-token trigger.
--
-- The unqualified gen_random_bytes() breaks whenever a SECURITY DEFINER
-- function with an emptied search_path inserts a contact — discovered
-- 2026-08-19 when CfA's cfa_complete_registration (cfa-site repo) failed for
-- every brand-new registrant. A search_path pin was applied live that day as
-- a stopgap; this migration makes the fix durable in the owning repo, and
-- restates the pin so any future CREATE OR REPLACE keeps it.
-- Context: /mnt/d/dev/ai-collab/2026-08-19-starlight-coupon-live-registration.md
-- (review finding 5). Already applied to production 2026-08-19.

CREATE OR REPLACE FUNCTION generate_unsubscribe_token()
RETURNS TRIGGER AS $$
BEGIN
  -- Only generate token if it doesn't exist
  IF NEW.unsubscribe_token IS NULL THEN
    NEW.unsubscribe_token = encode(extensions.gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = extensions, public;
