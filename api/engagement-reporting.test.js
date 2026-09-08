const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEngagementReporting,
  mapSalesforceRecord,
  mountEngagementReporting,
  queryAll,
  shiftZonedCalendarDays,
} = require('./engagement-reporting')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const LEAD = '00Q000000000001AAA'
const CONTACT = '003000000000001AAA'

function fakeSupabase({ failRecords = false } = {}) {
  const state = { runs: [], records: [], runUpdates: [], rpcs: [] }
  return {
    state,
    from(table) {
      return {
        select() {
          assert.equal(table, 'contacts')
          const query = {
            eq() { return query },
            in: async () => ({ data: [], error: null }),
          }
          return query
        },
        insert(row) {
          assert.equal(table, 'engagement_refresh_runs')
          state.runs.push(row)
          return { select: () => ({ single: async () => ({ data: { id: `run-${state.runs.length}` }, error: null }) }) }
        },
        async upsert(rows) {
          assert.equal(table, 'engagement_refresh_records')
          if (failRecords) return { error: new Error('record insert failed') }
          state.records.push(...rows)
          return { error: null }
        },
        update(patch) {
          return {
            eq: async (_column, id) => {
              state.runUpdates.push({ table, id, patch })
              return { error: null }
            },
          }
        },
      }
    },
    async rpc(name, params) {
      state.rpcs.push({ name, params })
      return { data: 1, error: null }
    },
  }
}

function sfConnection(recordsByObject) {
  const connection = {
    version: '61.0',
    calls: [],
    async query(soql) {
      connection.calls.push(soql)
      const object = / FROM (Lead|Contact)/.exec(soql)?.[1]
      const records = recordsByObject[object] || []
      return { records, totalSize: records.length, done: true }
    },
  }
  return connection
}

test('known-person refresh queries exact IDs, clears returned null, and records omitted IDs as unresolved', async () => {
  const supabase = fakeSupabase()
  const conn = sfConnection({
    Lead: [{
      Id: LEAD, Email: 'PERSON@EXAMPLE.COM', FirstName: 'Pat', LastName: 'Lee',
      CreatedDate: '2026-08-01T12:00:00Z', LastActivityDate: null,
      Owner: { Name: 'Casey' }, Status: 'Open',
    }],
    Contact: [],
  })
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => conn,
    now: () => new Date('2026-09-08T16:00:00Z'),
    loadKnownCandidates: async () => [
      { id: 'local-1', salesforce_id: LEAD, record_type: 'lead', email: 'person@example.com' },
      { id: 'local-2', salesforce_id: CONTACT, record_type: 'contact', email: 'missing@example.com' },
    ],
  })

  const run = await service.refreshSnapshot(CLIENT, { scope: 'known_people' })

  assert.equal(run.status, 'partial')
  assert.equal(run.expected_count, 2)
  assert.equal(run.resolved_count, 1)
  assert.equal(run.unresolved_count, 1)
  const resolved = supabase.state.records.find(row => row.salesforce_id === LEAD)
  assert.equal(resolved.salesforce_last_activity_date, null)
  assert.equal(resolved.email, 'person@example.com')
  const unresolved = supabase.state.records.find(row => row.salesforce_id === CONTACT)
  assert.equal(unresolved.verification_status, 'unresolved')
  assert.match(unresolved.identity_detail.reason, /converted, merged, deleted, or inaccessible/)
  assert.deepEqual(supabase.state.rpcs, [
    { name: 'apply_engagement_snapshot', params: { p_run_id: 'run-1' } },
    {
      name: 'freeze_engagement_snapshot_evidence',
      params: { p_run_id: 'run-1', p_opportunity_verified: false },
    },
  ])
  assert.equal(conn.calls.some(soql => /LastModifiedDate/.test(soql)), false)
  assert.equal(conn.calls.every(soql => /Id IN/.test(soql)), true)
})

test('a capped dashboard cohort is partial instead of silently complete', async () => {
  const supabase = fakeSupabase()
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => sfConnection({
      Lead: [{ Id: LEAD, CreatedDate: '2026-09-01T12:00:00Z' }],
    }),
    now: () => new Date('2026-09-08T16:00:00Z'),
    loadKnownCandidates: async () => ({
      rows: [{ id: 'local-1', salesforce_id: LEAD, record_type: 'lead' }],
      totalCount: 6000,
      complete: false,
    }),
  })
  const run = await service.refreshSnapshot(CLIENT, {
    scope: 'known_people', maxRecords: 5000,
  })
  assert.equal(run.status, 'partial')
  assert.equal(run.cohort_discovery_complete, false)
  assert.match(run.source_limitations[0], /dashboard\/digest cohort exceeded/)
})

