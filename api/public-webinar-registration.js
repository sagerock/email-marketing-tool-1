'use strict'
// Public webinar registration (sagerock.com/budget-webinar/, Sage approved 2026-11-18).
// Records the registrant in the SageRock CRM and sends one fixed confirmation with a
// calendar file. Mirrors public-intake-guide.js: fixed content, server-owned tenant,
// durable duplicate protection, no newsletter or sequence enrollment.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const { clientIp } = require('./public-list-signup')
const CLIENT_ID = 'dab0af79-80db-4e91-854c-be1b5ccd7288' // SageRock
const HEARD_FROM = ['alma', 'sagerock', 'other']
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
const clip = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : ''

// Server-owned event facts. The CRM tag is derived in SQL as 'webinar-' || key.
const EVENTS = {
  'budget-2026-12-08': {
    title: 'Planning for 2027-28: Advancement, Admissions and Marketing',
    hosts: 'Rocky Lewis of SageRock and Vicki Larson of Alma Partners',
    when: 'Tuesday, December 8, 2026',
    time: '3:00-3:45pm Eastern, on Zoom',
    start: '20261208T200000Z', // 3:00pm EST
    end: '20261208T204500Z',
    closesAt: '2026-12-08T20:45:00Z',
    page: 'https://sagerock.com/budget-webinar/',
  },
}
const tagFor = event => `webinar-${event}`

const webinarLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8,
  keyGenerator: req => ipKeyGenerator(clientIp(req)),
  validate: { xForwardedForHeader: false },
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Please try again in a few minutes.' },
})

function validateRegistration(body) {
  const event = clip(body?.event, 60)
  const email = clip(body?.email, 200).toLowerCase()
  const name = clip(body?.name, 120)
  const school = clip(body?.school, 200)
  const role = clip(body?.role, 120)
  const heard_from = clip(body?.heard_from, 20)
  if (!EVENTS[event] || !name || !school || !role || !HEARD_FROM.includes(heard_from)
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  const attribution = {}
  for (const k of UTM_KEYS) { const v = clip(body.attribution?.[k], 120); if (v) attribution[k] = v }
  return { event, email, name, school, role, heard_from, marketing: body.marketing === true, attribution }
}

// RFC 5545 text escaping and 75-octet line folding (ASCII content only).
const icsText = s => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
const fold = line => { const out = []; let rest = line; while (rest.length > 75) { out.push(rest.slice(0, 75)); rest = ' ' + rest.slice(75) } out.push(rest); return out.join('\r\n') }

function calendarFile(key) {
  const e = EVENTS[key]
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SageRock//Webinar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${key}@sagerock.com`, 'DTSTAMP:20261118T120000Z',
    `DTSTART:${e.start}`, `DTEND:${e.end}`,
    `SUMMARY:${icsText(e.title)}`,
    `DESCRIPTION:${icsText(`A free live conversation with ${e.hosts}. The Zoom link comes in the reminder emails.`)}`,
    `LOCATION:${icsText('Zoom (link in the reminder emails)')}`,
    `URL:${e.page}`, 'END:VEVENT', 'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n'
}

function googleCalendarUrl(key) {
  const e = EVENTS[key]
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${e.start}/${e.end}`,
    details: `A free live conversation with ${e.hosts}. The Zoom link comes in the reminder emails. ${e.page}`, location: 'Zoom' })
  return `https://calendar.google.com/calendar/render?${q}`
}

// Fixed confirmation. Nothing from the request appears in the content, so the form
// cannot be used to send arbitrary text to arbitrary addresses.
function confirmationMessage(email, key, registrationId) {
  const e = EVENTS[key]
  const gcal = googleCalendarUrl(key)
  const lead = `You’re registered for ${e.title}, a free live conversation with ${e.hosts}.`
  const zoom = 'We’ll send the Zoom link in reminder emails before the session. Afterward, every registrant gets the recording and a one-page planning checklist.'
  const reply = 'Questions before then? Just reply.'
  const reason = `You’re getting this because you registered at ${e.page.replace('https://', '')}.`
  const attr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return {
    to: email, from: { email: 'jax@sagerock.com', name: 'Jax at SageRock' },
    replyTo: { email: 'jax@sagerock.com', name: 'Jax at SageRock' },
    subject: 'You’re registered: Planning for 2027-28, Dec 8 at 3pm ET',
    text: `${lead}\n\n${e.when}\n${e.time}\n\nThe calendar file is attached, or add it to Google Calendar:\n${gcal}\n\n${zoom}\n\n${reply}\n\n- Jax\n\n${reason}`,
    html: `<div style="font:16px/1.6 Arial,sans-serif;color:#253c34;max-width:580px"><p>${lead}</p><p>${e.when}<br>${e.time}</p><p>The calendar file is attached, or <a href="${attr(gcal)}" style="color:#285448">add it to Google Calendar</a>.</p><p>${zoom}</p><p>${reply}</p><p>- Jax</p><p style="font-size:12px;color:#58685c">${reason}</p></div>`,
    attachments: [{ content: Buffer.from(calendarFile(key)).toString('base64'), filename: 'planning-for-2027-28-webinar.ics', type: 'text/calendar', disposition: 'attachment' }],
    categories: ['client-sagerock', 'webinar-confirmation'],
    customArgs: { webinar_registration_id: registrationId },
    trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } },
  }
}

