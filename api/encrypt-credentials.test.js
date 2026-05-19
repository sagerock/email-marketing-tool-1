'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

// Will fail until encrypt-credentials.js exists
const { encryptClientCredentials, isAlreadyEncrypted } = require('./encrypt-credentials')
const { decrypt } = require('./crypto-utils')

const TEST_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRrZXk='

test('encrypts sendgrid_api_key', () => {
  const client = { id: '1', sendgrid_api_key: 'SG.testkey123', salesforce_client_secret: null, salesforce_client_id: null }
  const result = encryptClientCredentials(client, TEST_KEY)
  assert.notEqual(result.sendgrid_api_key, 'SG.testkey123')
  assert.equal(decrypt(result.sendgrid_api_key, TEST_KEY), 'SG.testkey123')
})

test('encrypts salesforce_client_secret when present', () => {
  const client = { id: '1', sendgrid_api_key: 'SG.key', salesforce_client_secret: 'sf_secret_abc', salesforce_client_id: null }
  const result = encryptClientCredentials(client, TEST_KEY)
  assert.notEqual(result.salesforce_client_secret, 'sf_secret_abc')
  assert.equal(decrypt(result.salesforce_client_secret, TEST_KEY), 'sf_secret_abc')
})

test('encrypts salesforce_client_id when present', () => {
  const client = { id: '1', sendgrid_api_key: 'SG.key', salesforce_client_secret: null, salesforce_client_id: 'sf_id_xyz' }
  const result = encryptClientCredentials(client, TEST_KEY)
  assert.notEqual(result.salesforce_client_id, 'sf_id_xyz')
  assert.equal(decrypt(result.salesforce_client_id, TEST_KEY), 'sf_id_xyz')
})

test('leaves null credentials as null', () => {
  const client = { id: '1', sendgrid_api_key: 'SG.key', salesforce_client_secret: null, salesforce_client_id: null }
  const result = encryptClientCredentials(client, TEST_KEY)
  assert.equal(result.salesforce_client_secret, null)
  assert.equal(result.salesforce_client_id, null)
})

test('does not mutate the original client object', () => {
  const client = { id: '1', sendgrid_api_key: 'SG.testkey123', salesforce_client_secret: null, salesforce_client_id: null }
  encryptClientCredentials(client, TEST_KEY)
  assert.equal(client.sendgrid_api_key, 'SG.testkey123')
})

test('isAlreadyEncrypted returns true for ciphertext output', () => {
  const { encrypt } = require('./crypto-utils')
  const ciphertext = encrypt('SG.testkey', TEST_KEY)
  assert.equal(isAlreadyEncrypted(ciphertext), true)
})

test('isAlreadyEncrypted returns false for plaintext SendGrid key', () => {
  assert.equal(isAlreadyEncrypted('SG.testkey123abc'), false)
})

test('skips fields that are already encrypted', () => {
  const { encrypt } = require('./crypto-utils')
  const alreadyEncryptedKey = encrypt('SG.original', TEST_KEY)
  const client = { id: '1', sendgrid_api_key: alreadyEncryptedKey, salesforce_client_secret: null, salesforce_client_id: null }
  const result = encryptClientCredentials(client, TEST_KEY)
  // Should be the same ciphertext, not double-encrypted
  assert.equal(result.sendgrid_api_key, alreadyEncryptedKey)
  // And still decryptable to the original
  assert.equal(decrypt(result.sendgrid_api_key, TEST_KEY), 'SG.original')
})
