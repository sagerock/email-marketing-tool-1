CREATE INDEX IF NOT EXISTS idx_contacts_suppression_keyset
  ON public.contacts (client_id, id)
  WHERE unsubscribed = true OR bounce_status = 'hard';
