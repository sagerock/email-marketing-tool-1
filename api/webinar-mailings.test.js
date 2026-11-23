const test = require('node:test')
const assert = require('node:assert/strict')
const { mailingMessage, planRecipients, runMailing, checkLinks } = require('./webinar-mailings')

const EV = 'budget-2026-12-08'
const links = { joinUrl: 'https://us06web.zoom.us/j/86371849307?pwd=abc', recordingUrl: 'https://sagerock.com/r', checklistUrl: 'https://sagerock.com/c.pdf' }
const regs = () => [
  { id: 'r1', email: 'head@school.org', created_at: '2026-11-20T00:00:00Z' },
  { id: 't1', email: 'sage+webinar-test@sagerock.com', created_at: '2026-11-18T00:00:00Z' },
  { id: 't2', email: 'SAGE+webinar-test2@sagerock.com', created_at: '2026-11-18T00:00:00Z' },
  { id: 'b1', email: 'bounce@school.org', created_at: '2026-11-20T00:00:00Z', bounce_status: 'hard' },
  { id: 'u1', email: 'left@school.org', created_at: '2026-11-20T00:00:00Z', unsubscribed_at: '2026-11-25T00:00:00Z' },
  { id: 'u2', email: 'oldunsub@school.org', created_at: '2026-11-20T00:00:00Z', unsubscribed_at: '2026-01-01T00:00:00Z' },
  { id: 'd1', email: 'done@school.org', created_at: '2026-11-20T00:00:00Z', mailings: ['reminder-day'] },
]
function fixture(sendMail) {
  const reserved = new Map(); const finished = {}; const sent = []
  const store = {
    registrations: async () => regs(),
    reserve: async (id, kind) => { const k = `${id}:${kind}`; if (reserved.has(k)) return null; reserved.set(k, `m-${k}`); return `m-${k}` },
    finish: async (id, patch) => { finished[id] = patch },
  }
  return { store, finished, sent, sendMail: sendMail || (async m => { sent.push(m); return { messageId: 'p1' } }) }
}
const dayOf = () => new Date('2026-12-07T15:00:00Z')

test('skips test rows, hard bounces, unsubscribed after registering, existing rows', () => {
  const p = Object.fromEntries(planRecipients(regs(), 'reminder-day').map(r => [r.id, r.skip]))
  assert.deepEqual(p, { r1: null, t1: 'test_row', t2: 'test_row', b1: 'hard_bounce', u1: 'unsubscribed_after_registering', u2: null, d1: 'already_has_row' })
})

test('reminders need a zoom.us https link; follow-up needs recording and checklist', () => {
  assert.match(checkLinks('reminder-day', {}), /zoom/)
  assert.match(checkLinks('reminder-hour', { joinUrl: 'https://evil.example/zoom.us' }), /zoom/)
  assert.equal(checkLinks('reminder-day', links), null)
  assert.match(checkLinks('followup', { recordingUrl: links.recordingUrl }), /checklist/)
  assert.equal(checkLinks('followup', links), null)
})

test('fixed content, Jax signature, link present, tracking off', () => {
  const m = mailingMessage(EV, 'reminder-day', 'head@school.org', 'r1', links)
  assert.equal(m.from.email, 'jax@sagerock.com'); assert.match(m.subject, /Tomorrow at 3pm ET/)
  assert.ok(m.text.includes(links.joinUrl)); assert.ok(m.text.includes('- Jax'))
  assert.equal(m.trackingSettings.clickTracking.enable, false)
  const f = mailingMessage(EV, 'followup', 'head@school.org', 'r1', links)
  assert.ok(f.text.includes(links.recordingUrl) && f.text.includes(links.checklistUrl))
  assert.ok(!f.text.includes('zoom.us'))
})

test('dry run sends nothing and writes nothing', async () => {
  const f = fixture()
  const r = await runMailing({ ...f, event: EV, kind: 'reminder-day', links, now: dayOf })
  assert.equal(f.sent.length, 0); assert.deepEqual(f.finished, {})
  assert.deepEqual(r.filter(x => x.status === 'would_send').map(x => x.email), ['head@school.org', 'oldunsub@school.org'])
})

test('send outside the window is refused', async () => {
  const f = fixture()
  await assert.rejects(runMailing({ ...f, event: EV, kind: 'reminder-hour', links, send: true, now: dayOf }), /not_due/)
  await assert.rejects(runMailing({ ...f, event: EV, kind: 'followup', links, send: true, now: () => new Date('2026-12-08T20:00:00Z') }), /not_due/)
  assert.equal(f.sent.length, 0)
})

test('sends once per registrant; a second run sends nothing', async () => {
  const f = fixture()
  await runMailing({ ...f, event: EV, kind: 'reminder-day', links, send: true, now: dayOf })
  assert.equal(f.sent.length, 2)
  const again = await runMailing({ ...f, event: EV, kind: 'reminder-day', links, send: true, now: dayOf })
  assert.equal(f.sent.length, 2); assert.ok(again.every(x => x.status !== 'sent'))
})

test('provider timeout is recorded uncertain, a 4xx failed, never retried', async () => {
  let n = 0
  const f = fixture(async () => { n++; if (n === 1) { const e = new Error('x'); e.code = 400; throw e } throw new Error('timeout') })
  const r = await runMailing({ ...f, event: EV, kind: 'reminder-day', links, send: true, now: dayOf })
  assert.deepEqual(r.filter(x => ['failed', 'uncertain'].includes(x.status)).map(x => x.status), ['failed', 'uncertain'])
  assert.equal(n, 2)
})

test('--only limits the run to one address', async () => {
  const f = fixture()
  await runMailing({ ...f, event: EV, kind: 'reminder-day', links, send: true, now: dayOf, only: 'HEAD@school.org' })
  assert.deepEqual(f.sent.map(m => m.to), ['head@school.org'])
})
