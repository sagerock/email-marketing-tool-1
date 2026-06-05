/**
 * One-off / maintenance: encrypt any client credentials still stored as plaintext.
 *
 * Background: decryptClient() in server.js tries to decrypt three fields and, on
 * failure, falls back to using the raw stored value. So a plaintext SendGrid key
 * still works to send, but spams "⚠️ Failed to decrypt sendgrid_api_key ...
 * Invalid ciphertext format" on every use and is unencrypted at rest. This script
 * finds such values and encrypts them in place.
 *
 * Idempotent: a value is considered already-encrypted if decrypt() succeeds, so
 * re-running does nothing. Never logs secret values.
 *
 * Usage (env vars must be present):
 *   ENCRYPTION_KEY=... VITE_SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *     node api/scripts/encrypt-plaintext-credentials.js
 */
'use strict'

const { createClient } = require('@supabase/supabase-js')
const { encrypt, decrypt } = require('../crypto-utils')

const FIELDS = ['sendgrid_api_key', 'salesforce_client_id', 'salesforce_client_secret']

async function main() {
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  const url = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required')
  if (!url || !serviceKey) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY are required')

  const supabase = createClient(url, serviceKey)

  const { data: clients, error } = await supabase
    .from('clients')
    .select(`id, name, ${FIELDS.join(', ')}`)
  if (error) throw error

  let changed = 0
  for (const client of clients) {
    const update = {}
    for (const field of FIELDS) {
      const value = client[field]
      if (!value) continue
      try {
        decrypt(value, ENCRYPTION_KEY) // succeeds => already encrypted, leave it
      } catch {
        update[field] = encrypt(value, ENCRYPTION_KEY) // plaintext => encrypt
      }
    }
    const fields = Object.keys(update)
    if (fields.length === 0) continue

    const { error: updErr } = await supabase.from('clients').update(update).eq('id', client.id)
    if (updErr) {
      console.error(`❌ ${client.name} (${client.id}): update failed: ${updErr.message}`)
      continue
    }
    changed++
    console.log(`✅ Encrypted [${fields.join(', ')}] for ${client.name} (${client.id})`)
  }

  console.log(changed === 0 ? 'No plaintext credentials found — nothing to do.' : `Done. Updated ${changed} client(s).`)
}

main().catch((e) => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
