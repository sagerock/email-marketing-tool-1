-- 105: weekly bounce report (data cleanup for the client's Salesforce).
--
-- Stacy (Alconox, 2026-09-29) wants bad addresses cleaned as they happen. Each
-- Monday the scheduler emails the week's new hard bounces. The report checks
-- whether the domain exists (DNS, in the app), whether the same person is
-- already on file at another domain, and, for domains that don't exist, which
-- delivering domain on the list the typo was probably meant to be.

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS bounce_report_config (
  client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  recipients text[] NOT NULL DEFAULT '{}',
  cc text[] NOT NULL DEFAULT '{}',
  days integer NOT NULL DEFAULT 7 CHECK (days BETWEEN 1 AND 60),
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bounce_report_config ENABLE ROW LEVEL SECURITY;

-- Superseded draft of this migration (never used by released code).
DROP FUNCTION IF EXISTS bounce_report_domain_counts(uuid, integer);

-- For each bounced domain, delivering domains on the client's list within two
-- edits, with how many good contacts each has.
CREATE OR REPLACE FUNCTION bounce_report_domain_candidates(p_client_id uuid, p_domains text[])
RETURNS TABLE (bounced text, candidate text, n bigint, dist integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  WITH good AS (
    SELECT lower(split_part(email, '@', 2)) AS domain, count(*) AS n
      FROM contacts
     WHERE client_id = p_client_id
       AND coalesce(bounce_status, 'none') <> 'hard'
       AND position('@' in coalesce(email, '')) > 0
     GROUP BY 1
  ), wanted AS (SELECT DISTINCT lower(d) AS domain FROM unnest(p_domains) d)
  SELECT w.domain, g.domain, g.n, levenshtein(w.domain, g.domain)
    FROM wanted w JOIN good g
      ON g.domain <> w.domain
     AND abs(length(g.domain) - length(w.domain)) <= 2
     AND levenshtein(w.domain, g.domain) <= 2;
$$;
REVOKE ALL ON FUNCTION bounce_report_domain_candidates(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bounce_report_domain_candidates(uuid, text[]) TO service_role;
