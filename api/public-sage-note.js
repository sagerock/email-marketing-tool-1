'use strict'

// Public "send Sage a note" form on sagerock.com/sage (2026-10-19).
//
// Lawyers get a personal link (?r=<code>) to Sage's page; a mailto button there rarely
// worked, so the page has a small form instead. Each note is emailed to Sage with
// Reply-To set to the sender, so answering is just Reply. If the visitor came in on a
// personal link, the note says whose link it was (sr_links -> sr_people/sr_orgs).
// Nothing is stored and nothing is sent to the visitor.

const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')

const SAGE = 'sage@sagerock.com'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_RE = /^[a-z0-9]{4,10}$/

// Same X-Forwarded-For keying as public-list-signup.js (no 'trust proxy' behind Railway).
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : ''
  return first || req.ip || ''
}

const sageNoteLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  validate: { xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please try again in a few minutes.' },
})

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

// Returns { spam: true }, { error }, or { value: { name, email, message, ref } }.
function validateSageNote(body) {
  const b = body || {}
  if (clip(b._gotcha, 100)) return { spam: true }
  const email = clip(b.email, 254).toLowerCase()
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' }
  const message = clip(b.message, 4000)
  if (!message) return { error: 'Please write a short note.' }
  const ref = clip(b.ref, 10).toLowerCase()
  return {
    value: {
      name: clip(b.name, 120).replace(/[\r\n]+/g, ' ') || null,
      email,
      message,
      ref: CODE_RE.test(ref) ? ref : null,
    },
  }
}

// Whose personal link was this? Best effort: null on any miss.
async function lookupRef(supabase, ref) {
  if (!ref) return null
  try {
    const { data } = await supabase
      .from('sr_links')
      .select('code, campaign, sr_people(first_name, last_name), sr_orgs(name)')
      .eq('code', ref)
      .maybeSingle()
    if (!data) return null
    const p = data.sr_people
    const person = p ? [p.first_name, p.last_name].filter(Boolean).join(' ') : ''
    return { person: person || null, org: data.sr_orgs?.name || null, campaign: data.campaign || null }
  } catch {
    return null
  }
}

function buildSageNoteEmail({ name, email, message, ref }, link) {
  const who = name || email
  let via = 'No personal link (came to the page directly).'
  if (ref) {
    const target = link ? [link.person, link.org].filter(Boolean).join(', ') : ''
    via = target ? `Personal link ${ref}: sent to ${target}.` : `Personal link ${ref} (not found in sr_links).`
  }
  const text = `${message}\n\n---\nFrom: ${name ? `${name} <${email}>` : email}\n${via}\nSent from the form on sagerock.com/sage. Reply to answer them directly.`
  return {
    to: SAGE,
    from: { email: SAGE, name: 'sagerock.com/sage' },
    replyTo: name ? { email, name } : { email },
    subject: `Note from ${who} (sagerock.com/sage)`,
    text,
  }
}

function createSageNoteHandler({ supabase, sendMail, log = console }) {
  return async (req, res) => {
    const v = validateSageNote(req.body)
    if (v.spam) return res.json({ ok: true })
    if (v.error) return res.status(400).json({ ok: false, error: v.error })
    try {
      const link = await lookupRef(supabase, v.value.ref)
      await sendMail(buildSageNoteEmail(v.value, link))
      log.log(`📨 sage-note from ${v.value.email}${v.value.ref ? ` (ref ${v.value.ref})` : ''}`)
      return res.json({ ok: true })
    } catch (err) {
      log.error('❌ sage-note send failed:', err?.message || err)
      return res.status(500).json({ ok: false, error: 'Something went wrong. Please email sage@sagerock.com.' })
    }
  }
}

module.exports = { sageNoteLimiter, validateSageNote, lookupRef, buildSageNoteEmail, createSageNoteHandler }
