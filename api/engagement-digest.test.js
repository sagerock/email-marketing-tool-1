const test = require('node:test')
const assert = require('node:assert/strict')

const mountDigest = require('./engagement-digest')

function overview() {
  return {
    days: 30,
    totals: {
      form_submissions: 12,
      form_leads: 10,
      form_leads_no_follow_up: 2,
      form_leads_automation: 2,
      form_leads_within_grace: 1,
      form_leads_reply_waiting: 1,
      form_leads_human_follow_up: 1,
      form_leads_salesforce_activity: 1,
      form_leads_ambiguous: 1,
      form_leads_unable_to_verify: 1,
      open_opps: 0,
      stalled: 0,
      replies: 0,
    },
    form_leads: [{
      id: 'person-1', email: 'person@example.test', first_name: 'Pat', last_name: 'Lee',
      company: 'Example', last_form: 'Sample request', forms_in_window: 1,
      last_form_on: '2026-09-01', status: 'no follow-up recorded',
      opens_since_form: 1, clicks_since_form: 0,
      salesforce_last_activity_date: null,
    }],
    stalled: [],
    replies: [],
  }
}

test('unsent digest render uses exact totals and evidence-safe wording', () => {
  const app = { post() {} }
  const { buildDigest } = mountDigest(app, { supabase: {}, decryptClient: x => x, cron: null })
  const rendered = buildDigest(
    overview(),
    { name: 'Alconox' },
    { subject_prefix: 'Alconox, LLC' },
  )
  assert.equal(rendered.attention, 8)
  assert.equal(rendered.subject, '8 form leads need review — Alconox, LLC')
  assert.match(rendered.html, /No activity date recorded/)
  assert.match(rendered.html, /1 of 8 matching leads shown/)
  assert.doesNotMatch(rendered.html, /contacted by a person|Everyone has been contacted|>never</)
})

test('digest send path fails closed before rendering when Salesforce coverage is incomplete', async () => {
  const previous = process.env.ENGAGEMENT_REPORTING_ENABLED
  process.env.ENGAGEMENT_REPORTING_ENABLED = 'true'
  const app = { post() {} }
  const rows = {
    engagement_digest_config: { enabled: true, recipients: ['sage@example.test'], bcc: [], days: 30 },
    clients: { id: 'client-1', name: 'Alconox', default_reply_to_email: 'from@example.test' },
    campaigns: { from_email: 'from@example.test', from_name: 'Alconox' },
  }
  const supabase = {
    from(table) {
      const builder = {
        select() { return builder },
        eq() { return builder },
        not() { return builder },
        order() { return builder },
        limit() { return builder },
        maybeSingle: async () => ({ data: rows[table], error: null }),
        single: async () => ({ data: rows[table], error: null }),
      }
      return builder
    },
  }
  const reporting = {
    refreshSnapshot: async () => ({ status: 'failed', unresolved_count: 0, failed_count: 1 }),
  }
  const { sendDigest } = mountDigest(app, { supabase, decryptClient: x => x, cron: null, reporting })
  try {
    await assert.rejects(sendDigest('client-1'), /digest withheld: Salesforce verification failed.*failed=1/)
  } finally {
    if (previous === undefined) delete process.env.ENGAGEMENT_REPORTING_ENABLED
    else process.env.ENGAGEMENT_REPORTING_ENABLED = previous
  }
})

test('an answered Ask Alconox question counts as follow-up, an open one stays flagged', () => {
  const app = { post() {} }
  const { buildDigest } = mountDigest(app, { supabase: {}, decryptClient: x => x, cron: null })
  const o = overview()
  o.totals.form_leads_ask_answered = 3
  o.form_leads[0].ask_status = 'Reviewed'
  o.form_leads.push({ ...o.form_leads[0], id: 'person-2', status: 'Ask Alconox answered', ask_status: 'Response Emailed' })
  const rendered = buildDigest(o, { name: 'Alconox' }, {})
  assert.doesNotMatch(rendered.html, /person-2/)
  assert.match(rendered.html, /Ask Alconox: Reviewed/)
  assert.match(rendered.html, /3 had their Ask Alconox question answered/)
})

test('only the scheduler service registers the Monday digest cron', () => {
  const app = { post() {} }
  const scheduled = []
  const cron = { schedule: (expr) => scheduled.push(expr) }
  mountDigest(app, { supabase: {}, decryptClient: x => x, cron, schedulerEnabled: false })
  assert.deepEqual(scheduled, [])
  mountDigest(app, { supabase: {}, decryptClient: x => x, cron, schedulerEnabled: true })
  assert.deepEqual(scheduled, ['0 12 * * 1'])
})

test('a finished check with a few unresolved people still sends; real gaps withhold', () => {
  const { digestVerificationProblem: gate } = mountDigest
  const ok = { status: 'partial', failed_count: 0, unresolved_count: 11, expected_count: 3828,
    cohort_discovery_complete: true, opportunity_discovery_complete: true }
  assert.equal(gate({ ...ok, status: 'complete', unresolved_count: 0 }), null)
  assert.equal(gate(ok), null)
  assert.match(gate({ ...ok, unresolved_count: 200 }), /too many unresolved.*limit 77/)
  assert.match(gate({ ...ok, cohort_discovery_complete: false }), /not fully enumerated/)
  assert.match(gate({ ...ok, opportunity_discovery_complete: false }), /opportunity coverage/)
  assert.match(gate({ ...ok, status: 'failed', failed_count: 1 }), /failed/)
  assert.match(gate(null), /failed/)
})
