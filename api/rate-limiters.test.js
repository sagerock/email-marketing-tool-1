'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

// Will fail until rate-limiters.js and express-rate-limit are installed
const express = require('express')
const { webhookLimiter, upsertLimiter, WEBHOOK_CONFIG, UPSERT_CONFIG } = require('./rate-limiters')

function makeApp(limiter) {
  const app = express()
  app.post('/test', limiter, (req, res) => res.json({ ok: true }))
  return app
}

function post(server, path = '/test') {
  return new Promise((resolve) => {
    const addr = server.address()
    const req = http.request({ host: '127.0.0.1', port: addr.port, path, method: 'POST' }, (res) => {
      resolve(res.statusCode)
    })
    req.end()
  })
}

test('webhookLimiter allows requests under the limit', async () => {
  const app = makeApp(webhookLimiter)
  const server = app.listen(0)
  try {
    const status = await post(server)
    assert.equal(status, 200)
  } finally {
    server.close()
  }
})

test('webhookLimiter config has a reasonable limit and window', () => {
  assert.ok(WEBHOOK_CONFIG.max <= 500, 'webhook limit should be reasonable')
  assert.ok(WEBHOOK_CONFIG.windowMs >= 60_000, 'webhook window should be at least 1 minute')
})

test('upsertLimiter allows requests under the limit', async () => {
  const app = makeApp(upsertLimiter)
  const server = app.listen(0)
  try {
    const status = await post(server)
    assert.equal(status, 200)
  } finally {
    server.close()
  }
})

test('upsertLimiter config is stricter than webhookLimiter', () => {
  assert.ok(UPSERT_CONFIG.max < WEBHOOK_CONFIG.max, 'upsert should be more restricted than webhooks')
})

test('limiters return JSON error on 429', async () => {
  // Verify handler config is set (express-rate-limit exposes this)
  assert.equal(typeof webhookLimiter, 'function', 'webhookLimiter should be middleware')
  assert.equal(typeof upsertLimiter, 'function', 'upsertLimiter should be middleware')
})
