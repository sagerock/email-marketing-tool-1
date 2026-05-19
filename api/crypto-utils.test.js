'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

// Will fail until crypto-utils.js exists
const { encrypt, decrypt } = require('./crypto-utils')

const TEST_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRrZXk=' // 32-byte base64

test('encrypt produces a non-plaintext string', () => {
  const result = encrypt('SG.mysendgridkey', TEST_KEY)
  assert.notEqual(result, 'SG.mysendgridkey')
  assert.equal(typeof result, 'string')
  assert.ok(result.length > 0)
})

test('decrypt recovers the original plaintext', () => {
  const plaintext = 'SG.mysendgridkey'
  const ciphertext = encrypt(plaintext, TEST_KEY)
  assert.equal(decrypt(ciphertext, TEST_KEY), plaintext)
})

test('encrypt is non-deterministic - same input produces different output', () => {
  const plaintext = 'SG.mysendgridkey'
  const a = encrypt(plaintext, TEST_KEY)
  const b = encrypt(plaintext, TEST_KEY)
  assert.notEqual(a, b)
})

test('decrypt with wrong key throws', () => {
  const ciphertext = encrypt('SG.mysendgridkey', TEST_KEY)
  const wrongKey = 'd3JvbmdrZXl3cm9uZ2tleXdyb25na2V5d3JvbmdrZXk='
  assert.throws(() => decrypt(ciphertext, wrongKey))
})

test('encrypt handles empty string', () => {
  const result = encrypt('', TEST_KEY)
  assert.equal(decrypt(result, TEST_KEY), '')
})

test('encrypt handles long credentials like Salesforce secrets', () => {
  const longSecret = 'ABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ'.repeat(4)
  const ciphertext = encrypt(longSecret, TEST_KEY)
  assert.equal(decrypt(ciphertext, TEST_KEY), longSecret)
})

test('decrypt throws on malformed ciphertext', () => {
  assert.throws(() => decrypt('not-valid-ciphertext', TEST_KEY))
})
