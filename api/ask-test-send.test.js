const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  TEST_SEND_CLIENTS,
  validateTestSendRequest,
  buildTestMessage,
  sendCampaignTest,
  createAskTestSendHandlers,
} = require('./ask-test-send')

const ALCONOX = TEST_SEND_CLIENTS.alconox.id
const CAMPAIGN = '57e8b379-d44b-49fd-b525-f934577d9cff'

// Minimal Supabase stand-in: enough of the query builder for this module.
function fakeSupabase({ campaign, log = [] } = {}) {
  const tables = {
    campaigns: campaign ? [campaign] : [],
    templates: [{ id: 'tpl-1', html_content: '<p>Hi {{first_name}}</p><a href="https://alconox.com">x</a><a href="{{unsubscribe_url}}">u</a>' }],
    clients: [{ id: ALCONOX, sendgrid_api_key: 'sg-key', ip_pool: 'Alconox', mailing_address: '30 Glenn St' }],
    ask_test_sends: log,
  }
  return {
    tables,
    from(name) {
      const rows = tables[name]
      const filters = []
      const q = {
        select() { return q },
        eq(col, val) { filters.push(r => r[col] === val); return q },
        gte(col, val) { filters.push(r => (r[col] || '') >= val); return q },
        order() { return q },
        limit() { return q },
        then(resolve) { resolve({ data: rows.filter(r => filters.every(f => f(r))), error: null }) },
        maybeSingle: async () => ({ data: rows.find(r => filters.every(f => f(r))) || null, error: null }),
        single: async () => ({ data: rows.find(r => filters.every(f => f(r))), error: null }),
        insert: async (row) => {
          if (rows.some(r => r.request_key === row.request_key && r.recipient === row.recipient)) {
            return { error: { code: '23505', message: 'duplicate' } }
          }
          rows.push({ ...row, created_at: new Date().toISOString() })
          return { error: null }
        },
        update(patch) {
          const u = {
            eq(col, val) { filters.push(r => r[col] === val); return u },
            then(resolve) { rows.filter(r => filters.every(f => f(r))).forEach(r => Object.assign(r, patch)); resolve({ error: null }) },
          }
          return u
        },
      }
      return q
    },
  }
}

const draft = (over = {}) => ({
  id: CAMPAIGN, client_id: ALCONOX, status: 'draft', template_id: 'tpl-1',
  name: 'The Alconox Scoop — October 2026', subject: 'What’s new on Alconox.com',
  from_email: 'cleaning@email.alconox.com', from_name: 'Alconox', reply_to: 'cleaning@alconox.com',
  utm_params: 'utm_source=scoop', ...over,
})

function run(supabase, recipients, key = 'req-1') {
  const sent = []
  return sendCampaignTest({
    supabase,
    input: validateTestSendRequest({ campaignId: CAMPAIGN, recipients }, key),
    decryptClient: c => c,
    sendMail: async (k, msg) => { sent.push(msg) },
    baseUrl: 'https://mail.sagerock.com',
  }).then(result => ({ result, sent }))
}

test('request validation bounds recipients and needs an idempotency key', () => {
  assert.throws(() => validateTestSendRequest({ campaignId: CAMPAIGN, recipients: ['a@b.c'] }, ''), /Idempotency-Key/)
  assert.throws(() => validateTestSendRequest({ campaignId: 'nope', recipients: ['a@b.c'] }, 'k'), /UUID/)
  assert.throws(() => validateTestSendRequest({ campaignId: CAMPAIGN, recipients: [] }, 'k'), /1 to 6/)
  assert.deepEqual(
    validateTestSendRequest({ campaignId: CAMPAIGN, recipients: [' SSilverstein@alconox.com ', 'ssilverstein@alconox.com'] }, 'k').recipients,
    ['ssilverstein@alconox.com'])
})

