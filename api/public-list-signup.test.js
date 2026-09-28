'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateListSignup, upsertListContact, PUBLIC_LISTS } = require('./public-list-signup')

// Minimal stand-in for the supabase-js query builder: records calls and
// returns canned results for the lookup, update, and insert.
function fakeSupabase({ existing = null } = {}) {
  const calls = []
  const builder = (table) => {
    const q = { table, filters: [] }
    const chain = {
      select() { q.op = 'select'; return chain },
      update(row) { q.op = 'update'; q.row = row; calls.push(q); return chain },
      insert(row) { q.op = 'insert'; q.row = row; calls.push(q); return Promise.resolve({ error: null }) },
      eq(col, val) { q.filters.push([col, val]); return q.op === 'update' ? Promise.resolve({ error: null }) : chain },
      maybeSingle() { calls.push(q); return Promise.resolve({ data: existing, error: null }) },
    }
    return chain
  }
  return { from: builder, calls }
}

test('rejects lists that are not on the allowlist', () => {
  assert.deepEqual(validateListSignup({ email: 'a@b.co', list: 'awsna-2026' }), { error: 'Unknown list' })
  assert.deepEqual(validateListSignup({ email: 'a@b.co', list: 'constructor' }), { error: 'Unknown list' })
  assert.deepEqual(validateListSignup({ email: 'a@b.co' }), { error: 'Unknown list' })
})

test('rejects bad email and normalizes good input', () => {
  assert.ok(validateListSignup({ email: 'nope', list: 'law-firm-workspace' }).error)
  assert.ok(validateListSignup({ email: 42, list: 'law-firm-workspace' }).error)
  const ok = validateListSignup({ email: ' Pat@Firm.COM ', first_name: '  Pat ', list: 'law-firm-workspace' })
  assert.deepEqual(ok.value, { email: 'pat@firm.com', firstName: 'Pat', list: 'law-firm-workspace' })
  assert.equal(validateListSignup({ email: 'a@b.co', first_name: '', list: 'law-firm-workspace' }).value.firstName, null)
})

test('creates a new contact with the list tags', async () => {
  const sb = fakeSupabase()
  const action = await upsertListContact(sb, 'client-1', { email: 'pat@firm.com', firstName: 'Pat', list: 'law-firm-workspace' })
  assert.equal(action, 'created')
  const insert = sb.calls.find((c) => c.op === 'insert')
  assert.deepEqual(insert.row, {
    client_id: 'client-1', email: 'pat@firm.com', first_name: 'Pat',
    tags: PUBLIC_LISTS['law-firm-workspace'].tags, unsubscribed: false,
  })
})

test('merges tags on an existing contact and never touches unsubscribe status', async () => {
  const sb = fakeSupabase({ existing: { id: 'c9', first_name: 'Patricia', tags: ['awsna-2026', 'legal-lead'] } })
  const action = await upsertListContact(sb, 'client-1', { email: 'pat@firm.com', firstName: 'Pat', list: 'law-firm-workspace' })
  assert.equal(action, 'updated')
  const update = sb.calls.find((c) => c.op === 'update')
  assert.equal(update.row.first_name, 'Patricia')
  assert.deepEqual(update.row.tags.sort(), ['awsna-2026', 'law-firm-workspace', 'legal-lead'])
  assert.ok(!('unsubscribed' in update.row))
})
