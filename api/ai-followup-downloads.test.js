const test = require('node:test')
const assert = require('node:assert/strict')

const { enrollDownloadFollowups, decide, routeResource, downloadSubmission } = require('./ai-followup-downloads')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const WP = { id: 'cfg-wp', name: 'White Paper Follow-up', enabled: true, trigger_download_resource: '*', download_trigger_since: '2026-09-22T18:00:00.000Z', followup_delays: [3, 4, 3] }
const HB = { id: 'cfg-hb', name: 'Aqueous Cleaning Handbook Follow-up', enabled: true, trigger_download_resource: 'Aqueous Cleaning Handbook', download_trigger_since: '2026-09-22T18:00:00.000Z', followup_delays: [3, 4, 3] }
const NOW = new Date('2026-09-23T12:00:00.000Z')

function activity(overrides = {}) {
  return {
    id: 'act-1', salesforce_id: 'a0t1', source_detail: 'Applications In Medical Device Manufacturing',
    web_page: 'https://alconox.com/member-downloads/applications-in-medical-device-manufacturing/',
    touchpoint_at: '2026-09-23T09:00:00.000Z', email: 'Lead@Example.com', sf_lead_id: '00Q1', sf_contact_id: null,
    ...overrides,
  }
}

function contact(overrides = {}) {
  return { id: 'c-1', email: 'lead@example.com', unsubscribed: false, bounce_status: 'none', tags: [], form_submissions: [], ...overrides }
}

// Minimal query-builder fake: records writes, answers the reads the module makes.
function fakeSupabase({ configs = [WP, HB], activities = [], contacts = [], recentSent = [], leased = [], insertError = null } = {}) {
  const state = { activityUpdates: [], contactUpdates: [], enrollments: [] }
  const builder = (table) => {
    const q = { table, filters: {}, op: null, payload: null }
    const chain = {
      select() { return chain },
      not() { return chain }, is() { return chain }, order() { return chain }, limit() { return chain },
      gt() { return chain }, lte() { return chain },
      eq(col, val) { q.filters[col] = val; return chain },
      update(payload) { q.op = 'update'; q.payload = payload; return chain },
      insert(payload) { q.op = 'insert'; q.payload = payload; return chain },
      async maybeSingle() { return resolve() },
      async single() { return resolve() },
      then(onOk, onErr) { return Promise.resolve().then(resolve).then(onOk, onErr) },
    }
    function resolve() {
      if (table === 'ai_followup_config') return { data: configs, error: null }
      if (table === 'salesforce_prospect_activities') {
        if (q.op === 'update') { state.activityUpdates.push({ id: q.filters.id, ...q.payload }); return { error: null } }
        return { data: activities, error: null }
      }
      if (table === 'contacts') {
        if (q.op === 'update') { state.contactUpdates.push({ id: q.filters.id, ...q.payload }); return { error: null } }
        return { data: contacts.find(c => c.email === q.filters.email) || null, error: null }
      }
      if (table === 'ai_followup_drafts') return { data: recentSent, error: null }
      if (table === 'ai_followup_contacts') {
        if (q.op === 'insert') {
          if (insertError) return { data: null, error: insertError }
          const row = { id: `enr-${state.enrollments.length + 1}`, ...q.payload }
          state.enrollments.push(row)
          return { data: { id: row.id }, error: null }
        }
        if (q.op === 'update') return { error: null }
        return { data: leased, error: null }
      }
      throw new Error(`unexpected table ${table}`)
    }
    return chain
  }
  return { state, from: builder }
}

test('routes the handbook to its own agent and everything else to the catch-all', () => {
  assert.equal(routeResource([WP, HB], 'Aqueous Cleaning Handbook').id, 'cfg-hb')
  assert.equal(routeResource([WP, HB], '  aqueous cleaning handbook ').id, 'cfg-hb')
  assert.equal(routeResource([WP, HB], 'Cleaning Validation References').id, 'cfg-wp')
  assert.equal(routeResource([HB], 'Cleaning Validation References'), null)
})

test('decide enforces cutover, internal, and suppression rules', () => {
  const ok = decide(activity(), [WP, HB], contact(), NOW)
  assert.equal(ok.action, 'enroll')
  assert.equal(ok.config.id, 'cfg-wp')

  assert.equal(decide(activity({ touchpoint_at: '2026-09-19T15:05:00.000Z' }), [WP, HB], contact(), NOW).reason, 'before_cutover')
  assert.equal(decide(activity(), [{ ...WP, download_trigger_since: null }], contact(), NOW).action, 'hold')
  assert.equal(decide(activity({ email: 'stacy@alconox.com' }), [WP], contact(), NOW).reason, 'internal_domain')
  assert.equal(decide(activity(), [WP], contact({ tags: ['Alconox Internal'] }), NOW).reason, 'internal_tag')
  assert.equal(decide(activity(), [WP], contact({ unsubscribed: true }), NOW).reason, 'unsubscribed')
  assert.equal(decide(activity(), [WP], contact({ bounce_status: 'hard' }), NOW).reason, 'hard_bounced')
  assert.equal(decide(activity(), [{ ...WP, enabled: false }], contact(), NOW).reason, 'agent_disabled')
  assert.equal(decide(activity({ email: null }), [WP], null, NOW).reason, 'no_email')
  // A lead synced after its download: wait for the contact rather than dropping the download.
  assert.equal(decide(activity(), [WP], null, NOW).action, 'hold')
})

