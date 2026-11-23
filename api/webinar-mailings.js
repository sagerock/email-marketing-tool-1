'use strict'
// Event mail to webinar registrants: day-before and hour-before reminders with the Zoom
// link, then the recording + checklist (Jax item #4351, migration 128). Same rules as the
// confirmation: fixed content, registrants come from webinar_registrations (not tag
// campaigns, which skip unsubscribed=true), one webinar_mailings row per (registration,
// kind) is the reservation, an uncertain send is never retried.
const { CLIENT_ID, EVENTS } = require('./public-webinar-registration')

// Addresses that registered only to test the page (alma-partners README, 2026-11-18).
const TEST_EMAILS = new Set(['sage+webinar-test@sagerock.com', 'sage+webinar-test2@sagerock.com'])

// When each kind may go out (UTC). Outside its window the run refuses, so a mistyped
// command can't send the hour-before reminder a day early or the recording before the session.
const WINDOWS = {
  'budget-2026-12-08': {
    'reminder-day': ['2026-12-07T13:00:00Z', '2026-12-08T05:00:00Z'], // Dec 7, 8am ET to midnight
    'reminder-hour': ['2026-12-08T18:45:00Z', '2026-12-08T20:00:00Z'], // Dec 8, 1:45-3:00pm ET
    'followup': ['2026-12-08T20:45:00Z', '2026-12-31T05:00:00Z'],
  },
}
const KINDS = ['reminder-day', 'reminder-hour', 'followup']

const isHttps = (v, host) => {
  try { const u = new URL(v); return u.protocol === 'https:' && (!host || u.hostname === host || u.hostname.endsWith(`.${host}`)) } catch { return false }
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function checkLinks(kind, links = {}) {
  if (kind === 'followup') {
    if (!isHttps(links.recordingUrl)) return 'followup needs --recording=https://...'
    if (!isHttps(links.checklistUrl)) return 'followup needs --checklist=https://...'
  } else if (!isHttps(links.joinUrl, 'zoom.us')) return `${kind} needs --join=https://...zoom.us/j/... (the meeting's Invite Link)`
  return null
}

// Fixed content: nothing from the registration appears in the email.
function mailingMessage(key, kind, email, registrationId, links) {
  const e = EVENTS[key]
  const reason = `You’re getting this because you registered at ${e.page.replace('https://', '')}.`
  let subject, paras, link
  if (kind === 'reminder-day') {
    subject = 'Tomorrow at 3pm ET: Planning for 2027-28'
    paras = [`A reminder that ${e.title}, with ${e.hosts}, is tomorrow: ${e.when}, ${e.time}.`, 'Here’s your Zoom link:']
    link = links.joinUrl
  } else if (kind === 'reminder-hour') {
    subject = 'Starting in one hour: Planning for 2027-28'
    paras = [`We start at 3:00pm Eastern, one hour from now. ${e.hosts} will keep it to 45 minutes.`, 'Join on Zoom:']
    link = links.joinUrl
  } else {
    subject = 'The recording and your planning checklist'
    paras = [`Thank you for registering for ${e.title}. Whether you joined live or couldn’t make it, here’s the recording:`]
    link = links.recordingUrl
  }
  const after = kind === 'followup'
    ? ['And the one-page planning checklist for your budget season:', links.checklistUrl, 'Questions? Just reply.']
    : ['Questions before then? Just reply.']
  const text = [...paras, link, ...after, '- Jax', reason].join('\n\n')
  const a = (url, label) => `<a href="${esc(url)}" style="color:#285448">${esc(label)}</a>`
  const htmlParas = [...paras.map(p => `<p>${esc(p)}</p>`), `<p>${a(link, link)}</p>`,
    ...after.map(p => isHttps(p) ? `<p>${a(p, 'Download the checklist')}</p>` : `<p>${esc(p)}</p>`), '<p>- Jax</p>']
  return {
    to: email, from: { email: 'jax@sagerock.com', name: 'Jax at SageRock' },
    replyTo: { email: 'jax@sagerock.com', name: 'Jax at SageRock' },
    subject, text,
    html: `<div style="font:16px/1.6 Arial,sans-serif;color:#253c34;max-width:580px">${htmlParas.join('')}<p style="font-size:12px;color:#58685c">${esc(reason)}</p></div>`,
    categories: ['client-sagerock', `webinar-${kind}`],
    customArgs: { webinar_registration_id: registrationId, webinar_mailing: kind },
    trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } },
  }
}

