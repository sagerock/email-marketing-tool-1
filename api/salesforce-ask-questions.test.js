const test = require('node:test')
const assert = require('node:assert/strict')

const { syncSalesforceAskQuestions, mapQuestion } = require('./salesforce-ask-questions')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const NOW = new Date('2026-10-01T16:00:00Z')

function question(overrides) {
  return {
    Id: 'a0M000000000001AAA', Name: 'AA-3600', Status__c: 'Response Emailed',
    Source_Form__c: 'Ask Alconox Form', Source_Code__c: 'Ask Alconox',
    Email_Address__c: ' Maria@Example.com', Associated_Lead__c: '00Q000000000001AAA',
    Associated_Contact__c: null, CreatedDate: '2026-09-18T12:40:13.000+0000',
    LastModifiedDate: '2026-09-29T14:32:30.000+0000', LastModifiedBy: { Name: 'Michelle Modica' },
    ...overrides,
  }
}

function fakeSupabase({ stored = [] } = {}) {
  const state = { upserts: [], hidden: [], windowReads: [] }
  return {
    state,
    from(table) {
      assert.equal(table, 'salesforce_ask_questions')
      return {
        async upsert(rows, opts) {
          assert.equal(opts.onConflict, 'client_id,salesforce_id')
          state.upserts.push(...rows)
          return { error: null }
        },
        select() {
          const q = {
            eq() { return q },
            async gte(column, since) {
              state.windowReads.push({ column, since })
              return { data: stored.map(salesforce_id => ({ salesforce_id })), error: null }
            },
          }
          return q
        },
        update(patch) {
          const q = {
            eq() { return q },
            async in(_column, ids) { state.hidden.push({ patch, ids }); return { error: null } },
          }
          return q
        },
      }
    },
  }
}

function connection(records, { error, totalSize } = {}) {
  const conn = {
    version: '61.0', calls: [],
    async query(soql) {
      conn.calls.push(soql)
      if (error) throw error
      return { records, totalSize: totalSize ?? records.length, done: true }
    },
  }
  return conn
}

test('maps a question with a normalized email and both Salesforce links', () => {
  const row = mapQuestion(question(), CLIENT, NOW.toISOString())
  assert.equal(row.email, 'maria@example.com')
  assert.equal(row.status, 'Response Emailed')
  assert.equal(row.sf_lead_id, '00Q000000000001AAA')
  assert.equal(row.last_modified_by, 'Michelle Modica')
  assert.equal(row.visible_in_last_snapshot, true)
})

test('mirrors the recent window and hides questions Salesforce no longer returns', async () => {
  const supabase = fakeSupabase({ stored: ['a0M000000000001AAA', 'a0M00000000GONEAAA'] })
  const conn = connection([question()])
  const result = await syncSalesforceAskQuestions(
    { supabase, getSalesforceConnection: async () => conn, now: () => NOW }, CLIENT, { days: 120 })
  assert.deepEqual(result, { supported: true, complete: true, count: 1, hidden: 1 })
  assert.match(conn.calls[0], /FROM Ask_Alconox__c WHERE CreatedDate >= 2026-06-03T16:00:00.000Z/)
  assert.deepEqual(supabase.state.hidden.map(h => h.ids), [['a0M00000000GONEAAA']])
  assert.equal(supabase.state.hidden[0].patch.visible_in_last_snapshot, false)
})

test('a truncated read upserts but never hides', async () => {
  const supabase = fakeSupabase({ stored: ['a0M00000000GONEAAA'] })
  const conn = connection([question()], { totalSize: 9000 })
  const result = await syncSalesforceAskQuestions(
    { supabase, getSalesforceConnection: async () => conn, now: () => NOW }, CLIENT)
  assert.equal(result.complete, false)
  assert.equal(supabase.state.upserts.length, 1)
  assert.equal(supabase.state.windowReads.length, 0)
  assert.equal(supabase.state.hidden.length, 0)
})

test('orgs without the Ask Alconox object are skipped quietly', async () => {
  const supabase = fakeSupabase()
  const conn = connection([], { error: new Error("sObject type 'Ask_Alconox__c' is not supported.") })
  const result = await syncSalesforceAskQuestions(
    { supabase, getSalesforceConnection: async () => conn, now: () => NOW }, CLIENT)
  assert.deepEqual(result, { supported: false, complete: true, count: 0, hidden: 0 })
  assert.equal(supabase.state.upserts.length, 0)
})

test('other Salesforce errors propagate', async () => {
  const conn = connection([], { error: new Error('INVALID_SESSION_ID') })
  await assert.rejects(syncSalesforceAskQuestions(
    { supabase: fakeSupabase(), getSalesforceConnection: async () => conn, now: () => NOW }, CLIENT), /INVALID_SESSION_ID/)
})
