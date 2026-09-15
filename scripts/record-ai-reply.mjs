import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { replySql, reportSql } from './ai-reply-records.mjs'

const [command, ...args] = process.argv.slice(2)
let sql
if (command === 'record' && args[0]) {
  sql = replySql(JSON.parse(fs.readFileSync(args[0], 'utf8')), args.includes('--apply'))
} else if (command === 'report' && args.length === 3) {
  sql = reportSql({ clientId: args[0], start: args[1], end: args[2] })
} else {
  throw new Error('Usage: node --env-file=.env scripts/record-ai-reply.mjs record PRIVATE.json [--apply] | report CLIENT_UUID START_ISO END_EXCLUSIVE_ISO')
}
const projectRef = new URL(process.env.VITE_SUPABASE_URL).hostname.split('.')[0]
const token = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(path.join(os.homedir(), '.supabase/access-token'), 'utf8').trim()
const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(45000),
})
const result = await response.json()
if (!response.ok) throw new Error(`Database request failed (${response.status}): ${result.message || 'See provider logs'}`)
console.log(JSON.stringify(result, null, 2))
if (command === 'record' && !args.includes('--apply')) console.log('Preview only: all writes rolled back. Pass --apply to record.')
if (command === 'report') console.log('Recorded human responders / unique sent recipients. Provisional while inbox coverage is incomplete. Send window end is exclusive; replies are counted through this report run.')