// Who gets this kind: every registrant except test rows, hard bounces, people who
// unsubscribed after registering, and anyone with a row for this kind already.
function planRecipients(registrations, kind) {
  const out = []
  for (const r of registrations) {
    const email = (r.email || '').toLowerCase()
    let skip = null
    if (TEST_EMAILS.has(email)) skip = 'test_row'
    else if (r.mailings?.includes(kind)) skip = 'already_has_row'
    else if (r.bounce_status === 'hard') skip = 'hard_bounce'
    else if (r.unsubscribed_at && new Date(r.unsubscribed_at) > new Date(r.created_at)) skip = 'unsubscribed_after_registering'
    out.push({ id: r.id, email, skip })
  }
  return out
}

async function runMailing({ store, sendMail, event, kind, links, send = false, now = () => new Date(), only = null }) {
  if (!EVENTS[event] || !WINDOWS[event]) throw new Error(`unknown event ${event}`)
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  const bad = checkLinks(kind, links)
  if (bad) throw new Error(bad)
  const [from, to] = WINDOWS[event][kind].map(s => new Date(s))
  const t = now()
  if (send && (t < from || t >= to)) throw new Error(`not_due: ${kind} may go out ${from.toISOString()} to ${to.toISOString()}`)
  let plan = planRecipients(await store.registrations(event), kind)
  if (only) plan = plan.filter(p => p.email === only.toLowerCase())
  const results = []
  for (const p of plan) {
    if (p.skip || !send) { results.push({ email: p.email, status: p.skip || 'would_send' }); continue }
    // The row is the reservation: if another run already made it, this one sends nothing.
    const mailingId = await store.reserve(p.id, kind)
    if (!mailingId) { results.push({ email: p.email, status: 'already_reserved' }); continue }
    try {
      const r = await sendMail(mailingMessage(event, kind, p.email, p.id, links))
      await store.finish(mailingId, { status: 'sent', provider_message_id: r?.messageId || null })
      results.push({ email: p.email, status: 'sent' })
    } catch (error) {
      const known = Number.isInteger(error?.code) && error.code >= 400 && error.code < 500
      await store.finish(mailingId, { status: known ? 'failed' : 'uncertain', error_code: known ? `provider_${error.code}` : 'send_not_confirmed' })
      results.push({ email: p.email, status: known ? 'failed' : 'uncertain' })
    }
  }
  return results
}

function createMailingStore(supabase) {
  return {
    async registrations(event) {
      const { data, error } = await supabase.from('webinar_registrations')
        .select('id,email,created_at,contacts(bounce_status,unsubscribed_at),webinar_mailings(kind)')
        .eq('client_id', CLIENT_ID).eq('event', event)
      if (error) throw new Error(`registrations: ${error.message}`)
      return data.map(r => ({ id: r.id, email: r.email, created_at: r.created_at, bounce_status: r.contacts?.bounce_status,
        unsubscribed_at: r.contacts?.unsubscribed_at, mailings: (r.webinar_mailings || []).map(m => m.kind) }))
    },
    async reserve(registrationId, kind) {
      const { data, error } = await supabase.from('webinar_mailings').insert({ registration_id: registrationId, kind }).select('id').single()
      if (error?.code === '23505') return null
      if (error) throw new Error(`reserve: ${error.message}`)
      return data.id
    },
    async finish(id, patch) {
      const { error } = await supabase.from('webinar_mailings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) console.error(`webinar mailing ${id} needs status reconciliation`)
    },
  }
}

module.exports = { TEST_EMAILS, WINDOWS, KINDS, checkLinks, mailingMessage, planRecipients, runMailing, createMailingStore }
