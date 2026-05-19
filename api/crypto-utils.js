'use strict'

const crypto = require('node:crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

function keyBuffer(base64Key) {
  const buf = Buffer.from(base64Key, 'base64')
  if (buf.length !== KEY_BYTES) throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes`)
  return buf
}

function encrypt(plaintext, base64Key) {
  const key = keyBuffer(base64Key)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), encrypted.toString('base64'), authTag.toString('base64')].join(':')
}

function decrypt(ciphertext, base64Key) {
  const parts = ciphertext.split(':')
  if (parts.length !== 3) throw new Error('Invalid ciphertext format')
  const [ivB64, encryptedB64, authTagB64] = parts
  const key = keyBuffer(base64Key)
  const iv = Buffer.from(ivB64, 'base64')
  const encrypted = Buffer.from(encryptedB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

module.exports = { encrypt, decrypt }
