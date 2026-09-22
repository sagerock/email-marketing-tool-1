const test = require('node:test')
const assert = require('node:assert/strict')

process.env.AI_REVIEW_LINK_SECRET = process.env.AI_REVIEW_LINK_SECRET || 'test-secret'

const {
  parseCaseDescription, mapCase, syncAiChatCases, enrollChatFollowups, decide, chatSubmission,
  notifyPendingChatReviews, buildReviewEmail, signReviewToken, verifyReviewToken, reviewUrl, parseReviewers,
} = require('./ai-chat-followups')

const CLIENT = '00000000-0000-0000-0000-000000000001'
const NOW = new Date('2026-09-23T12:00:00.000Z')
const DESCRIPTION = `[2026-09-16T16:25:13Z] Visitor: Please I need to buy 2 ea - Catalog Number: 1201-1
Alconox: For purchase orders, please send an email to po@alconox.com.

[2026-09-16T16:25:35Z] Visitor: does it come with COA ?
Alconox: Yes, our products come with a Certificate of Analysis (COA).

---
Pages: https://alconox.com/product/liquinox/
IP: 93.186.157.136
Session: 770c84cc-471a-4b9b-82ff-1eebc6306435
---`

function sfCase(overrides = {}) {
  return {
    Id: '500Nv00000jRRa8IAG', CaseNumber: '00001054', Subject: 'AI Chat - x', Status: 'Closed', Origin: 'Web',
    Case_Origin_Subtype__c: 'AI Chat', SuppliedEmail: 'Alessandra@AloiaAerospace.com', SuppliedName: null,
    SuppliedCompany: 'Aloia Aerospace', Lead__c: '00Q1', ContactId: null, Web_Page__c: null,
    Description: DESCRIPTION, CreatedDate: '2026-09-22T14:11:09.000+0000', LastModifiedDate: '2026-09-22T14:11:09.000+0000',
    ...overrides,
  }
}

const CFG = { id: 'cfg-chat', name: 'AI Chat Follow-up', enabled: true, trigger_ai_chat: true, chat_trigger_since: '2026-09-15T00:00:00.000Z', review_notify_emails: 'a@alconox.com, sage@sagerock.com', from_email: 'cleaning@email.alconox.com', from_name: 'Alconox', reply_to: 'cleaning@alconox.com' }

function caseRow(overrides = {}) {
  return { id: 'case-1', salesforce_id: '500x', case_number: '00001054', email: 'alessandra@aloiaaerospace.com', supplied_name: null, supplied_company: 'Aloia Aerospace', web_page: 'https://alconox.com/product/liquinox/', visitor_messages: ['I need to buy 2 ea', 'does it come with COA ?'], chat_at: '2026-09-16T16:25:13.000Z', transcript: 'x', ...overrides }
}
function contact(overrides = {}) {
  return { id: 'c-1', email: 'alessandra@aloiaaerospace.com', first_name: 'Alessandra', unsubscribed: false, bounce_status: 'none', tags: [], form_submissions: [], ...overrides }
}

