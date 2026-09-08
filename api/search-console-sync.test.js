'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  addDays,
  datesBetween,
  finalizedDate,
  normalizeDetailRow,
  rowKey,
} = require('./search-console-sync')

test('date helpers use stable UTC calendar dates', () => {
  assert.equal(addDays('2026-03-08', 1), '2026-03-09')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.deepEqual(datesBetween('2026-09-03', '2026-09-05'), [
    '2026-09-03',
    '2026-09-04',
    '2026-09-05',
  ])
  assert.equal(finalizedDate(new Date('2026-09-08T23:59:59Z')), '2026-09-05')
})

test('detail rows retain dimensions and receive deterministic composite hashes', () => {
  const syncedAt = '2026-09-08T12:00:00.000Z'
  const row = normalizeDetailRow('client-1', '2026-09-05', 'web', {
    keys: ['best shoulder doctor', 'https://example.com/dan', 'usa', 'MOBILE'],
    clicks: 3,
    impressions: 20,
    ctr: 0.15,
    position: 4.2,
  }, syncedAt)

  assert.deepEqual(row, {
    client_id: 'client-1',
    data_date: '2026-09-05',
    search_type: 'web',
    row_key: rowKey(['best shoulder doctor', 'https://example.com/dan', 'usa', 'MOBILE']),
    query: 'best shoulder doctor',
    page: 'https://example.com/dan',
    country: 'usa',
    device: 'MOBILE',
    clicks: 3,
    impressions: 20,
    ctr: 0.15,
    position: 4.2,
    synced_at: syncedAt,
  })
})

test('different dimension combinations do not share row keys', () => {
  assert.notEqual(
    rowKey(['doctor', '/a', 'usa', 'MOBILE']),
    rowKey(['doctor', '/a', 'usa', 'DESKTOP']),
  )
})
