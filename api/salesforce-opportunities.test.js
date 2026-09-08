const test = require('node:test')
const assert = require('node:assert/strict')

const { syncSalesforceOpportunities } = require('./salesforce-opportunities')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const CURRENT = '006000000000001AAA'
const MISSING = '006000000000002AAA'

function fakeSupabase({ upsertError = null } = {}) {
  const state = { upserts: [], missingPatch: null, missingIds: null }
  return {
    state,
    from(table) {
      assert.equal(table, 'salesforce_opportunities')
      return {
        async upsert(rows) {
          state.upserts.push(...rows)
          return { error: upsertError }
        },
        select() {
          return {
            eq() { return this },
            order() { return this },
            async range() {
              return {
                data: [{ salesforce_id: CURRENT }, { salesforce_id: MISSING }],
                error: null,
              }
            },
          }
        },
        update(patch) {
          state.missingPatch = patch
          return {
            eq() { return this },
            async in(_column, ids) {
              state.missingIds = ids
              return { error: null }
            },
          }
        },
      }
    },
    rpc: async () => ({ error: null }),
  }
}

function connection(records, totalSize = records.length) {
  return {
    version: '61.0',
    async query() {
      return { records, totalSize, done: true }
    },
  }
}

test('authoritative opportunity reconciliation marks missing rows unresolved without closing them', async () => {
  const supabase = fakeSupabase()
  await syncSalesforceOpportunities({
    supabase,
    getSalesforceConnection: async () => connection([{
      Id: CURRENT, Name: 'Current', StageName: 'Open', IsClosed: false,
    }]),
  }, CLIENT, null, { authoritative: true })

  assert.equal(supabase.state.upserts[0].salesforce_id, CURRENT)
  assert.equal(supabase.state.upserts[0].visible_in_last_snapshot, true)
  assert.deepEqual(supabase.state.missingIds, [MISSING])
  assert.equal(supabase.state.missingPatch.visible_in_last_snapshot, false)
  assert.equal(supabase.state.missingPatch.verification_status, 'unresolved')
  assert.equal(Object.hasOwn(supabase.state.missingPatch, 'is_closed'), false)
})

test('opportunity DB failures are surfaced instead of logged as successful', async () => {
  const supabase = fakeSupabase({ upsertError: new Error('write failed') })
  await assert.rejects(
    syncSalesforceOpportunities({
      supabase,
      getSalesforceConnection: async () => connection([{ Id: CURRENT }]),
    }, CLIENT, null, { authoritative: true }),
    /Opportunity upsert failed: write failed/,
  )
})

test('authoritative opportunity enumeration stops before writes when its API budget is exceeded', async () => {
  const supabase = fakeSupabase()
  await assert.rejects(
    syncSalesforceOpportunities({
      supabase,
      getSalesforceConnection: async () => connection([
        { Id: CURRENT }, { Id: MISSING },
      ], 2),
    }, CLIENT, null, { authoritative: true, maxRecords: 1 }),
    /1-record budget/,
  )
  assert.equal(supabase.state.upserts.length, 0)
  assert.equal(supabase.state.missingPatch, null)
})
