ALTER FUNCTION public.count_campaign_recipients(uuid, text[], uuid, text[], jsonb, boolean)
  SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.count_campaign_recipients(uuid, text[], uuid, text[], jsonb, boolean)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.count_campaign_recipients(uuid, text[], uuid, text[], jsonb, boolean)
  TO authenticated, service_role;
