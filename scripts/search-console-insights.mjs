// Local, read-only operational summary for the Search Console warehouse.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const rawDays = process.argv.find(arg => arg.startsWith('--days='))?.slice(7) || '90'
const days = Number.parseInt(rawDays, 10)
if (!Number.isInteger(days) || days < 1 || days > 500) throw new Error('--days must be between 1 and 500')

const projectRef = new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(
  path.join(os.homedir(), '.supabase/access-token'),
  'utf8',
).trim()

const sql = `
WITH target AS (
  SELECT id AS client_id
  FROM public.clients
  WHERE name = 'Center for Orthopedics'
), latest AS (
  SELECT max(data_date) AS max_date
  FROM public.search_console_site_daily s
  JOIN target t USING (client_id)
), period AS (
  SELECT max_date - (${days} - 1) AS start_date, max_date AS end_date FROM latest
), totals AS (
  SELECT
    sum(clicks)::bigint AS clicks,
    sum(impressions)::bigint AS impressions,
    CASE WHEN sum(impressions) = 0 THEN 0 ELSE sum(clicks) / sum(impressions) END AS ctr,
    CASE WHEN sum(impressions) = 0 THEN 0 ELSE sum(position * impressions) / sum(impressions) END AS position
  FROM public.search_console_site_daily s
  JOIN target t USING (client_id)
  CROSS JOIN period p
  WHERE s.data_date BETWEEN p.start_date AND p.end_date
), query_rollup AS (
  SELECT
    query,
    sum(clicks)::bigint AS clicks,
    sum(impressions)::bigint AS impressions,
    CASE WHEN sum(impressions) = 0 THEN 0 ELSE sum(clicks) / sum(impressions) END AS ctr,
    CASE WHEN sum(impressions) = 0 THEN 0 ELSE sum(position * impressions) / sum(impressions) END AS position
  FROM public.search_console_query_page_daily d
  JOIN target t USING (client_id)
  CROSS JOIN period p
  WHERE d.data_date BETWEEN p.start_date AND p.end_date AND query <> ''
  GROUP BY query
), opportunities AS (
  SELECT *
  FROM query_rollup
  WHERE impressions >= 100 AND position BETWEEN 3 AND 20
  ORDER BY impressions DESC, clicks DESC
  LIMIT 25
), shoulder AS (
  SELECT *
  FROM query_rollup
  WHERE query ILIKE '%shoulder%'
  ORDER BY impressions DESC, clicks DESC
  LIMIT 25
)
SELECT jsonb_build_object(
  'period', (SELECT to_jsonb(period) FROM period),
  'warehouse', (
    SELECT jsonb_build_object(
      'daily_rows', count(*),
      'first_date', min(data_date),
      'last_date', max(data_date)
    )
    FROM public.search_console_site_daily s JOIN target t USING (client_id)
  ),
  'totals', (SELECT to_jsonb(totals) FROM totals),
  'opportunities', COALESCE((SELECT jsonb_agg(to_jsonb(opportunities)) FROM opportunities), '[]'::jsonb),
  'shoulder_queries', COALESCE((SELECT jsonb_agg(to_jsonb(shoulder)) FROM shoulder), '[]'::jsonb)
) AS report;
`

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
  signal: AbortSignal.timeout(60000),
})
const result = await response.json()
if (!response.ok) throw new Error(`Report query failed (${response.status}): ${result.message || 'See provider logs'}`)
console.log(JSON.stringify(result[0].report, null, 2))
