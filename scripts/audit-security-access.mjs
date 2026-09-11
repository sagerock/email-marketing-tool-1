// Read-only aggregate log review. Never prints message bodies, SQL statements,
// request parameters, tokens, IP addresses, user identities, or raw log events.
import fs from 'node:fs'
import os from 'node:os'
const token = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(`${os.homedir()}/.supabase/access-token`, 'utf8').trim()
const endArg = process.argv.find(a => a.startsWith('--end='))?.slice(6)
const end = endArg ? new Date(endArg) : new Date()
if (!Number.isFinite(end.getTime())) throw new Error('Invalid --end timestamp')
const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) || 7)
if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error('--days must be 1..7')
const targetTables = ['knowledge_bases','email_conversations','contact_notes','contact_tasks',
  'cc_contacts','cc_lists','cc_list_memberships','sync_runs','sync_health','discovered_media_urls']
const sql = `SELECT '[coverage]' AS path,'' AS method,'' AS status,'' AS role,
  count() AS requests,min(timestamp) AS first_seen,max(timestamp) AS last_seen
  FROM logs WHERE source='edge_logs'
UNION ALL
SELECT log_attributes['request.path'] AS path,
  log_attributes['request.method'] AS method,
  log_attributes['response.status_code'] AS status,
  coalesce(nullIf(log_attributes['request.sb.jwt.authorization.payload.role'],''),
    nullIf(log_attributes['request.sb.jwt.apikey.payload.role'],''),'unattributed') AS role,
  count() AS requests,min(timestamp) AS first_seen,max(timestamp) AS last_seen
  FROM logs WHERE source='edge_logs' AND
    (log_attributes['request.path'] LIKE '/rest/v1/rpc/%' OR
     log_attributes['request.path'] IN (${targetTables.map(t => `'/rest/v1/${t}'`).join(',')}))
  GROUP BY path,method,status,role LIMIT 300`
for (let day=days; day>0; day--) {
  const start = new Date(end.getTime()-day*86400000)
  const until = new Date(start.getTime()+86400000)
  const url = new URL('https://api.supabase.com/v1/projects/ckloewflialohuvixmvd/analytics/endpoints/logs')
  url.searchParams.set('iso_timestamp_start',start.toISOString())
  url.searchParams.set('iso_timestamp_end',until.toISOString())
  url.searchParams.set('sql',sql)
  const r = await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)})
  if (!r.ok) throw new Error(`Log request failed: HTTP ${r.status}; window ${start.toISOString()}`)
  const result = await r.json()
  if (result.error || !Array.isArray(result.result)) throw new Error('Log query failed; no clean-audit conclusion is possible')
  console.log(JSON.stringify({start:start.toISOString(),end:until.toISOString(),
    potentially_truncated:result.result.length>=300,aggregates:result.result}))
}
