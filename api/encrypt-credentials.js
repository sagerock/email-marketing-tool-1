'use strict'

/**
 * One-time migration: encrypts plaintext API keys and OAuth secrets in the
 * clients table using AES-256-GCM. Safe to run multiple times (idempotent).
 *
 * Run with: ENCRYPTION_KEY=<base64-32-bytes> node api/encrypt-credentials.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })
const { createClient } = require('@supabase/supabase-js')
const { encrypt, decrypt } = require('./crypto-utils')

const CREDENTIAL_FIELDS = ['sendgrid_api_key', 'salesforce_client_id', 'salesforce_client_secret']

// Ciphertext format is three base64 segments joined by colons: iv:ciphertext:authTag
const CIPHERTEXT_RE = /^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/

function isAlreadyEncrypted(value) {
  if (!value || typeof value !== 'string') return false
  return CIPHERTEXT_RE.test(value)
}

function encryptClientCredentials(client, encryptionKey) {
  const updated = { ...client }
  for (const field of CREDENTIAL_FIELDS) {
    const value = client[field]
    if (value === null || value === undefined) continue
    if (isAlreadyEncrypted(value)) continue
    updated[field] = encrypt(value, encryptionKey)
  }
  return updated
}

async function main() {
  const { SUPABASE_SERVICE_KEY, ENCRYPTION_KEY } = process.env
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ENCRYPTION_KEY) {
    console.error('Required env vars: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_KEY, ENCRYPTION_KEY')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, sendgrid_api_key, salesforce_client_id, salesforce_client_secret')

  if (error) {
    console.error('Failed to fetch clients:', error.message)
    process.exit(1)
  }

  console.log(`Found ${clients.length} client(s). Encrypting credentials...`)

  let encrypted = 0
  let skipped = 0

  for (const client of clients) {
    const updated = encryptClientCredentials(client, ENCRYPTION_KEY)

    const changed = CREDENTIAL_FIELDS.some(f => updated[f] !== client[f])
    if (!changed) {
      console.log(`  [SKIP] client ${client.id} - credentials already encrypted`)
      skipped++
      continue
    }

    const patch = {}
    for (const field of CREDENTIAL_FIELDS) {
      if (updated[field] !== client[field]) patch[field] = updated[field]
    }

    const { error: updateError } = await supabase
      .from('clients')
      .update(patch)
      .eq('id', client.id)

    if (updateError) {
      console.error(`  [ERROR] client ${client.id}:`, updateError.message)
      process.exit(1)
    }

    console.log(`  [OK] client ${client.id} - encrypted ${Object.keys(patch).join(', ')}`)
    encrypted++
  }

  console.log(`\nDone. ${encrypted} encrypted, ${skipped} already encrypted.`)
}

module.exports = { encryptClientCredentials, isAlreadyEncrypted }

if (require.main === module) main()
