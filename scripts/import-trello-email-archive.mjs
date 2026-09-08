// Read-only by default. --apply persists an idempotent private archive only;
// no campaigns, schedules, contact records or messages are created.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { extractArchive, sourceDigest, matchCampaign } from './trello-email-archive.mjs'
const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({path:fileURLToPath(new URL('../.env',import.meta.url))})
const { createClient } = require('@supabase/supabase-js')
const [filename, clientId, ...options] = process.argv.slice(2)
if (!filename || !/^[0-9a-f-]{36}$/i.test(clientId || '')) throw new Error('Usage: node scripts/import-trello-email-archive.mjs <card.json> <client-uuid> [--apply]')
const raw = fs.readFileSync(path.resolve(filename),'utf8')
const source = JSON.parse(raw)
const archive = extractArchive(source,clientId)
console.log(JSON.stringify({source:source.name,sha256:sourceDigest(raw),comments:archive.comments,actions:archive.actions,candidate_entries:archive.rows.length,all_entries_require_review:true,apply:options.includes('--apply')},null,2))
const db = createClient(process.env.VITE_SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY)
const campaigns = []
for(let from=0; ;from+=500) {
  const result=await db.from('campaigns').select('id,name,created_at,scheduled_at,sent_at').eq('client_id',clientId).order('id').range(from,from+499)
  if(result.error) throw result.error
  campaigns.push(...result.data)
  if(result.data.length<500) break
}
for(const entry of archive.rows) entry.campaign_id=matchCampaign(entry,campaigns)
console.log(`Exact title/year matches to existing campaigns: ${archive.rows.filter(r=>r.campaign_id).length}`)
if (options.includes('--apply')) {
  const client = await db.from('clients').select('id,name').eq('id',clientId).single()
  if(client.error) throw client.error
  console.log(`Archive destination: ${client.data.name}`)
  // Refuse to overwrite a previous raw source or reviewed extraction.
  const old = await db.from('email_tracker_imports').select('id,source_text').eq('client_id',clientId).eq('source_id',source.id).maybeSingle()
  if(old.error) throw old.error
  if(old.data && sourceDigest(old.data.source_text)!==sourceDigest(raw)) throw new Error('A different export of this card is already archived; preserve it and review the update separately')
  let importId = old.data?.id
  if(!importId) {
    const saved = await db.from('email_tracker_imports').insert({client_id:clientId,source_id:source.id,source_name:source.name,source_url:source.url,source_text:raw}).select('id').single()
    if(saved.error) throw saved.error
    importId=saved.data.id
  }
  for(let i=0;i<archive.rows.length;i+=100) {
    const result=await db.from('email_tracker_items').upsert(archive.rows.slice(i,i+100).map(r=>({...r,import_id:importId})),{onConflict:'import_id,source_key',ignoreDuplicates:true})
    if(result.error) throw result.error
  }
  const verified=await db.from('email_tracker_items').select('id',{count:'exact',head:true}).eq('import_id',importId)
  if(verified.error) throw verified.error
  if(verified.count!==archive.rows.length) throw new Error(`Archive count mismatch: ${verified.count} vs ${archive.rows.length}`)
  console.log(`Verified ${verified.count} archived entries; original JSON retained verbatim.`)
}
