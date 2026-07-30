'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  CampaignClaimConflictError,
  canonicalEmail,
  isCampaignClaimConflictError,
  isSchedulerEnabled,
  keysetPages,
} = require('./send-utils')

test('canonicalEmail trims and lowercases without rewriting aliases', () => {
  assert.equal(canonicalEmail('  Sage+Test@Example.COM '), 'sage+test@example.com')
  assert.equal(canonicalEmail(null), '')
})

test('keysetPages traverses every row exactly once', async () => {
  const source = Array.from({ length: 2505 }, (_, index) => ({
    id: String(index + 1).padStart(4, '0'),
  }))
  const cursors = []
  const seen = []

  for await (const page of keysetPages(({ afterId, limit }) => {
    cursors.push(afterId)
    const start = afterId ? source.findIndex(row => row.id === afterId) + 1 : 0
    return source.slice(start, start + limit)
  }, 1000)) {
    seen.push(...page.map(row => row.id))
  }

  assert.deepEqual(cursors, [null, '1000', '2000'])
  assert.equal(seen.length, source.length)
  assert.equal(new Set(seen).size, source.length)
  assert.deepEqual(seen, source.map(row => row.id))
})

test('keysetPages rejects a non-advancing cursor', async () => {
  const iterator = keysetPages(async () => [{ id: 'same' }], 1)
  await iterator.next()
  await iterator.next()
  await assert.rejects(iterator.next(), /did not advance/)
})

test('campaign claim conflicts have a stable machine-readable code', () => {
  const error = new CampaignClaimConflictError('already claimed')
  assert.equal(isCampaignClaimConflictError(error), true)
  assert.equal(isCampaignClaimConflictError(new Error('already claimed')), false)
})

test('scheduler only starts when explicitly enabled', () => {
  assert.equal(isSchedulerEnabled({ RUN_SCHEDULER: 'true' }), true)
  assert.equal(isSchedulerEnabled({ RUN_SCHEDULER: 'false' }), false)
  assert.equal(isSchedulerEnabled({}), false)
})