function fakeSupabase({ configs = [CFG], cases = [], contacts = [], drafts = [], enrollments = [], recentSent = [], insertError = null } = {}) {
  const state = { caseUpserts: [], caseUpdates: [], contactUpdates: [], enrollments: [], draftUpdates: [], lookups: [] }
  const builder = (table) => {
    const q = { filters: {}, op: null, payload: null }
    const chain = {
      select() { return chain }, not() { return chain }, is() { return chain }, order() { return chain }, limit() { return chain },
      gt() { return chain }, lte() { return chain },
      eq(col, val) { q.filters[col] = val; return chain },
      in(_c, ids) { state.lookups.push(ids); return chain },
      update(p) { q.op = 'update'; q.payload = p; return chain },
      insert(p) { q.op = 'insert'; q.payload = p; return chain },
      upsert(rows) { q.op = 'upsert'; q.payload = rows; return chain },
      async maybeSingle() { return resolve() }, async single() { return resolve() },
      then(ok, err) { return Promise.resolve().then(resolve).then(ok, err) },
    }
    function resolve() {
      if (table === 'ai_followup_config') return { data: q.filters.id ? configs.find(c => c.id === q.filters.id) : configs, error: null }
      if (table === 'salesforce_ai_chat_cases') {
        if (q.op === 'upsert') { state.caseUpserts.push(...q.payload); return { error: null } }
        if (q.op === 'update') { state.caseUpdates.push({ id: q.filters.id, ...q.payload }); return { error: null } }
        if (q.filters.id) return { data: cases.find(c => c.id === q.filters.id) || null, error: null }
        return { data: cases, error: null }
      }
      if (table === 'contacts') {
        if (q.op === 'update') { state.contactUpdates.push({ id: q.filters.id, ...q.payload }); return { error: null } }
        if (q.filters.email) return { data: contacts.find(c => c.email === q.filters.email) || null, error: null }
        return { data: contacts, error: null }
      }
      if (table === 'ai_followup_drafts') {
        if (q.op === 'update') { state.draftUpdates.push({ id: q.filters.id, ...q.payload }); return { error: null } }
        if (q.filters.status === 'sent') return { data: recentSent, error: null }
        return { data: drafts, error: null }
      }
      if (table === 'ai_followup_contacts') {
        if (q.op === 'insert') {
          if (insertError) return { data: null, error: insertError }
          const row = { id: `enr-${state.enrollments.length + 1}`, ...q.payload }; state.enrollments.push(row); return { data: { id: row.id }, error: null }
        }
        if (q.op === 'update') return { error: null }
        if (q.filters.id) return { data: enrollments.find(e => e.id === q.filters.id) || null, error: null }
        return { data: [], error: null }
      }
      throw new Error(`unexpected table ${table}`)
    }
    return chain
  }
  return { state, from: builder }
}

test('parses the transcript, keeps pages and session, drops the IP, extracts visitor lines', () => {
  const p = parseCaseDescription(DESCRIPTION)
  assert.deepEqual(p.pages, ['https://alconox.com/product/liquinox/'])
  assert.equal(p.sessionId, '770c84cc-471a-4b9b-82ff-1eebc6306435')
  assert.equal(p.chatAt, '2026-09-16T16:25:13.000Z')
  assert.deepEqual(p.visitorMessages, ['Please I need to buy 2 ea - Catalog Number: 1201-1', 'does it come with COA ?'])
  assert.doesNotMatch(p.transcript, /93\.186\.157\.136/)
  assert.doesNotMatch(p.transcript, /IP:/)
  assert.match(p.transcript, /Alconox: Yes, our products come with a Certificate/)
  assert.match(p.transcript, /Session: 770c84cc/)
})

test('mapCase lowercases the email and never carries the IP anywhere', () => {
  const row = mapCase(sfCase(), CLIENT)
  assert.equal(row.email, 'alessandra@aloiaaerospace.com')
  assert.equal(row.web_page, 'https://alconox.com/product/liquinox/')
  assert.equal(row.chat_at, '2026-09-16T16:25:13.000Z')
  assert.doesNotMatch(JSON.stringify(row), /93\.186\.157\.136/)
})

test('sync queries AI Chat cases incrementally and upserts them', async () => {
  const supabase = fakeSupabase()
  const queries = []
  const conn = { async query(soql) { queries.push(soql); return { records: [sfCase()], done: true } } }
  const result = await syncAiChatCases({ supabase, getSalesforceConnection: async () => conn }, CLIENT, '2026-09-21T06:00:00.000Z')
  assert.equal(result.count, 1)
  assert.match(queries[0], /FROM Case WHERE Case_Origin_Subtype__c = 'AI Chat' AND LastModifiedDate > 2026-09-21T06:00:00.000Z/)
  assert.equal(supabase.state.caseUpserts[0].case_number, '00001054')
  assert.equal(supabase.state.caseUpserts[0].followup_processed_at, undefined)
})

