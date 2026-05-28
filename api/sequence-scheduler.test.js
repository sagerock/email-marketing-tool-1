'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { computeNextSendTime } = require('./sequence-scheduler.js')

// Fixed reference point for all tests
const NOW = new Date('2026-06-01T12:00:00Z')

test('relative step: schedules at now + delay_days', () => {
  const step = { timing_anchor: 'previous_step', delay_days: 14, delay_hours: 0 }
  const result = computeNextSendTime(step, NOW)
  const expected = new Date(NOW)
  expected.setDate(expected.getDate() + 14)
  assert.deepEqual(result, expected)
})

test('relative step: schedules at now + delay_days + delay_hours', () => {
  const step = { timing_anchor: 'previous_step', delay_days: 2, delay_hours: 6 }
  const result = computeNextSendTime(step, NOW)
  const expected = new Date(NOW)
  expected.setDate(expected.getDate() + 2)
  expected.setHours(expected.getHours() + 6)
  assert.deepEqual(result, expected)
})

test('relative step: missing timing_anchor defaults to relative', () => {
  const step = { delay_days: 7, delay_hours: 0 }
  const result = computeNextSendTime(step, NOW)
  const expected = new Date(NOW)
  expected.setDate(expected.getDate() + 7)
  assert.deepEqual(result, expected)
})

test('fixed_date step: date 7 days out returns that date', () => {
  const fixedSendAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.deepEqual(result, new Date(fixedSendAt))
})

test('fixed_date step: past date returns null', () => {
  const fixedSendAt = new Date(NOW.getTime() - 60000).toISOString() // 1 minute ago
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.equal(result, null)
})

test('fixed_date step: within 3 days (2 days out) returns null', () => {
  const fixedSendAt = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.equal(result, null)
})

test('fixed_date step: exactly 72h out is NOT skipped (strict less-than boundary)', () => {
  const fixedSendAt = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.deepEqual(result, new Date(fixedSendAt))
})

test('fixed_date step: null fixed_send_at returns null', () => {
  const step = { timing_anchor: 'fixed_date', fixed_send_at: null }
  const result = computeNextSendTime(step, NOW)
  assert.equal(result, null)
})
