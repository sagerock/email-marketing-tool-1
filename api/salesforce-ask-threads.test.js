const test = require('node:test')
const assert = require('node:assert/strict')

const { syncAskThreads } = require('./salesforce-ask-threads')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const LEAD = '00Q000000000001AAA'

function q(overrides) {
  return {
    Id: 'a0M1', Name: 'AA-3630', Status__c: 'Response Emailed', Email_Address__c: 'akiko@example.com',
    Associated_Lead__c: LEAD, Associated_Contact__c: null, CreatedDate: '2026-10-01T10:00:00.000+0000',
    LastModifiedDate: '2026-10-02T10:00:00.000+0000', LastModifiedBy: { Name: 'Marius' },
    Comments__c: 'What is the rest of the SDS?', ...overrides,
  }
}
function em(id, at, overrides) {
  return { Id: id, MessageDate: at, Incoming: false, FromAddress: 'mdraeger@alconox.com', ToAddress: 'akiko@example.com',
    Subject: 'Hello', TextBody: 'body', RelatedToId: null, ...overrides }
}

function fakeConn({ questions, onRecord = [], onPerson = [] }) {
  return {
    version: '61.0',
    async query(soql) {
      if (/FROM Ask_Alconox__c/.test(soql)) return { done: true, records: questions }
      if (/FROM EmailMessage WHERE RelatedToId/.test(soql)) return { done: true, records: onRecord }
      if (/FROM EmailMessageRelation/.test(soql)) return { done: true, records: onPerson.map(e => ({ RelationId: LEAD, EmailMessage: e })) }
      throw new Error('unexpected ' + soql)
    },
  }
}
function fakeSupabase() {
  const state = {}
  return { state, from(table) { return { async upsert(rows) { (state[table] ||= []).push(...rows); return { error: null } } } } }
}
const run = async (conn, opts = {}) => {
  const supabase = fakeSupabase()
  const stats = await syncAskThreads({ supabase, getSalesforceConnection: async () => conn }, CLIENT, opts)
  return { stats, rows: supabase.state }
}

test('answer saved on the person with the AA number in the subject is matched; confirmation never counts', async () => {
  const { stats, rows } = await run(fakeConn({
    questions: [q()],
    onRecord: [em('e0', '2026-10-01T10:01:00.000+0000', { FromAddress: 'no-reply@alconox.com', Subject: 'Confirmation of Ask Alconox Request', TextBody: 'The Alconox Inc. Tech Team is working on a response to your questions.', RelatedToId: 'a0M1' })],
    onPerson: [
      em('e1', '2026-10-02T09:00:00.000+0000', { Subject: 'Your Ask Alconox request (AA-3630)' }),
      em('e2', '2026-10-02T12:00:00.000+0000', { Incoming: true, FromAddress: 'akiko@example.com', Subject: 'Re: Your Ask Alconox request (AA-3630)' }),
      em('e3', '2026-10-03T12:00:00.000+0000', { Subject: 'Your Ask Alconox request (AA-36301)' }),
    ],
  }))
  const row = rows.salesforce_ask_questions[0]
  assert.equal(row.answer_match, 'subject')
  assert.equal(row.first_answer_at, '2026-10-02T09:00:00.000+0000')
  assert.equal(row.first_answer_by, 'mdraeger@alconox.com')
  assert.equal(row.message_count, 2)
  assert.equal(row.last_message_incoming, true)
  assert.equal(row.question_text, 'What is the rest of the SDS?')
  assert.deepEqual(rows.salesforce_ask_messages.map(m => [m.email_message_id, m.is_confirmation]), [['e0', true], ['e1', false], ['e2', false]])
  assert.equal(stats.answeredFound, 1)
})

test('fallback takes the first staff email after the question and its replies, skipping automated mail', async () => {
  const { rows } = await run(fakeConn({
    questions: [q()],
    onPerson: [
      em('old', '2026-09-01T09:00:00.000+0000', { Subject: 'Earlier topic' }),
      em('ship', '2026-10-01T11:00:00.000+0000', { FromAddress: 'cleaning@alconox.com', Subject: 'Your detergent from Alconox is preparing to ship' }),
      em('ans', '2026-10-01T12:00:00.000+0000', { Subject: 'SDS ingredients' }),
      em('rep', '2026-10-02T12:00:00.000+0000', { Incoming: true, FromAddress: 'akiko@example.com', Subject: 'RE: SDS ingredients' }),
      em('late', '2026-12-01T12:00:00.000+0000', { Subject: 'Holiday hours' }),
    ],
  }))
  assert.equal(rows.salesforce_ask_questions[0].answer_match, 'person')
  assert.deepEqual(rows.salesforce_ask_messages.map(m => m.email_message_id), ['ans', 'rep'])
})

test('no answer found leaves answer fields empty; dry run writes nothing', async () => {
  const conn = fakeConn({ questions: [q()], onPerson: [em('x', '2026-12-30T12:00:00.000+0000')] })
  const { stats, rows } = await run(conn, { dryRun: true })
  assert.equal(stats.tally.none, 1)
  assert.deepEqual(rows, {})
})

test('orgs without the Ask Alconox object are skipped', async () => {
  const conn = { version: '61.0', async query() { throw new Error("sObject type 'Ask_Alconox__c' is not supported.") } }
  const { stats } = await run(conn)
  assert.deepEqual(stats, { supported: false })
})
