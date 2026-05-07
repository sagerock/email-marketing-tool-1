-- Add a per-client "brand reference" template that the AI Email Builder
-- always injects as style context, so generated emails match the client's
-- current brand without the user having to paperclip a reference each time.
-- ON DELETE SET NULL so deleting the referenced template doesn't cascade.

ALTER TABLE clients
  ADD COLUMN brand_reference_template_id uuid
  REFERENCES templates(id) ON DELETE SET NULL;
