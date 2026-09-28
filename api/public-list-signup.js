'use strict'

// Public "join a list" signups from SageRock web pages.
//
// A list is just a set of contact tags on the public-signup client
// (PUBLIC_SIGNUP_CLIENT_ID). Only lists named here can be joined, so a caller
// can't invent tags. Welcome mail is not sent from this endpoint: an
// email_sequences row with trigger_type 'tag_added' on the list's first tag
// picks up new contacts on the next scheduler tick.

const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')

const PUBLIC_LISTS = {
  'law-firm-workspace': {
    tags: ['law-firm-workspace', 'legal-lead'],
  },
}

// The server doesn't set 'trust proxy', so req.ip behind Railway's edge is the
// proxy, which would put every visitor in one bucket. Key on the first
// X-Forwarded-For address instead. It can be spoofed, which only weakens the
// limit; each address still gets at most one welcome sequence.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : ''
  return first || req.ip || ''
}

const LIST_SIGNUP_CONFIG = { windowMs: 15 * 60_000, max: 5 }
const listSignupLimiter = rateLimit({
  ...LIST_SIGNUP_CONFIG,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  validate: { xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Returns { error } or { value: { email, firstName, list } }.
function validateListSignup(body) {
  const { email, first_name, list } = body || {}
  if (typeof list !== 'string' || !Object.prototype.hasOwnProperty.call(PUBLIC_LISTS, list)) {
    return { error: 'Unknown list' }
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 254) {
    return { error: 'Please enter a valid email address' }
  }
  const firstName = typeof first_name === 'string' && first_name.trim()
    ? first_name.trim().slice(0, 100)
    : null
  return { value: { email: email.toLowerCase().trim(), firstName, list } }
}

// Adds the list's tags to the contact, creating it if needed. Existing
// contacts keep their name and unsubscribe status; re-signing up never
// resubscribes someone who opted out.
async function upsertListContact(supabase, clientId, { email, firstName, list }) {
  const tags = PUBLIC_LISTS[list].tags

  const { data: existing, error: lookupError } = await supabase
    .from('contacts')
    .select('id, first_name, tags')
    .eq('client_id', clientId)
    .eq('email', email)
    .maybeSingle()
  if (lookupError) throw lookupError

  if (existing) {
    const merged = [...new Set([...(existing.tags || []), ...tags])]
    const { error } = await supabase
      .from('contacts')
      .update({
        first_name: existing.first_name || firstName,
        tags: merged,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (error) throw error
    return 'updated'
  }

  const { error } = await supabase
    .from('contacts')
    .insert({ client_id: clientId, email, first_name: firstName, tags, unsubscribed: false })
  if (error) throw error
  return 'created'
}

module.exports = {
  PUBLIC_LISTS,
  LIST_SIGNUP_CONFIG,
  listSignupLimiter,
  clientIp,
  validateListSignup,
  upsertListContact,
}
