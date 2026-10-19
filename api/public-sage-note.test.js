const { test } = require('node:test')
const assert = require('node:assert/strict')

const { validateSageNote, buildSageNoteEmail, createSageNoteHandler } = require('./public-sage-note')

function fakeRes() {
  return {
    code: 200, body: null,
    status(c) { this.code = c; return this },
    json(b) { this.body = b; return this },
  }
}

function fakeSupabase(row) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row }) }
  return { from: () => q }
}

const quiet = { log() {}, error() {} }

test('honeypot is accepted silently and sends nothing', async () => {
  const sent = []
  const h = createSageNoteHandler({ supabase: fakeSupabase(null), sendMail: async (m) => sent.push(m), log: quiet })
  const res = fakeRes()
  await h({ body: { email: 'a@b.com', message: 'hi', _gotcha: 'bot' } }, res)
  assert.equal(res.body.ok, true)
  assert.equal(sent.length, 0)
})

test('requires a valid email and a message', () => {
  assert.ok(validateSageNote({ email: 'nope', message: 'x' }).error)
  assert.ok(validateSageNote({ email: 'a@b.com', message: '   ' }).error)
  assert.ok(validateSageNote({ email: 'a@b.com', message: 'hello' }).value)
})

test('bad ref codes are dropped, names lose newlines', () => {
  const v = validateSageNote({ email: 'A@B.com', message: 'hi', ref: '../x', name: 'Max\r\nBcc: x' }).value
  assert.equal(v.ref, null)
  assert.equal(v.email, 'a@b.com')
  assert.equal(v.name, 'Max Bcc: x')
})

test('note goes to Sage with Reply-To the sender and names the link', async () => {
  const sent = []
  const sb = fakeSupabase({ code: 'e2079b', campaign: 'lawyers-2026-10', sr_people: { first_name: 'Max', last_name: 'Thomas' }, sr_orgs: { name: 'MWT Law' } })
  const h = createSageNoteHandler({ supabase: sb, sendMail: async (m) => sent.push(m), log: quiet })
  const res = fakeRes()
  await h({ body: { name: 'Max Thomas', email: 'max@x.com', message: 'Sure, a video call works.', ref: 'e2079b' } }, res)
  assert.equal(res.body.ok, true)
  assert.equal(sent[0].to, 'sage@sagerock.com')
  assert.deepEqual(sent[0].replyTo, { email: 'max@x.com', name: 'Max Thomas' })
  assert.match(sent[0].text, /sent to Max Thomas, MWT Law/)
  assert.match(sent[0].subject, /Note from Max Thomas/)
})

test('a send failure returns 500 with a fallback address', async () => {
  const h = createSageNoteHandler({ supabase: fakeSupabase(null), sendMail: async () => { throw new Error('sg down') }, log: quiet })
  const res = fakeRes()
  await h({ body: { email: 'a@b.com', message: 'hi' } }, res)
  assert.equal(res.code, 500)
  assert.match(res.body.error, /sage@sagerock.com/)
})

test('no ref says the visitor came directly', () => {
  const m = buildSageNoteEmail({ name: null, email: 'a@b.com', message: 'hi', ref: null }, null)
  assert.match(m.text, /No personal link/)
  assert.deepEqual(m.replyTo, { email: 'a@b.com' })
})

test('a link with no person says so instead of "not found"', () => {
  const m = buildSageNoteEmail({ name: null, email: 'a@b.com', message: 'hi', ref: 'jaxtest' }, { person: null, org: null, campaign: 'test' })
  assert.match(m.text, /jaxtest \(test, no person attached\)/)
})
