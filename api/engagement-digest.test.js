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
    refreshSnapshot: async () => ({ status: 'partial', unresolved_count: 1, failed_count: 0 }),
  }
  const { sendDigest } = mountDigest(app, { supabase, decryptClient: x => x, cron: null, reporting })
  try {
    await assert.rejects(sendDigest('client-1'), /digest withheld.*unresolved=1/)
  } finally {
    if (previous === undefined) delete process.env.ENGAGEMENT_REPORTING_ENABLED
    else process.env.ENGAGEMENT_REPORTING_ENABLED = previous
  }
})