test('queryAll follows Salesforce pagination and reports a budget cutoff as incomplete', async () => {
  const pages = [
    { records: [{ Id: '1' }, { Id: '2' }], totalSize: 4, done: false, nextRecordsUrl: '/next' },
    { records: [{ Id: '3' }, { Id: '4' }], totalSize: 4, done: true },
  ]
  const conn = {
    query: async () => pages[0],
    queryMore: async url => {
      assert.equal(url, '/next')
      return pages[1]
    },
  }
  const complete = await queryAll(conn, 'SELECT Id FROM Lead', 10)
  assert.equal(complete.records.length, 4)
  assert.equal(complete.complete, true)
  const limited = await queryAll(conn, 'SELECT Id FROM Lead', 3)
  assert.equal(limited.records.length, 3)
  assert.equal(limited.complete, false)
})

test('queryAll retries a bounded transient Salesforce failure', async () => {
  let calls = 0
  const result = await queryAll({
    async query() {
      calls += 1
      if (calls === 1) throw new Error('SERVER_UNAVAILABLE: 503')
      return { records: [{ Id: LEAD }], totalSize: 1, done: true }
    },
  }, 'SELECT Id FROM Lead', 10)
  assert.equal(calls, 2)
  assert.equal(result.complete, true)
})

test('recent lead discovery preserves an explicit partial run when the API budget is exceeded', async () => {
  const supabase = fakeSupabase()
  const records = [LEAD, '00Q000000000002AAA', '00Q000000000003AAA'].map((Id, i) => ({
    Id, Email: `p${i}@example.com`, CreatedDate: `2026-09-0${i + 1}T12:00:00Z`, LastActivityDate: null,
  }))
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => sfConnection({ Lead: records }),
    now: () => new Date('2026-09-08T16:00:00Z'),
    maxRecords: 2,
  })
  const run = await service.refreshSnapshot(CLIENT, { scope: 'recent_leads', maxRecords: 2 })
  assert.equal(run.status, 'partial')
  assert.equal(run.cohort_discovery_complete, false)
  assert.equal(run.resolved_count, 2)
  assert.match(run.source_limitations[0], /2-record budget/)
})

test('concurrent identical refreshes use one Salesforce flight', async () => {
  const supabase = fakeSupabase()
  let release
  let calls = 0
  const blocked = new Promise(resolve => { release = resolve })
  const conn = {
    version: '61.0',
    async query() {
      calls += 1
      await blocked
      return { records: [], totalSize: 0, done: true }
    },
  }
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => conn,
    now: () => new Date('2026-09-08T16:00:00Z'),
  })
  const a = service.refreshSnapshot(CLIENT, { scope: 'recent_leads' })
  const b = service.refreshSnapshot(CLIENT, { scope: 'recent_leads' })
  release()
  const [one, two] = await Promise.all([a, b])
  assert.equal(one.id, two.id)
  assert.equal(calls, 1)
  assert.equal(supabase.state.runs.length, 1)
})

test('a persistence failure prevents a complete marker and records a failed run', async () => {
  const supabase = fakeSupabase({ failRecords: true })
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => sfConnection({ Lead: [{ Id: LEAD }] }),
    now: () => new Date('2026-09-08T16:00:00Z'),
  })
  await assert.rejects(
    service.refreshSnapshot(CLIENT, { scope: 'recent_leads' }),
    /record insert failed/,
  )
  assert.equal(supabase.state.runUpdates.at(-1).patch.status, 'failed')
  assert.equal(supabase.state.runUpdates.some(update => update.patch.status === 'complete'), false)
})

test('an inaccessible requested Salesforce object produces explicit partial coverage', async () => {
  const supabase = fakeSupabase()
  const conn = {
    version: '61.0',
    async query(soql) {
      if (/ FROM Contact/.test(soql)) {
        throw new Error("sObject type 'Contact' is not supported")
      }
      return { records: [], totalSize: 0, done: true }
    },
  }
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => conn,
    now: () => new Date('2026-09-08T16:00:00Z'),
  })
  const run = await service.refreshSnapshot(CLIENT, {
    scope: 'salesforce_people', includeContacts: true,
  })
  assert.equal(run.status, 'partial')
  assert.equal(run.cohort_discovery_complete, false)
  assert.deepEqual(run.source_limitations, [
    'Contact was not accessible to the Salesforce integration user.',
  ])
})

test('an unavailable optional Salesforce field is dropped without losing the cohort', async () => {
  const supabase = fakeSupabase()
  let calls = 0
  const conn = {
    version: '61.0',
    async query(soql) {
      calls += 1
      if (/Source_code__c/.test(soql)) throw new Error("No such column 'Source_code__c' on entity 'Lead'")
      return { records: [{ Id: LEAD, CreatedDate: '2026-09-01T12:00:00Z' }], totalSize: 1, done: true }
    },
  }
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => conn,
    now: () => new Date('2026-09-08T16:00:00Z'),
  })
  const run = await service.refreshSnapshot(CLIENT, { scope: 'recent_leads' })
  assert.equal(run.status, 'complete')
  assert.equal(run.resolved_count, 1)
  assert.equal(calls, 2)
})