const publicStatus = s => s === 'sent' ? 'already_sent' : s === 'sending' ? 'pending' : 'unavailable'

function createWebinarHandler({ store, sendMail, now = () => new Date(), logger = console }) {
  return async (req, res) => {
    if (clip(req.body?.website, 200)) return res.json({ ok: true, already_registered: false, email_status: 'unavailable' })
    const value = validateRegistration(req.body)
    if (!value) return res.status(400).json({ ok: false, error: 'Please fill in every field.' })
    if (now() >= new Date(EVENTS[value.event].closesAt)) return res.status(410).json({ ok: false, error: 'closed' })
    let reg
    try { reg = await store.register(value) }
    catch { logger.error('webinar: registration save failed'); return res.status(503).json({ ok: false, error: 'Please try again.' }) }
    // The registration row is the reservation: only its first insert sends.
    if (!reg.created) return res.json({ ok: true, already_registered: true, email_status: publicStatus(reg.confirmation_status) })
    const finish = async patch => {
      try { await store.finish(reg.registration_id, patch) }
      catch { logger.error(`webinar: registration ${reg.registration_id} needs status reconciliation`) }
    }
    if (reg.bounce_status === 'hard') {
      await finish({ confirmation_status: 'suppressed', error_code: 'hard_bounce' })
      return res.json({ ok: true, already_registered: false, email_status: 'unavailable' })
    }
    try {
      const result = await sendMail(confirmationMessage(value.email, value.event, reg.registration_id))
      await finish({ confirmation_status: 'sent', provider_message_id: result?.messageId || null })
      return res.json({ ok: true, already_registered: false, email_status: 'sent' })
    } catch (error) {
      // A provider timeout may have accepted the email: keep the row, never retry.
      const known = Number.isInteger(error?.code) && error.code >= 400 && error.code < 500
      await finish({ confirmation_status: known ? 'failed' : 'uncertain', error_code: known ? `provider_${error.code}` : 'send_not_confirmed' })
      return res.json({ ok: true, already_registered: false, email_status: 'unavailable' })
    }
  }
}

function createWebinarStore(supabase) {
  return {
    async register(v) {
      const { data, error } = await supabase.rpc('record_webinar_registration', {
        p_event: v.event, p_email: v.email, p_name: v.name, p_school: v.school, p_role: v.role,
        p_heard_from: v.heard_from, p_marketing: v.marketing, p_attribution: v.attribution,
      })
      if (error || !data?.registration_id) throw new Error('registration_save')
      return data
    },
    async finish(id, patch) {
      const { error } = await supabase.from('webinar_registrations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('client_id', CLIENT_ID)
      if (error) throw new Error('status_save')
    },
  }
}

module.exports = { CLIENT_ID, EVENTS, tagFor, webinarLimiter, validateRegistration, calendarFile, googleCalendarUrl, confirmationMessage, createWebinarHandler, createWebinarStore }