test('enrolls a new download, records the source, and generates immediately', async () => {
  const supabase = fakeSupabase({ activities: [activity()], contacts: [contact()] })
  const generated = []
  const result = await enrollDownloadFollowups(
    { supabase, generateDraft: async (contactId, configId) => generated.push([contactId, configId]), now: NOW, leaseSeconds: 900 },
    CLIENT)

  assert.equal(result.enrolled.length, 1)
  assert.equal(result.enrolled[0].immediate, true)
  assert.deepEqual(generated, [['c-1', 'cfg-wp']])

  const enrollment = supabase.state.enrollments[0]
  assert.equal(enrollment.source_activity_id, 'act-1')
  assert.equal(enrollment.resource_url, activity().web_page)
  assert.equal(enrollment.status, 'in_progress')
  assert.equal(enrollment.next_followup_at, '2026-09-23T12:15:00.000Z') // leased while generating

  const submission = supabase.state.contactUpdates[0].form_submissions.at(-1)
  assert.equal(submission.form_name, 'Member Download')
  assert.equal(submission.fields.Resource, 'Applications In Medical Device Manufacturing')

  assert.deepEqual(supabase.state.activityUpdates.map(u => u.followup_enrollment_id), ['enr-1'])
})

test('defers to the scheduler when the person had an AI email in the last 72 hours', async () => {
  const supabase = fakeSupabase({ activities: [activity()], contacts: [contact()], recentSent: [{ id: 'd1' }] })
  let generated = 0
  const result = await enrollDownloadFollowups({ supabase, generateDraft: async () => { generated++ }, now: NOW }, CLIENT)
  assert.equal(generated, 0)
  assert.equal(result.enrolled[0].immediate, false)
  assert.equal(supabase.state.enrollments[0].next_followup_at, NOW.toISOString())
})

test('skips and records pre-cutover, internal, and duplicate downloads without enrolling', async () => {
  const supabase = fakeSupabase({
    activities: [
      activity({ id: 'old', touchpoint_at: '2026-09-19T15:05:00.000Z', email: 'sage@sagerock.com' }),
      activity({ id: 'internal', email: 'stacy@alconox.com' }),
    ],
    contacts: [contact(), contact({ id: 'c-2', email: 'stacy@alconox.com' })],
  })
  const result = await enrollDownloadFollowups({ supabase, generateDraft: async () => assert.fail('no generation'), now: NOW }, CLIENT)
  assert.equal(result.enrolled.length, 0)
  assert.deepEqual(result.skipped.map(s => s.reason), ['before_cutover', 'internal_domain'])
  assert.deepEqual(supabase.state.activityUpdates.map(u => [u.id, u.followup_skip_reason]),
    [['old', 'before_cutover'], ['internal', 'internal_domain']])
  assert.equal(supabase.state.enrollments.length, 0)
})

test('a second download into the same agent is recorded as already enrolled', async () => {
  const supabase = fakeSupabase({ activities: [activity()], contacts: [contact()], insertError: { code: '23505', message: 'duplicate' } })
  const result = await enrollDownloadFollowups({ supabase, generateDraft: async () => assert.fail('no generation'), now: NOW }, CLIENT)
  assert.deepEqual(result.skipped.map(s => s.reason), ['already_enrolled'])
  assert.equal(supabase.state.activityUpdates[0].followup_skip_reason, 'already_enrolled')
})

test('holds downloads whose contact has not synced yet and never marks them processed', async () => {
  const supabase = fakeSupabase({ activities: [activity()], contacts: [] })
  const result = await enrollDownloadFollowups({ supabase, now: NOW }, CLIENT)
  assert.equal(result.held.length, 1)
  assert.equal(supabase.state.activityUpdates.length, 0)
})

test('dry run reports decisions and writes nothing', async () => {
  const supabase = fakeSupabase({
    activities: [activity(), activity({ id: 'internal', email: 'stacy@alconox.com' })],
    contacts: [contact()],
  })
  const result = await enrollDownloadFollowups({ supabase, generateDraft: async () => assert.fail('no generation'), now: NOW }, CLIENT, { dryRun: true })
  assert.equal(result.enrolled.length, 1)
  assert.equal(result.enrolled[0].dry_run, true)
  assert.equal(result.skipped.length, 1)
  assert.equal(supabase.state.activityUpdates.length, 0)
  assert.equal(supabase.state.contactUpdates.length, 0)
  assert.equal(supabase.state.enrollments.length, 0)
})

test('dry run can simulate a cutover for agents that are not enabled yet', async () => {
  const inert = [{ ...WP, download_trigger_since: null }]
  const supabase = fakeSupabase({ configs: inert, activities: [activity()], contacts: [contact()] })
  const held = await enrollDownloadFollowups({ supabase, now: NOW }, CLIENT, { dryRun: true })
  assert.equal(held.held[0].reason, 'trigger_not_enabled')
  const simulated = await enrollDownloadFollowups({ supabase, now: NOW }, CLIENT, { dryRun: true, simulateCutover: '2026-09-22T18:00:00.000Z' })
  assert.equal(simulated.enrolled.length, 1)
  // Never applies outside a dry run.
  const real = await enrollDownloadFollowups({ supabase, now: NOW }, CLIENT, { simulateCutover: '2026-09-22T18:00:00.000Z' })
  assert.equal(real.held.length, 1)
  assert.equal(supabase.state.enrollments.length, 0)
})

test('does nothing for clients with no download-triggered agents', async () => {
  const supabase = fakeSupabase({ configs: [], activities: [activity()] })
  const result = await enrollDownloadFollowups({ supabase, now: NOW }, CLIENT)
  assert.deepEqual(result, { enrolled: [], skipped: [], held: [], configs: 0 })
})

test('download submission carries the resource and page for the AI prompt', () => {
  const s = downloadSubmission(activity())
  assert.equal(s.form_name, 'Member Download')
  assert.equal(s.submitted_at, '2026-09-23T09:00:00.000Z')
  assert.equal(s.fields.Page, activity().web_page)
})
