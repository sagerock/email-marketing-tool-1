// EMAIL_TOOL_ENV_FILE=/absolute/path/to/.env node scripts/apply-intake-guide-migration.mjs [--apply]
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require=createRequire(new URL('../api/package.json',import.meta.url))
require('dotenv').config({path:process.env.EMAIL_TOOL_ENV_FILE||fileURLToPath(new URL('../.env',import.meta.url))})
const ref=new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]
const token=process.env.SUPABASE_ACCESS_TOKEN||fs.readFileSync(`${os.homedir()}/.supabase/access-token`,'utf8').trim()
async function query(sql){
 const response=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(30000)})
 const data=await response.json();if(!response.ok)throw new Error(`Migration failed (${response.status}): ${data.message||'See database logs'}`)
 return data
}
const check=`select to_regclass('public.intake_guide_deliveries') is not null as delivery_table, to_regprocedure('public.record_intake_guide_request(text,text,text,text,boolean,jsonb)') is not null as contact_function`
const [before]=await query(check)
if(before.delivery_table && before.contact_function) console.log('Migration 123 already installed.')
else if(!process.argv.includes('--apply')) console.log('Migration 123 pending. Pass --apply to install.')
else {
 if(before.delivery_table || before.contact_function) throw new Error('Partial installation; inspect before continuing.')
 await query(fs.readFileSync(new URL('../supabase/migrations/123_intake_guide_delivery.sql',import.meta.url),'utf8'))
 const [after]=await query(check)
 if(!after.delivery_table||!after.contact_function)throw new Error('Migration verification failed')
 console.log('Migration 123 installed. No existing records modified.')
}
