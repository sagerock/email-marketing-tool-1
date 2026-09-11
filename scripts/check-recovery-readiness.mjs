// Read-only inventory, never an export or a production restore.
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function summarizeBackups(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || (data.backups !== undefined && !Array.isArray(data.backups))
    || !Number.isFinite(now)) throw new Error('Invalid backup inventory')
  if ((data.backups || []).some(b => !b || typeof b !== 'object' || Array.isArray(b))) {
    throw new Error('Invalid backup entry')
  }
  const completed = (data.backups || []).filter(b => b.status === 'COMPLETED'
    && Number.isFinite(Date.parse(b.inserted_at))).sort((a,b) => Date.parse(b.inserted_at)-Date.parse(a.inserted_at))
  const latest = completed[0]?.inserted_at || null
  const ageHours = latest ? (now-Date.parse(latest))/3600000 : null
  return {
    completed_backups: completed.length, latest_completed: latest,
    age_hours: ageHours === null ? null : Math.round(ageHours*10)/10,
    daily_backup_fresh: ageHours !== null && ageHours >= 0 && ageHours <= 30,
    physical_backups: data.walg_enabled === true, pitr_enabled: data.pitr_enabled === true,
  }
}

export function compatibleDump(version, serverVersionNum) {
  if (typeof version !== 'string' || !Number.isInteger(Number(serverVersionNum))
    || Number(serverVersionNum) < 100000) return false
  const match = version.match(/PostgreSQL\) (\d+)\./)
  return Boolean(match && Number(match[1]) >= Math.floor(Number(serverVersionNum)/10000))
}

export async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN
    || fs.readFileSync(`${os.homedir()}/.supabase/access-token`, 'utf8').trim()
  async function management(route, query) {
    const r = await fetch(`https://api.supabase.com/v1/projects/ckloewflialohuvixmvd/${route}`, {
      method: query ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(query ? { body: JSON.stringify({ query }) } : {}), signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw new Error(`Recovery inventory failed: HTTP ${r.status}`)
    return r.json()
  }
  const [backups, inventory] = await Promise.all([
    management('database/backups'),
    management('database/query', `BEGIN READ ONLY; SET LOCAL statement_timeout='20s';
SELECT current_setting('server_version_num')::integer AS server_version_num,
 pg_database_size(current_database()) AS database_bytes,
 (SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'tables',n.tables) ORDER BY n.nspname)
  FROM (SELECT ns.nspname,count(*) AS tables FROM pg_class c
   JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE c.relkind IN ('r','p') AND ns.nspname NOT IN ('pg_catalog','information_schema')
    AND ns.nspname NOT LIKE 'pg_toast%' GROUP BY ns.nspname) n) AS schema_inventory,
 (SELECT count(*) FROM storage.buckets) AS storage_buckets,
 (SELECT count(*) FROM storage.objects) AS storage_objects,
 (SELECT count(*) FROM pg_extension) AS extensions,
 (SELECT count(*) FROM pg_publication) AS publications,
 (SELECT count(*) FROM pg_subscription) AS subscriptions,
 (SELECT count(*) FROM pg_event_trigger) AS event_triggers,
 (SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname !~ '^pg_') AS login_roles;
COMMIT;`),
  ])
  if (!Array.isArray(inventory) || !inventory[0]?.server_version_num) throw new Error('Incomplete recovery inventory')
  const dumpTools = []
  for (const binary of ['pg_dump','/usr/lib/postgresql/17/bin/pg_dump','/usr/lib/postgresql/18/bin/pg_dump']) {
    try {
      const version = execFileSync(binary,['--version'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
      dumpTools.push({ binary, version, compatible: compatibleDump(version,inventory[0].server_version_num) })
    } catch { dumpTools.push({ binary, available:false }) }
  }
  const summary = summarizeBackups(backups)
  console.log(JSON.stringify({ checked_at:new Date().toISOString(), provider:summary,
    database:inventory[0], dump_tools:dumpTools,
    recovery_gates:{independent_backup:'not_verified',production_restore_drill:'not_verified',
      media_backup:'separate_coverage_required',key_recovery:'not_verified'},
    note:'Fresh provider backups do not establish independent or complete recovery.' },null,2))
  if (!summary.daily_backup_fresh || !dumpTools.some(t=>t.compatible)) process.exitCode=1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch(() => { console.error('Recovery check failed; no clean-recovery conclusion is possible.'); process.exitCode=1 })
}
