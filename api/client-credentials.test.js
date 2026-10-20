'use strict'

// Run with: node --test api/client-credentials.test.js   (never bare `node --test` in api/)
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { encrypt, decrypt } = require('./crypto-utils')
const {
  keyHint, validateSendgridKey, canReadClient, credentialSummary, isCiphertext, SECRET_COLUMNS,
} = require('./client-credentials')

const KEY = crypto.randomBytes(32).toString('base64')
// Built at runtime so secret scanners don't mistake the fixture for a real key.
const SG = ['SG', 'x'.repeat(22), 'y'.repeat(39) + 'mnpq'].join('.')

test('keyHint shows only the last four characters of a plaintext key', () => {
  assert.equal(keyHint(SG), 'mnpq')
  assert.equal(keyHint(SG).length, 4)
})

test('keyHint decrypts ciphertext and never returns the ciphertext itself', () => {
  const stored = encrypt(SG, KEY)
  assert.ok(isCiphertext(stored))
  assert.equal(keyHint(stored, { encryptionKey: KEY, decrypt }), SG.slice(-4))
  assert.equal(keyHint(stored, { decrypt }), null, 'no encryption key → no hint')
  assert.equal(keyHint(stored, { encryptionKey: crypto.randomBytes(32).toString('base64'), decrypt }), null,
    'wrong key → no hint rather than garbage')
})

test('keyHint returns null for empty or tiny values', () => {
  assert.equal(keyHint(null), null)
  assert.equal(keyHint(''), null)
  assert.equal(keyHint('short'), null)
})

test('validateSendgridKey accepts a real-shaped key and trims it', () => {
  const r = validateSendgridKey(`  ${SG}\n`)
  assert.deepEqual(r, { ok: true, key: SG })
})

test('validateSendgridKey rejects junk', () => {
  for (const bad of [undefined, null, 42, '', '   ', 'SG.short', 'notakey', `${SG} extra`, 'SG.abc def.ghi']) {
    assert.equal(validateSendgridKey(bad).ok, false, JSON.stringify(bad))
  }
})

test('canReadClient: super admins and admins see all, client admins only their own', () => {
  const a = '11111111-1111-1111-1111-111111111111'
  const b = '22222222-2222-2222-2222-222222222222'
  assert.equal(canReadClient({ role: 'super_admin' }, a), true)
  assert.equal(canReadClient({ role: 'admin' }, a), true)
  assert.equal(canReadClient({ role: 'client_admin', client_id: a }, a), true)
  assert.equal(canReadClient({ role: 'client_admin', client_id: a }, b), false)
  assert.equal(canReadClient({ role: 'viewer' }, a), false)
  assert.equal(canReadClient(null, a), false)
  assert.equal(canReadClient({ role: 'super_admin' }, ''), false)
})

test('credentialSummary reports configured flags and hints but no secret values', () => {
  const row = {
    sendgrid_api_key: encrypt(SG, KEY), ip_pool: 'pool-a',
    salesforce_client_id: encrypt('consumer', KEY), salesforce_client_secret: encrypt('secret', KEY),
    salesforce_instance_url: 'https://x.my.salesforce.com', salesforce_connected_at: '2026-01-01T00:00:00Z',
    woocommerce_consumer_key: null, woocommerce_consumer_secret: null, woocommerce_url: null, woocommerce_connected_at: null,
  }
  const s = credentialSummary(row, { encryptionKey: KEY, decrypt })
  assert.deepEqual(s.sendgrid, { configured: true, hint: SG.slice(-4), ip_pool: 'pool-a' })
  assert.equal(s.salesforce.configured, true)
  assert.equal(s.salesforce.instance_url, 'https://x.my.salesforce.com')
  assert.equal(s.woocommerce.configured, false)
  const json = JSON.stringify(s)
  assert.ok(!json.includes(SG), 'full key must not appear')
  assert.ok(!json.includes(row.sendgrid_api_key), 'ciphertext must not appear')
  assert.ok(!json.includes('consumer') && !json.includes('secret"'), 'salesforce secrets must not appear')
})

test('SECRET_COLUMNS matches the fields decryptClient handles plus the Salesforce tokens', () => {
  for (const c of ['sendgrid_api_key', 'salesforce_client_id', 'salesforce_client_secret',
    'woocommerce_consumer_key', 'woocommerce_consumer_secret', 'salesforce_access_token', 'salesforce_refresh_token']) {
    assert.ok(SECRET_COLUMNS.includes(c), c)
  }
})
