const test = require('node:test')
const assert = require('node:assert/strict')

const { syncSalesforceProspectActivities, downloadTag } = require('./salesforce-prospect-activities')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const LEAD = '00Q000000000001AAA'
const CONTACT = '003000000000001AAA'
const CAMPAIGN = '701000000000001AAA'

function activity(overrides) {
  return {
    Id: 'a0t000000000001AAA', Name: 'PA-1', Channel__c: 'Resource Download',
    Source_Detail__c: 'Aqueous Cleaning Handbook', Touchpoint_DateTime__c: '2026-09-22T14:13:47.000+0000',
    Download_Count__c: 1, Email__c: 'Sage@Example.com ', Lead__c: LEAD, Contact__c: null,
    Campaign__c: CAMPAIGN, CreatedDate: '2026-09-22T14:13:47.000+0000', ...overrides,
  }
}

function fakeSupabase({ contacts = [] } = {}) {
  const state = { upserts: [], tagCalls: [], tagRows: [], lookups: [] }
  return {
    state,
    from(table) {
      if (table === 'salesforce_prospect_activities') {
        return { async upsert(rows) { state.upserts.push(...rows); return { error: null } } }
      }
      if (table === 'tags') {
        return { async upsert(row) { state.tagRows.push(row); return { error: null } } }
      }
      assert.equal(table, 'contacts')
      return {
        select(_cols, opts) {
          if (opts?.head) {
            return { eq() { return this }, async filter() { return { count: 3 } } }
          }
          return {
            eq() { return this },
            async in(_col, ids) {
              state.lookups.push(ids)
              return { data: contacts.filter(c => ids.includes(c.salesforce_id)), error: null }
            },
          }
        },
      }
    },
    async rpc(name, args) {
      assert.equal(name, 'append_tag_to_contacts')
      state.tagCalls.push({ tag: args.p_tag_name, emails: [...args.p_emails].sort() })
      return { data: 1, error: null }
    },
  }
}

function connection(activities, { members = [] } = {}) {
  const queries = []
  return {
    queries,
    async query(soql) {
      queries.push(soql)
      if (soql.includes('FROM CampaignMember')) return { records: members, done: true }
      if (soql.startsWith('SELECT Lead__c, Contact__c, Campaign__c')) {
        return { records: activities.filter(a => a.Channel__c === 'Resource Download'), done: true }
      }
      return { records: activities, done: true }
    },
  }
}

test('stores activities and tags downloaders per resource plus an all-downloads tag', async () => {
  const supabase = fakeSupabase()
  const conn = connection([
    activity({}),
    activity({ Id: 'a0t2', Source_Detail__c: 'Critical Cleaning for 3D Printing' }),
    activity({ Id: 'a0t3', Channel__c: 'AI Chat', Source_Detail__c: 'Ask Alconox', Email__c: 'chat@example.com' }),
  ])
  const result = await syncSalesforceProspectActivities(
    { supabase, getSalesforceConnection: async () => conn }, CLIENT, '2026-09-21T06:00:00.000Z')

  assert.equal(result.count, 3)
  assert.match(conn.queries[0], /FROM Prospect_Activity__c WHERE LastModifiedDate > 2026-09-21T06:00:00.000Z/)
  assert.equal(supabase.state.upserts[0].email, 'sage@example.com')
  assert.equal(supabase.state.upserts[0].sf_lead_id, LEAD)
  assert.deepEqual(supabase.state.tagCalls.map(c => c.tag).sort(), [
    'Downloaded: Aqueous Cleaning Handbook',
    'Downloaded: Critical Cleaning for 3D Printing',
    'Resource Download',
  ])
  // AI chat is stored but never tagged as a download.
  assert.ok(supabase.state.tagCalls.every(c => !c.emails.includes('chat@example.com')))
  assert.deepEqual(result.rosterGaps, [])
})

test('resolves a missing email from the linked contact, preferring Contact over Lead', async () => {
  const supabase = fakeSupabase({ contacts: [
    { salesforce_id: CONTACT, email: 'contact@example.com' },
    { salesforce_id: LEAD, email: 'lead@example.com' },
  ] })
  const conn = connection([activity({ Email__c: null, Contact__c: CONTACT })])
  await syncSalesforceProspectActivities({ supabase, getSalesforceConnection: async () => conn }, CLIENT, null)
  assert.equal(supabase.state.upserts[0].email, 'contact@example.com')
  assert.doesNotMatch(conn.queries[0], /WHERE/)
})

test('reports download-campaign members with no download activity', async () => {
  const supabase = fakeSupabase()
  const conn = connection([activity({})], { members: [
    { Email: 'sage@example.com', LeadId: LEAD },
    { Email: 'missing@example.com', LeadId: '00Q000000000009AAA' },
  ] })
  const result = await syncSalesforceProspectActivities({ supabase, getSalesforceConnection: async () => conn }, CLIENT, null)
  assert.deepEqual(result.rosterGaps, ['missing@example.com'])
})

test('skips orgs without the Prospect_Activity__c object', async () => {
  const supabase = fakeSupabase()
  const conn = { async query() { throw new Error("sObject type 'Prospect_Activity__c' is not supported.") } }
  const result = await syncSalesforceProspectActivities({ supabase, getSalesforceConnection: async () => conn }, CLIENT, null)
  assert.deepEqual(result, { count: 0, tags: 0 })
  assert.equal(supabase.state.upserts.length, 0)
})

test('download tag trims the resource name', () => {
  assert.equal(downloadTag('  Aqueous Cleaning Handbook '), 'Downloaded: Aqueous Cleaning Handbook')
})
