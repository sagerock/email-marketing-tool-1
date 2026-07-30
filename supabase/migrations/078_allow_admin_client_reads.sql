CREATE POLICY "Admins can view accessible clients"
  ON public.clients
  FOR SELECT
  TO authenticated
  USING (public.can_access_client(id));
