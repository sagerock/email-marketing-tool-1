import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
const { createClient } = require('@supabase/supabase-js')
const { runAllSearchConsoleSyncs } = require('../api/search-console-sync')

function flag(name) {
  const prefix = `--${name}=`
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
}

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const results = await runAllSearchConsoleSyncs({
  supabase,
  encryptionKey: process.env.ENCRYPTION_KEY,
  startDate: flag('start'),
  endDate: flag('end'),
  clientId: flag('client-id'),
})
console.log(JSON.stringify(results, null, 2))
if (results.some(result => !result.ok)) process.exitCode = 1