test('record mapping never links identities by email alone', () => {
  const mapped = mapSalesforceRecord(
    { Id: LEAD, Email: 'duplicate@example.com', LastActivityDate: '2026-09-01' },
    'lead', CLIENT, 'run-1', null, '2026-09-08T16:00:00Z',
  )
  assert.equal(mapped.contact_id, null)
  assert.equal(mapped.salesforce_id, LEAD)
})

test('broad Salesforce cohorts attach local evidence only through an exact Salesforce ID', async () => {
  const supabase = fakeSupabase()
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => sfConnection({
      Lead: [{ Id: LEAD, Email: 'changed@example.com', CreatedDate: '2026-09-07T12:00:00Z' }],
    }),
    now: () => new Date('2026-09-08T16:00:00Z'),
    loadCandidatesBySalesforceIds: async () => [
      { id: 'local-exact', salesforce_id: LEAD, record_type: 'lead', email: 'old@example.com' },
      { id: 'local-email-only', salesforce_id: CONTACT, record_type: 'contact', email: 'changed@example.com' },
    ],
  })
  await service.refreshSnapshot(CLIENT, { scope: 'recent_leads' })
  assert.equal(supabase.state.records[0].contact_id, 'local-exact')
})

test('rolling date boundaries preserve New York wall time across daylight saving changes', () => {
  assert.equal(
    shiftZonedCalendarDays('2026-03-09T16:00:00.000Z', -1).toISOString(),
    '2026-03-08T16:00:00.000Z',
  )
  assert.equal(
    shiftZonedCalendarDays('2026-03-09T16:00:00.000Z', -2).toISOString(),
    '2026-03-07T17:00:00.000Z',
  )
})

test('fresh snapshot reuse requires the same cohort parameters', async () => {
  const runs = [
    { id: 'contacts', parameters: { days: 30, include_contacts: true } },
    { id: 'wrong-days', parameters: { days: 7, include_contacts: false } },
    { id: 'match', parameters: { days: 30, include_contacts: false } },
  ]
  const supabase = {
    from: () => ({
      select: () => ({
        eq() { return this }, gte() { return this }, order() { return this },
        limit: async () => ({ data: runs, error: null }),
      }),
    }),
  }
  const service = createEngagementReporting({
    supabase,
    getSalesforceConnection: async () => { throw new Error('must not refresh') },
    now: () => new Date('2026-09-08T16:00:00Z'),
  })
  const run = await service.latestComplete(CLIENT, 'recent_leads', 15, {
    days: 30, includeContacts: false,
  })
  assert.equal(run.id, 'match')
})

test('internal API rejects the wrong secret and ignores caller-supplied tenant IDs', async () => {
  const previous = {
    key: process.env.ASK_ENGAGEMENT_API_KEY,
    client: process.env.ASK_ENGAGEMENT_CLIENT_ID,
    enabled: process.env.ENGAGEMENT_REPORTING_ENABLED,
  }
  process.env.ASK_ENGAGEMENT_API_KEY = 'correct-secret'
  process.env.ASK_ENGAGEMENT_CLIENT_ID = CLIENT
  process.env.ENGAGEMENT_REPORTING_ENABLED = 'true'
  const state = { rpcs: [] }
  const query = {
    select() { return this },
    eq() { return this },
    async single() {
      return { data: { id: 'snapshot-1', scope: 'recent_leads', status: 'complete' }, error: null }
    },
  }
  const app = {
    post(_path, ...handlers) { app.handler = handlers.at(-1) },
  }
  mountEngagementReporting(app, {
    supabase: {
      from: () => query,
      async rpc(name, params) {
        state.rpcs.push({ name, params })
        return { data: { snapshot_id: 'snapshot-1' }, error: null }
      },
    },
    getSalesforceConnection: async () => { throw new Error('not used') },
  })
  function response() {
    return {
      statusCode: 200,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this },
    }
  }
  try {
    const denied = response()
    await app.handler({ headers: { authorization: 'Bearer wrong' }, body: {} }, denied)
    assert.equal(denied.statusCode, 401)
    assert.equal(state.rpcs.length, 0)

    const allowed = response()
    await app.handler({
      headers: { authorization: 'Bearer correct-secret' },
      body: {
        clientId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        queryType: 'recent_leads', snapshotId: 'snapshot-1',
      },
    }, allowed)
    assert.equal(allowed.statusCode, 200)
    assert.equal(state.rpcs[0].params.p_client_id, CLIENT)
  } finally {
    if (previous.key === undefined) delete process.env.ASK_ENGAGEMENT_API_KEY
    else process.env.ASK_ENGAGEMENT_API_KEY = previous.key
    if (previous.client === undefined) delete process.env.ASK_ENGAGEMENT_CLIENT_ID
    else process.env.ASK_ENGAGEMENT_CLIENT_ID = previous.client
    if (previous.enabled === undefined) delete process.env.ENGAGEMENT_REPORTING_ENABLED
    else process.env.ENGAGEMENT_REPORTING_ENABLED = previous.enabled
  }
})
