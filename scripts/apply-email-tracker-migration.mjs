// Scoped, transactional migration runner. Read-only unless --apply is supplied.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../api/package.json',import.meta.url))
require('dotenv').config({path:fileURLToPath(new URL('../.env',import.meta.url))})
const ref = new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]
const token = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(path.join(os.homedir(),'.supabase/access-token'),'utf8').trim()
async function query(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({query:sql}), signal:AbortSignal.timeout(60000),
  })
  const result=await r.json()
  if(!r.ok) throw new Error(`Database migration request failed (${r.status}): ${result.message || 'See provider logs'}`)
  return result
}
const exists=await query("SELECT to_regclass('public.email_tracker_items') AS tracker")
if(exists[0].tracker) {
  console.log('Tracker already exists; no migration applied.')
} else if(!process.argv.includes('--apply')) {
  console.log('Migration 089 is pending. Pass --apply to install it.')
} else {
  const before=await query("SELECT id,status,scheduled_at FROM public.campaigns WHERE status IN ('scheduled','sending') ORDER BY id")
  if(before.some(c=>c.status==='sending')) throw new Error('A campaign is actively sending; apply after it finishes')
  await query(fs.readFileSync(new URL('../supabase/migrations/089_email_tracker.sql',import.meta.url),'utf8'))
  const after=await query("SELECT id,status,scheduled_at FROM public.campaigns WHERE status IN ('scheduled','sending') ORDER BY id")
  if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Migration installed, but scheduled campaign state changed during verification; inspect before continuing')
  const counts=await query('SELECT (SELECT count(*) FROM public.campaigns WHERE client_id IS NOT NULL) AS campaigns, (SELECT count(*) FROM public.email_tracker_items WHERE NOT is_legacy) AS tracker_items, (SELECT count(*) FROM public.email_tracker_events) AS history_events')
  if(counts[0].campaigns!==counts[0].tracker_items) throw new Error('Migration installed; backfill count mismatch requires review')
  console.log(JSON.stringify({migration:'089_email_tracker',verified:counts[0],preserved_schedules:before.length},null,2))
}