test('decide enforces cutover, internal, empty-chat, and suppression rules', () => {
  assert.equal(decide(caseRow(), [CFG], contact(), NOW).action, 'enroll')
  assert.equal(decide(caseRow({ chat_at: '2026-09-10T00:00:00Z' }), [CFG], contact(), NOW).reason, 'before_cutover')
  assert.equal(decide(caseRow(), [{ ...CFG, chat_trigger_since: null }], contact(), NOW).action, 'hold')
  assert.equal(decide(caseRow({ email: 'cheyenne@cloudadoptionsolutions.com' }), [CFG], contact(), NOW).reason, 'internal_domain')
  assert.equal(decide(caseRow({ email: 'stacy@alconox.com' }), [CFG], contact(), NOW).reason, 'internal_domain')
  assert.equal(decide(caseRow({ visitor_messages: [] }), [CFG], contact(), NOW).reason, 'empty_chat')
  assert.equal(decide(caseRow(), [CFG], contact({ bounce_status: 'hard' }), NOW).reason, 'hard_bounced')
  assert.equal(decide(caseRow(), [CFG], contact({ unsubscribed: true }), NOW).reason, 'unsubscribed')
  assert.equal(decide(caseRow(), [CFG], null, NOW).action, 'hold')
  assert.equal(decide(caseRow(), [], contact(), NOW).reason, 'no_chat_agent')
})

test('enrolls a case once, records the source, and hands the model only the visitor side', async () => {
  const supabase = fakeSupabase({ cases: [caseRow()], contacts: [contact()] })
  const generated = []
  const result = await enrollChatFollowups({ supabase, generateDraft: async (c, g) => generated.push([c, g]), now: NOW }, CLIENT)
  assert.equal(result.enrolled.length, 1)
  assert.deepEqual(generated, [['c-1', 'cfg-chat']])
  assert.equal(supabase.state.enrollments[0].source_case_id, 'case-1')
  const sub = supabase.state.contactUpdates[0].form_submissions.at(-1)
  assert.equal(sub.form_name, 'AI Chat')
  assert.match(sub.fields.Topic, /does it come with COA/)
  assert.doesNotMatch(JSON.stringify(sub), /Certificate of Analysis/) // bot answer never reaches the prompt
  assert.equal(supabase.state.caseUpdates[0].followup_enrollment_id, 'enr-1')
})

test('duplicate person is recorded as already enrolled; dry run writes nothing', async () => {
  const dup = fakeSupabase({ cases: [caseRow()], contacts: [contact()], insertError: { code: '23505' } })
  const r1 = await enrollChatFollowups({ supabase: dup, generateDraft: async () => assert.fail('no'), now: NOW }, CLIENT)
  assert.deepEqual(r1.skipped.map(s => s.reason), ['already_enrolled'])

  const dry = fakeSupabase({ cases: [caseRow(), caseRow({ id: 'c2', email: 'x@alconox.com' })], contacts: [contact()] })
  const r2 = await enrollChatFollowups({ supabase: dry, now: NOW }, CLIENT, { dryRun: true })
  assert.equal(r2.enrolled.length, 1)
  assert.equal(r2.skipped.length, 1)
  assert.equal(dry.state.enrollments.length, 0)
  assert.equal(dry.state.caseUpdates.length, 0)
  assert.equal(dry.state.contactUpdates.length, 0)
})

