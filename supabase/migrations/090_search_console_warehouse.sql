BEGIN;

-- Center for Orthopedics is a reporting-only tenant until email sending is approved.
INSERT INTO public.clients (name, sendgrid_api_key, s3_prefix)
SELECT 'Center for Orthopedics', '', 'center-for-orthopedics'
WHERE NOT EXISTS (
  SELECT 1 FROM public.clients WHERE name = 'Center for Orthopedics'
);

CREATE TABLE IF NOT EXISTS public.search_console_integrations (
  client_id uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  site_url text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  search_types text[] NOT NULL DEFAULT ARRAY['web']::text[],
  backfill_start_date date,
  last_final_date date,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_console_integrations_status_check
    CHECK (last_sync_status IS NULL OR last_sync_status IN ('running', 'success', 'error'))
);

CREATE TABLE IF NOT EXISTS public.search_console_credentials (
  client_id uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  encrypted_credentials text NOT NULL,
  google_account_email text,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.search_console_site_daily (
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  data_date date NOT NULL,
  search_type text NOT NULL DEFAULT 'web',
  clicks double precision NOT NULL DEFAULT 0,
  impressions double precision NOT NULL DEFAULT 0,
  ctr double precision NOT NULL DEFAULT 0,
  position double precision NOT NULL DEFAULT 0,
  is_final boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, data_date, search_type)
);

CREATE TABLE IF NOT EXISTS public.search_console_query_page_daily (
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  data_date date NOT NULL,
  search_type text NOT NULL DEFAULT 'web',
  row_key text NOT NULL,
  query text NOT NULL DEFAULT '',
  page text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  device text NOT NULL DEFAULT '',
  clicks double precision NOT NULL DEFAULT 0,
  impressions double precision NOT NULL DEFAULT 0,
  ctr double precision NOT NULL DEFAULT 0,
  position double precision NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, data_date, search_type, row_key)
);

CREATE TABLE IF NOT EXISTS public.search_console_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  start_date date NOT NULL,
  end_date date NOT NULL,
  search_type text NOT NULL DEFAULT 'web',
  status text NOT NULL DEFAULT 'running',
  days_processed integer NOT NULL DEFAULT 0,
  detail_rows_processed integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT search_console_sync_runs_status_check
    CHECK (status IN ('running', 'success', 'error'))
);

CREATE INDEX IF NOT EXISTS search_console_site_daily_date_idx
  ON public.search_console_site_daily (client_id, data_date DESC);
CREATE INDEX IF NOT EXISTS search_console_detail_date_idx
  ON public.search_console_query_page_daily (client_id, data_date DESC);
CREATE INDEX IF NOT EXISTS search_console_detail_query_idx
  ON public.search_console_query_page_daily (client_id, query, data_date DESC);
CREATE INDEX IF NOT EXISTS search_console_detail_page_idx
  ON public.search_console_query_page_daily (client_id, page, data_date DESC);
CREATE INDEX IF NOT EXISTS search_console_sync_runs_started_idx
  ON public.search_console_sync_runs (client_id, started_at DESC);

DROP TRIGGER IF EXISTS update_search_console_integrations_updated_at
  ON public.search_console_integrations;
CREATE TRIGGER update_search_console_integrations_updated_at
  BEFORE UPDATE ON public.search_console_integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_search_console_credentials_updated_at
  ON public.search_console_credentials;
CREATE TRIGGER update_search_console_credentials_updated_at
  BEFORE UPDATE ON public.search_console_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.search_console_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_console_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_console_site_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_console_query_page_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_console_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Client users can read Search Console integrations"
  ON public.search_console_integrations FOR SELECT TO authenticated
  USING (public.can_access_client(client_id));
CREATE POLICY "Service role manages Search Console integrations"
  ON public.search_console_integrations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Deliberately no authenticated policy or grant for credential material.
CREATE POLICY "Service role manages Search Console credentials"
  ON public.search_console_credentials FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Client users can read Search Console site totals"
  ON public.search_console_site_daily FOR SELECT TO authenticated
  USING (public.can_access_client(client_id));
CREATE POLICY "Service role manages Search Console site totals"
  ON public.search_console_site_daily FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Client users can read Search Console details"
  ON public.search_console_query_page_daily FOR SELECT TO authenticated
  USING (public.can_access_client(client_id));
CREATE POLICY "Service role manages Search Console details"
  ON public.search_console_query_page_daily FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Client users can read Search Console sync runs"
  ON public.search_console_sync_runs FOR SELECT TO authenticated
  USING (public.can_access_client(client_id));
CREATE POLICY "Service role manages Search Console sync runs"
  ON public.search_console_sync_runs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT ON public.search_console_integrations TO authenticated;
GRANT SELECT ON public.search_console_site_daily TO authenticated;
GRANT SELECT ON public.search_console_query_page_daily TO authenticated;
GRANT SELECT ON public.search_console_sync_runs TO authenticated;
REVOKE ALL ON public.search_console_credentials FROM anon, authenticated;

GRANT ALL ON public.search_console_integrations TO service_role;
GRANT ALL ON public.search_console_credentials TO service_role;
GRANT ALL ON public.search_console_site_daily TO service_role;
GRANT ALL ON public.search_console_query_page_daily TO service_role;
GRANT ALL ON public.search_console_sync_runs TO service_role;

INSERT INTO public.search_console_integrations (
  client_id,
  site_url,
  search_types,
  backfill_start_date
)
SELECT
  id,
  'sc-domain:center4orthopedics.com',
  ARRAY['web']::text[],
  DATE '2025-05-08'
FROM public.clients
WHERE name = 'Center for Orthopedics'
ON CONFLICT (client_id) DO UPDATE SET
  site_url = EXCLUDED.site_url,
  search_types = EXCLUDED.search_types,
  backfill_start_date = COALESCE(public.search_console_integrations.backfill_start_date, EXCLUDED.backfill_start_date),
  updated_at = now();

COMMIT;
