const test = require('node:test')
const assert = require('node:assert/strict')
const { validateRegistration, confirmationMessage, calendarFile, createWebinarHandler, tagFor, CLIENT_ID } = require('./public-webinar-registration')

const valid = { event: 'budget-2026-12-08', name: 'Example Head', email: 'Head@Example.org', school: 'Example Waldorf School', role: 'Head of School', heard_from: 'alma', marketing: false, attribution: { utm_source: 'alma' } }

function fixture(overrides = {}) {
  const rows = new Map(); const registrations = []; const messages = []
  const store = {
    register: async v => {
      registrations.push(v)
      const key = JSON.stringify([v.event, v.email])
      if (rows.has(key)) return { ...rows.get(key), created: false }
      const row = { registration_id: `reg-${rows.size + 1}`, contact_id: 'contact-1', confirmation_status: 'sending', bounce_status: null, client_id: CLIENT_ID }
      rows.set(key, row)
      return { ...row, created: true }
    },
    finish: async (id, patch) => { for (const r of rows.values()) if (r.registration_id === id) Object.assign(r, patch) },
    ...overrides.store,
  }
  const handler = createWebinarHandler({
    store, sendMail: overrides.sendMail || (async m => { messages.push(m); return { messageId: 'provider-1' } }),
    now: overrides.now || (() => new Date('2026-11-18T15:00:00Z')), logger: { error: () => {} },
  })
  const call = async (body = valid) => { const result = { status: 200 }; const res = { status(n) { result.status = n; return this }, json(b) { result.body = b; return this } }; await handler({ body }, res); return result }
  return { call, registrations, messages, rows }
}

test('validates fields, event, heard-from and explicit consent; discards unknown attribution and tenant', () => {
  assert.equal(validateRegistration({ ...valid, email: 'bad' }), null)
  for (const k of ['name', 'school', 'role']) assert.equal(validateRegistration({ ...valid, [k]: '' }), null)
  assert.equal(validateRegistration({ ...valid, heard_from: 'newsletter' }), null)
  assert.equal(validateRegistration({ ...valid, event: 'other-event' }), null)
  const v = validateRegistration({ ...valid, marketing: 'true', client_id: 'other', attribution: { utm_source: 'alma', utm_medium: 'email', email: 'private' } })
  assert.equal(v.email, 'head@example.org'); assert.equal(v.marketing, false); assert.equal(v.client_id, undefined)
  assert.deepEqual(v.attribution, { utm_source: 'alma', utm_medium: 'email' })
  assert.equal(tagFor(v.event), 'webinar-budget-2026-12-08')
})

test('registers and sends one fixed confirmation from jax@ with a calendar file', async () => {
  const f = fixture()
  assert.deepEqual((await f.call()).body, { ok: true, already_registered: false, email_status: 'sent' })
  assert.equal(f.registrations[0].heard_from, 'alma'); assert.equal(f.registrations[0].attribution.utm_source, 'alma'); assert.equal(f.registrations[0].marketing, false)
  assert.equal(f.messages.length, 1)
  const m = f.messages[0]
  assert.equal(m.to, 'head@example.org'); assert.equal(m.from.email, 'jax@sagerock.com'); assert.equal(m.replyTo.email, 'jax@sagerock.com'); assert.equal(m.bcc, undefined)
  assert(m.text.includes('\n- Jax\n')); assert(m.text.includes('Zoom link in reminder emails'))
  assert(m.text.includes('Tuesday, December 8, 2026')); assert(m.text.includes('3:00-3:45pm Eastern'))
  assert.equal(m.attachments.length, 1); assert.equal(m.attachments[0].type, 'text/calendar')
  assert(Buffer.from(m.attachments[0].content, 'base64').toString().includes('DTSTART:20261208T200000Z'))
  assert.equal(m.trackingSettings.openTracking.enable, false); assert.equal(m.trackingSettings.clickTracking.enable, false)
  assert.equal([...f.rows.values()][0].confirmation_status, 'sent')
})

test('second and simultaneous signups with the same email never send a second confirmation', async () => {
  const f = fixture()
  const replies = await Promise.all([f.call(), f.call(), f.call()])
  assert.equal(f.messages.length, 1)
  assert.equal(replies.filter(r => r.body.email_status === 'sent').length, 1)
  const again = await f.call({ ...valid, email: 'head@example.org', name: 'Someone Else' })
  assert.deepEqual(again.body, { ok: true, already_registered: true, email_status: 'already_sent' })
  assert.equal(f.messages.length, 1)
})

test('failed or ambiguous send reports unavailable and never retries', async () => {
  for (const error of [Object.assign(new Error(), { code: 401 }), new Error('timeout')]) {
    let sends = 0; const f = fixture({ sendMail: async () => { sends++; throw error } })
    assert.deepEqual((await f.call()).body, { ok: true, already_registered: false, email_status: 'unavailable' })
    assert.equal((await f.call()).body.already_registered, true); assert.equal(sends, 1)
    assert.equal([...f.rows.values()][0].confirmation_status, error.code ? 'failed' : 'uncertain')
  }
})

test('registration failure stops the send; lost status write cannot cause a second send', async () => {
  const f = fixture({ store: { register: async () => { throw new Error() } } })
  assert.equal((await f.call()).status, 503); assert.equal(f.messages.length, 0)
  const g = fixture({ store: { finish: async () => { throw new Error() } } })
  assert.equal((await g.call()).body.email_status, 'sent'); assert.equal((await g.call()).body.email_status, 'pending'); assert.equal(g.messages.length, 1)
})

test('honeypot, invalid and post-event requests never save or send', async () => {
  const f = fixture()
  await f.call({ ...valid, website: 'bot' })
  assert.equal((await f.call({ ...valid, email: 'invalid' })).status, 400)
  assert.equal(f.registrations.length, 0); assert.equal(f.messages.length, 0)
  const late = fixture({ now: () => new Date('2026-12-08T20:45:00Z') })
  assert.equal((await late.call()).status, 410); assert.equal(late.registrations.length, 0)
})

test('hard-bounced contacts are registered but not emailed', async () => {
  const f = fixture({ store: { register: async () => ({ registration_id: 'reg-1', created: true, confirmation_status: 'sending', bounce_status: 'hard' }), finish: async (id, patch) => { f.patch = patch } } })
  assert.deepEqual((await f.call()).body, { ok: true, already_registered: false, email_status: 'unavailable' })
  assert.equal(f.messages.length, 0); assert.equal(f.patch.confirmation_status, 'suppressed')
})

test('request data cannot change the content; calendar file is valid RFC 5545', () => {
  const m = confirmationMessage('x@example.org', 'budget-2026-12-08', 'reg-1')
  for (const s of [m.text, m.html]) { assert(!s.includes('Example Head')); assert(!s.includes('<script')) }
  const ics = calendarFile('budget-2026-12-08')
  assert(ics.startsWith('BEGIN:VCALENDAR\r\n')); assert(ics.endsWith('END:VCALENDAR\r\n'))
  assert(ics.includes('DTEND:20261208T204500Z')); assert(ics.includes('METHOD:PUBLISH'))
  assert(ics.includes('Advancement\\, Admissions'))
  for (const line of ics.split('\r\n')) assert(Buffer.byteLength(line) <= 75, line)
  assert(!/zoom\.(us|com)/i.test(ics + m.text + m.html), 'no Zoom link is invented')
})