test('review tokens verify only for the same draft, reviewer, and expiry', () => {
  const exp = NOW.getTime() + 1000
  const t = signReviewToken('d1', 'Sage@SageRock.com', exp)
  assert.equal(verifyReviewToken({ draftId: 'd1', reviewerEmail: 'sage@sagerock.com', expiresAt: exp, token: t }, undefined, NOW.getTime()).ok, true)
  assert.equal(verifyReviewToken({ draftId: 'd2', reviewerEmail: 'sage@sagerock.com', expiresAt: exp, token: t }, undefined, NOW.getTime()).reason, 'bad_signature')
  assert.equal(verifyReviewToken({ draftId: 'd1', reviewerEmail: 'other@x.com', expiresAt: exp, token: t }, undefined, NOW.getTime()).reason, 'bad_signature')
  assert.equal(verifyReviewToken({ draftId: 'd1', reviewerEmail: 'sage@sagerock.com', expiresAt: exp, token: t }, undefined, exp + 1).reason, 'expired')
  assert.equal(verifyReviewToken({ draftId: 'd1', reviewerEmail: 'sage@sagerock.com', expiresAt: 'nope', token: t }).reason, 'malformed')
  const url = reviewUrl('https://mail.sagerock.com/', 'd1', 'sage@sagerock.com', exp)
  assert.match(url, /^https:\/\/mail\.sagerock\.com\/api\/ai-followup\/review\/d1\?r=sage%40sagerock\.com&e=\d+&t=[0-9a-f]{64}$/)
})

test('review email carries draft, case, transcript, and a personal link; reviewers parse from config', () => {
  const draft = { id: 'd1', subject: 'Thanks for chatting with us — Alconox, LLC', plain_text: 'Hi Alessandra,\n\nThanks.' }
  const mail = buildReviewEmail({ draft, contact: contact(), config: CFG, caseRow: caseRow({ transcript: 'Visitor: hi\nAlconox: hello' }), reviewerEmail: 'sage@sagerock.com', baseUrl: 'https://mail.sagerock.com', expiresAt: NOW.getTime() + 1000 })
  assert.match(mail.subject, /Review: chat follow-up to Alessandra \(Aloia Aerospace\) — case 00001054/)
  assert.match(mail.text, /Thanks for chatting with us — Alconox, LLC/)
  assert.match(mail.text, /Visitor: hi/)
  assert.match(mail.html, /Review this draft/)
  assert.match(mail.link, /r=sage%40sagerock\.com/)
  assert.deepEqual(parseReviewers(CFG), ['a@alconox.com', 'sage@sagerock.com'])
})

test('notifyPendingChatReviews emails each reviewer once per pending draft and marks it', async () => {
  const draft = { id: 'd1', subject: 'S', plain_text: 'B', contact_id: 'c-1', followup_contact_id: 'enr-1', created_at: '2026-09-23T00:00:00Z', contact: contact() }
  const supabase = fakeSupabase({ drafts: [draft], enrollments: [{ id: 'enr-1', source_case_id: 'case-1' }], cases: [caseRow({ transcript: 'T' })] })
  const sent = []
  const out = await notifyPendingChatReviews({ supabase, sendMail: async (cid, msg) => sent.push(msg), baseUrl: 'https://mail.sagerock.com', now: NOW }, CLIENT)
  assert.deepEqual(sent.map(m => m.to), ['a@alconox.com', 'sage@sagerock.com'])
  assert.match(sent[0].subject, /case 00001054/)
  assert.equal(out.notified[0].case_number, '00001054')
  assert.equal(supabase.state.draftUpdates[0].id, 'd1')
  assert.ok(supabase.state.draftUpdates[0].review_notified_at)

  // onlyReviewers restricts recipients (used for the first sample to Sage) and dryRun leaves the draft unmarked.
  const s2 = fakeSupabase({ drafts: [draft], enrollments: [{ id: 'enr-1', source_case_id: 'case-1' }], cases: [caseRow()] })
  const sent2 = []
  await notifyPendingChatReviews({ supabase: s2, sendMail: async (cid, msg) => sent2.push(msg), baseUrl: 'https://mail.sagerock.com', now: NOW }, CLIENT, { onlyReviewers: ['sage@sagerock.com'], dryRun: true })
  assert.deepEqual(sent2.map(m => m.to), ['sage@sagerock.com'])
  assert.equal(s2.state.draftUpdates.length, 0)
})

test('chat submission truncates the topic and carries the page', () => {
  const s = chatSubmission(caseRow({ visitor_messages: ['x'.repeat(1000)] }))
  assert.equal(s.fields.Topic.length, 600)
  assert.equal(s.fields.Page, 'https://alconox.com/product/liquinox/')
  assert.equal(s.case_number, '00001054')
})