test('sends a personalized [TEST] copy to an approver, tagged as a test', async () => {
  const sb = fakeSupabase({ campaign: draft() })
  const { result, sent } = await run(sb, ['ssilverstein@alconox.com'])
  assert.deepEqual(result.sent, ['ssilverstein@alconox.com'])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].subject, '[TEST] What’s new on Alconox.com')
  assert.match(sent[0].html, /Hi Stacy/)
  assert.match(sent[0].html, /alconox\.com\?utm_source=scoop/)
  assert.match(sent[0].html, /token=TEST_TOKEN"/)
  assert.deepEqual(sent[0].customArgs, { test_campaign_id: CAMPAIGN })
  assert.equal(sb.tables.ask_test_sends[0].status, 'sent')
})

test('refuses anyone who is not a named approver for that client', async () => {
  const sb = fakeSupabase({ campaign: draft() })
  await assert.rejects(run(sb, ['ssilverstein@alconox.com', 'buyer@example.com']), /not an approved test recipient.*buyer@example.com/)
  assert.equal(sb.tables.ask_test_sends.length, 0)
})

test('refuses scheduled or sent campaigns and other tenants', async () => {
  await assert.rejects(run(fakeSupabase({ campaign: draft({ status: 'scheduled' }) }), ['mmodica@alconox.com']), /only for drafts/)
  await assert.rejects(run(fakeSupabase({ campaign: draft({ client_id: '00000000-0000-4000-8000-000000000000' }) }), ['mmodica@alconox.com']), /not enabled/)
  await assert.rejects(run(fakeSupabase({}), ['mmodica@alconox.com']), /not found/)
})

test('a retried request does not send twice', async () => {
  const sb = fakeSupabase({ campaign: draft() })
  await run(sb, ['mmodica@alconox.com'], 'same')
  const { result, sent } = await run(sb, ['mmodica@alconox.com'], 'same')
  assert.equal(sent.length, 0)
  assert.deepEqual(result.already_sent_for_this_request, ['mmodica@alconox.com'])
})

test('daily caps per recipient and per campaign', async () => {
  const now = new Date().toISOString()
  const five = Array.from({ length: 5 }, (_, i) => ({ campaign_id: CAMPAIGN, recipient: 'mmodica@alconox.com', request_key: `k${i}`, created_at: now }))
  await assert.rejects(run(fakeSupabase({ campaign: draft(), log: five }), ['mmodica@alconox.com']), /daily limit reached for mmodica/)
  const twenty = Array.from({ length: 20 }, (_, i) => ({ campaign_id: CAMPAIGN, recipient: `x${i}`, request_key: `k${i}`, created_at: now }))
  await assert.rejects(run(fakeSupabase({ campaign: draft(), log: twenty }), ['sage@sagerock.com']), /20 test copies per campaign/)
})

test('a failed SendGrid call is reported and logged, not thrown', async () => {
  const sb = fakeSupabase({ campaign: draft() })
  const result = await sendCampaignTest({
    supabase: sb,
    input: validateTestSendRequest({ campaignId: CAMPAIGN, recipients: ['mmodica@alconox.com'] }, 'k'),
    decryptClient: c => c,
    sendMail: async () => { throw new Error('boom') },
    baseUrl: 'https://mail.sagerock.com',
  })
  assert.equal(result.failed[0].error, 'boom')
  assert.equal(sb.tables.ask_test_sends[0].status, 'failed')
})

test('handlers require the bearer secret', async () => {
  const h = createAskTestSendHandlers({ supabase: fakeSupabase({}), apiKey: 'secret', decryptClient: c => c, sendMail: async () => {} })
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } }
  await h.send({ headers: { authorization: 'Bearer wrong' }, body: {} }, res)
  assert.equal(res.statusCode, 401)
  await h.drafts({ headers: { authorization: 'Bearer secret' }, body: { client: 'nobody' } }, res)
  assert.equal(res.statusCode, 400)
})

test('buildTestMessage never carries the real campaign_id', () => {
  const msg = buildTestMessage({ campaign: draft(), client: {}, html: '', email: 'a@b.c', firstName: 'A', baseUrl: 'https://x' })
  assert.equal(msg.customArgs.campaign_id, undefined)
})
