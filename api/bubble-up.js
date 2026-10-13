// ============ BUBBLE-UP (phase 1) ============
// A living list of people who showed a buying or "help me" signal and haven't heard from a
// human (Alconox, Stacy's word, 2026-10-13). Spec: sagerock/clients/alconox/specs/
// 2026-10-13-bubble-up-spec.md. Migration 112.
//
// Each run: refresh the Salesforce mirrors it reads (Tasks, EmailMessage, recently modified
// Opportunities), detect today's candidates, reconcile them with bubble_items, and email the
// list to bubble_config.recipients. Phase 1 recipients are Sage only, for tuning. It points
// people out; it never contacts a customer, and it never writes to Salesforce.
//
// Signals (spec §3):
//   S1 sample survey "speak with an expert" = Yes      S2 sample survey "planning to purchase" = Yes
//   S3 Ask Alconox question, no answer, 2+ biz days    S4 answered, but the customer wrote last, 3+ biz days
//   S5 inbound email with no later outbound, 3+ biz days
//   S6 open HOT/Warm trade-show task and the person engaged since the show
//   S7 reply to one of our own emails, no later outbound
//   S8 (form leads with no follow-up) is S3: Stacy ratified 9/29 that only Ask Alconox gets a person.
// An item closes by itself when its signal stops being true: an answer, a later outbound email,
// a human Task, a closed trade-show task. Older than its window without that → expired.

const { MailService } = require('@sendgrid/mail')

const DAY = 86400000
const WINDOW_DAYS = { S1: 120, S2: 120, S3: 90, S4: 45, S5: 30, S6: 120, S7: 45 }
const BASE_SCORE = { S1: 90, S2: 80, S4: 75, S3: 70, S7: 65, S5: 55, S6: 50 }
const SIGNAL_LABEL = {
  S1: 'Asked for an expert (survey)', S2: 'Plans to buy (survey)', S3: 'Ask Alconox, no answer',
  S4: 'Ask Alconox, customer wrote last', S5: 'Email nobody answered', S6: 'Trade-show lead, engaged since',
  S7: 'Replied to our email',
}
const OPEN = new Set(['new', 'notified'])
// Users whose Tasks are automation, not a person following up.
const AUTOMATION_USERS = /^(Automated Process|Alconox Forms|Cleaning|Integration|Platform Integration)/i
const ownerOf = name => (!name || AUTOMATION_USERS.test(name) ? null : name)
const FREEMAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|comcast|protonmail|mail)\./i
// Mail that isn't a prospect asking for something: auto-replies, bounces, and order / billing /
// shipping traffic that customer service handles anyway.
const NOISE_SUBJECT = /automatic reply|auto.?reply|automatyczna|automatische|abwesenheit|respuesta autom|r[ée]ponse automatique|out of (the )?office|undeliverable|delivery status|mail delivery|read:|\bunsubscribe\b|\b2\d{6}\b|\bpricing\b|price (list|spreadsheet)|\brma\b|\bedi\b|proforma|pallet|\breturn\b|media kit|exhibit|b\/l\b|vessel|prepay|\bopor|\bpo\b|\b(invoice|remittance|payment|statement|purchase order|p\.?o\.?\s*#?\s*\d|po\d{3,}|order (confirmation|#|no)|tracking|shipment|shipped|freight|bill of lading|\bbol\b|credit card|w-?9|tax exempt|quote #)/i
const NOISE_SENDER = /mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?@|bounce|@alconox\.com$|@tcpanalytical\.com$|@sagerock\.com$|logistics|cargo|freight|salesforce|docusign|quickbooks|intuit|paypal|amazon/i
// House subject pattern on everything we send for Alconox ("… — Alconox, LLC").
const OUR_SUBJECT = /[—–-]\s*Alconox, L(LC|…)?\s*$/i
// Staff-named automation: survey sends, assignment notices, shipping notices, the trade-show
// tasks themselves. These run under real users (Stacy, Michelle), so they can't count as a
// person following up.
const AUTOMATED_SUBJECT = /^(email:\s*)?(survey sent|ask alconox aa-?\d+ assigned|sample request sr-?\d+ assigned|order from existing|your detergent from alconox|your request to alconox|your sample request \(sr|confirmation of ask alconox|(f\/u )?(hot|warm)\b)|verification code|has shipped|is preparing to ship|order (has been )?received/i
// A last message that just closes the loop ("Thanks!", "Received", a reaction) isn't waiting on anyone.
const ASKS = /\?|please|pls|send|quote|quotation|sample|interested|price|pricing|could you|can you|need|want|would like|looking for|follow(ing)? up/i
const CLOSER_WORDS = /\b(thanks?|thank you|received|noted|got it|appreciate|will do|sounds good|ok(ay)?|perfect|confirmed|no thank you|reacted to your message|will get back|get back to you|forwarded)\b/i
// S5 only: plain inbound mail must be about cleaning or a product, so vendor pitches, lawyers and
// consultants don't land on the list. (S7 replies to our own emails skip this.)
const CLEANING_INTENT = /clean|deterg|residue|rinse|wash|validation|sample|quot(e|ation)|\bprice\b|liquinox|alconox powder|alcojet|citranox|tergazyme|solujet|citrajet|luminox|detonox|alcotabs|keteral|citrajet|citrasteel|halojet|tergajet|alcojet|sds\b|\bcoa\b/i
const PITCH = /suspected as spam|invite you to exhibit|dear (valued )?supplier|media kit|eblasts?|content syndication|specializes in|data erasure|we (help|work with) companies|book a (call|demo)/i
function isCloser(body) {
  const t = oneLine(body, 400)
  return t.length <= 300 && CLOSER_WORDS.test(t) && !ASKS.test(t)
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const lower = s => (s ? String(s).toLowerCase().trim() : '')
const oneLine = (s, n = 140) => {
  const t = String(s || '').split(/\n\s*(From:|On .{0,80}wrote:|-----Original|Sent from my)/)[0].replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const fmt = d => (d ? new Date(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/New_York' }) : '')
const ts = d => (d ? new Date(d).getTime() : 0)

// Weekdays between two instants (holidays ignored).
function businessDaysBetween(from, to) {
  let n = 0
  const d = new Date(from)
  d.setUTCHours(12, 0, 0, 0)
  const end = new Date(to)
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (d > end) break
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) n++
  }
  return n
}

function addressesOf(m) {
  return `${m.to_address || ''};${m.cc_address || ''}`.toLowerCase().split(/[;,\s]+/).filter(a => a.includes('@'))
}

function sfUrl(instanceUrl, id) {
  if (!instanceUrl || !id) return null
  return `${instanceUrl.replace(/\/+$/, '')}/lightning/r/${id}/view`
}

// ---------- detection (pure) ----------

/**
 * Index of "a human reached this person after time T": outbound emails by address, and
 * non-automation Tasks by Salesforce person / record id.
 */
function buildFollowupIndex({ emails = [], tasks = [] }) {
  const outByAddress = new Map()
  for (const m of emails) {
    if (m.incoming) continue
    if (!/@alconox\.com$/i.test(m.from_address || '')) continue
    if (AUTOMATED_SUBJECT.test(m.subject || '') || /^(no-?reply|cleaning)@/i.test(m.from_address || '')) continue
    for (const a of addressesOf(m)) (outByAddress.get(a) || outByAddress.set(a, []).get(a)).push(m)
  }
  const tasksById = new Map()
  for (const t of tasks) {
    if (AUTOMATION_USERS.test(t.created_by_name || '')) continue
    if (AUTOMATED_SUBJECT.test(t.subject || '')) continue
    for (const id of [t.who_id, t.what_id]) if (id) (tasksById.get(id) || tasksById.set(id, []).get(id)).push(t)
  }
  return {
    // First human touch after `after`, or null. Returns {at, by, how}.
    after(after, { address, ids = [] } = {}) {
      const t0 = ts(after)
      let best = null
      for (const m of outByAddress.get(lower(address)) || []) {
        if (ts(m.message_at) > t0 && (!best || ts(m.message_at) < ts(best.at))) {
          best = { at: m.message_at, by: m.from_address, how: `emailed "${oneLine(m.subject, 60)}"` }
        }
      }
      for (const id of ids.filter(Boolean)) {
        for (const t of tasksById.get(id) || []) {
          const at = t.completed_at || t.sf_created_at
          if (ts(at) > t0 && (!best || ts(at) < ts(best.at))) {
            best = { at, by: t.owner_name || t.created_by_name, how: `task "${oneLine(t.subject, 60)}"` }
          }
        }
      }
      return best
    },
  }
}

function score(signal, { signalAt, now, hot = false, email, company }) {
  let s = BASE_SCORE[signal] || 0
  s += Math.min(20, Math.floor((ts(now) - ts(signalAt)) / DAY))
  if (hot) s += 10
  if (email && FREEMAIL.test(email) && !company) s -= 15
  return s
}

/**
 * @param {object} data  { now, instanceUrl, opps, questions, emails, tasks, conversations,
 *                         contactsBySfId: Map, contactsByEmail: Map, clicks, orders }
 * @returns {object[]} candidates keyed by dedupe_key
 */
function detect(data) {
  const { now, instanceUrl } = data
  const follow = buildFollowupIndex(data)
  const out = new Map()
  const byPerson = new Set() // emails already on the list from a stronger signal
  const contactByEmail = e => data.contactsByEmail?.get(lower(e)) || null
  const inWindow = (signal, at) => ts(now) - ts(at) <= WINDOW_DAYS[signal] * DAY
  const add = c => {
    if (out.has(c.dedupe_key)) return
    c.owner_name = ownerOf(c.owner_name)
    c.score = score(c.signal, { signalAt: c.signal_at, now, hot: c.hot, email: c.person_email, company: c.company })
    delete c.hot
    out.set(c.dedupe_key, c)
    if (c.person_email) byPerson.add(lower(c.person_email))
  }

  // S1 / S2: sample survey answers
  for (const o of data.opps || []) {
    const expert = /^yes/i.test(o.survey_speak_with_expert || '')
    const buy = /^yes/i.test(o.survey_planning_purchase || '')
    if (!expert && !buy) continue
    if (o.is_won) continue
    const signalAt = o.survey_completed_date ? `${o.survey_completed_date}T12:00:00Z` : o.last_activity_date
    if (!signalAt || !inWindow('S1', signalAt)) continue
    const email = o.contact_email
    const touched = follow.after(signalAt, { address: email, ids: [o.salesforce_id, o.sample_request_contact_id, o.sf_contact_id] })
    if (touched) continue
    const signal = expert ? 'S1' : 'S2'
    const bits = [expert && 'asked to speak with an expert', buy && 'plans to buy']
      .filter(Boolean).join(' and ')
    const from = o.survey_purchase_from ? ` Buying from: "${oneLine(o.survey_purchase_from, 60)}".` : ''
    const contact = contactByEmail(email)
    add({
      dedupe_key: `S1:${o.salesforce_id}`, // one item per sample request, whichever survey answer
      signal, person_sf_id: o.sample_request_contact_id || o.sf_contact_id, person_email: email || null,
      person_name: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : null,
      company: contact?.company || (o.name || '').split(' - ')[0] || null,
      owner_name: o.owner_name, signal_at: signalAt,
      evidence: `${o.name}: ${bits} in the sample survey ${fmt(signalAt)}.${from}`,
      quote: oneLine([o.survey_why_not, o.survey_additional].filter(Boolean).join(' / '), 160) || null,
      sf_url: sfUrl(instanceUrl, o.salesforce_id),
    })
  }

  // S3 / S4: Ask Alconox
  for (const q of data.questions || []) {
    if (q.visible_in_last_snapshot === false) continue
    const contact = contactByEmail(q.email)
    const base = {
      person_sf_id: q.sf_contact_id || q.sf_lead_id, person_email: q.email,
      person_name: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : null,
      company: contact?.company || null, owner_name: q.owner_name,
      quote: oneLine(q.question_text, 160) || null, sf_url: sfUrl(instanceUrl, q.salesforce_id),
    }
    if (!q.first_answer_at && q.status !== 'Response Emailed') {
      if (!inWindow('S3', q.sf_created_at) || businessDaysBetween(q.sf_created_at, now) < 2) continue
      add({ ...base, dedupe_key: `S3:${q.salesforce_id}`, signal: 'S3', signal_at: q.sf_created_at,
        evidence: `${q.name} asked ${fmt(q.sf_created_at)}, no answer recorded (status: ${q.status || 'none'}).` })
    } else if (q.first_answer_at && q.last_message_incoming && q.last_message_at) {
      if (!inWindow('S4', q.last_message_at) || businessDaysBetween(q.last_message_at, now) < 3) continue
      if (q.last_incoming_body != null && isCloser(q.last_incoming_body)) continue
      if (follow.after(q.last_message_at, { address: q.email })) continue
      add({ ...base, dedupe_key: `S4:${q.salesforce_id}`, signal: 'S4', signal_at: q.last_message_at,
        evidence: `${q.name} answered ${fmt(q.first_answer_at)}; the customer wrote back ${fmt(q.last_message_at)} and is waiting.` })
    }
  }

  // S6: open trade-show tasks where the person engaged after the task was created
  const group = (rows, key) => {
    const m = new Map()
    for (const r of rows || []) { const k = lower(key(r)); if (k) (m.get(k) || m.set(k, []).get(k)).push(r) }
    return m
  }
  const clicksBy = group(data.clicks, c => c.email)
  const questionsBy = group(data.questions, q => q.email)
  const inboundBy = group((data.emails || []).filter(m => m.incoming), m => m.from_address)
  const ordersBy = group(data.orders, o => o.email)
  const firstAfter = (rows, at, t0) => (rows || []).filter(r => ts(r[at]) > t0).sort((a, b) => ts(a[at]) - ts(b[at]))[0]
  const engagedAfter = (email, after) => {
    const t0 = ts(after)
    const e = lower(email)
    const hits = []
    const click = firstAfter(clicksBy.get(e), 'timestamp', t0)
    if (click) hits.push({ at: click.timestamp, what: 'clicked a campaign email' })
    const ask = firstAfter(questionsBy.get(e), 'sf_created_at', t0)
    if (ask) hits.push({ at: ask.sf_created_at, what: `asked Ask Alconox (${ask.name})` })
    const mail = firstAfter(inboundBy.get(e), 'message_at', t0)
    if (mail) hits.push({ at: mail.message_at, what: `emailed "${oneLine(mail.subject, 50)}"` })
    const order = firstAfter(ordersBy.get(e), 'order_date', t0)
    if (order) hits.push({ at: order.order_date, what: 'placed a web order' })
    return hits.sort((a, b) => ts(a.at) - ts(b.at))
  }
  for (const t of data.tasks || []) {
    if (t.is_closed !== false) continue
    const m = String(t.subject || '').match(/^(HOT|Warm)\b\s*([A-Z0-9]+)?/i)
    if (!m) continue
    const contact = data.contactsBySfId?.get(t.who_id)
    const email = contact?.email
    if (!email) continue
    const hits = engagedAfter(email, t.sf_created_at)
    if (!hits.length) continue
    const last = hits[hits.length - 1]
    if (!inWindow('S6', t.sf_created_at)) continue
    if (follow.after(hits[0].at, { address: email, ids: [t.who_id] })) continue
    add({
      dedupe_key: `S6:${t.salesforce_id}`, signal: 'S6', hot: /^hot$/i.test(m[1]),
      person_sf_id: t.who_id, person_email: email,
      person_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || t.who_name,
      company: contact.company || null, owner_name: t.owner_name, signal_at: last.at,
      evidence: `${m[1].toUpperCase()} ${m[2] || 'trade-show'} lead, task open since ${fmt(t.sf_created_at)}; since then ${hits.map(h => `${h.what} ${fmt(h.at)}`).join(', ')}.`,
      quote: null, sf_url: sfUrl(instanceUrl, t.salesforce_id),
    })
  }

  // S5 / S7: inbound mail with nothing after it. Latest message per sender.
  const latestBySender = new Map()
  for (const m of data.emails || []) {
    if (!m.incoming || !m.from_address) continue
    if (NOISE_SENDER.test(m.from_address) || NOISE_SUBJECT.test(m.subject || '')) continue
    const prev = latestBySender.get(m.from_address)
    if (!prev || ts(m.message_at) > ts(prev.message_at)) latestBySender.set(m.from_address, m)
  }
  for (const c of data.conversations || []) {
    const a = lower(c.email)
    if (!a || NOISE_SENDER.test(a) || NOISE_SUBJECT.test(c.subject || '')) continue
    const prev = latestBySender.get(a)
    const m = { incoming: true, from_address: a, from_name: c.name, subject: c.subject, body: c.body,
      message_at: c.created_at, ours: true }
    if (!prev || ts(m.message_at) > ts(prev.message_at)) latestBySender.set(a, m)
  }
  for (const [address, m] of latestBySender) {
    if (byPerson.has(address)) continue
    if (isCloser(m.body)) continue
    const signal = m.ours || OUR_SUBJECT.test(m.subject || '') ? 'S7' : 'S5'
    if (signal === 'S5' && (PITCH.test(m.body || '') || !CLEANING_INTENT.test(`${m.subject || ''} ${m.body || ''}`))) continue
    if (!inWindow(signal, m.message_at) || businessDaysBetween(m.message_at, now) < 3) continue
    if (follow.after(m.message_at, { address })) continue
    const contact = contactByEmail(address)
    add({
      dedupe_key: `${signal}:${address}`, signal, person_sf_id: contact?.salesforce_id || null,
      person_email: address,
      person_name: (contact && [contact.first_name, contact.last_name].filter(Boolean).join(' ')) || m.from_name || null,
      company: contact?.company || null,
      owner_name: contact?.salesforce_owner_name || null, signal_at: m.message_at,
      evidence: signal === 'S7'
        ? `Replied ${fmt(m.message_at)} to our email "${oneLine(m.subject, 70)}"; no reply logged since.`
        : `Emailed ${fmt(m.message_at)} "${oneLine(m.subject, 70)}"${m.related_to_name ? ` (on ${m.related_to_name})` : ''}; no reply logged since.`,
      quote: oneLine(m.body, 160) || null,
      sf_url: contact?.salesforce_id ? sfUrl(instanceUrl, contact.salesforce_id) : null,
    })
  }

  return [...out.values()]
}

// ---------- reconcile (pure) ----------

/**
 * Compare today's candidates with what's on the list.
 * @returns {{inserts: object[], updates: {id, patch, event?}[]}}
 */
function reconcile(existing, candidates, data) {
  const now = data.now
  const nowIso = new Date(now).toISOString()
  const follow = buildFollowupIndex(data)
  const byKey = new Map(existing.map(i => [i.dedupe_key, i]))
  const seen = new Set()
  const inserts = [], updates = []
  const fields = c => ({
    signal: c.signal, person_sf_id: c.person_sf_id || null, person_name: c.person_name || null,
    person_email: c.person_email || null, company: c.company || null, owner_name: c.owner_name || null,
    evidence: c.evidence, quote: c.quote || null, sf_url: c.sf_url || null, score: c.score,
    signal_at: c.signal_at, last_seen_at: nowIso,
  })

  for (const c of candidates) {
    seen.add(c.dedupe_key)
    const item = byKey.get(c.dedupe_key)
    if (!item) {
      inserts.push({ dedupe_key: c.dedupe_key, status: 'new', first_seen_at: nowIso, ...fields(c) })
      continue
    }
    if (OPEN.has(item.status)) { updates.push({ id: item.id, patch: fields(c) }); continue }
    if (item.status === 'snoozed') {
      if (item.snooze_until && ts(item.snooze_until) <= ts(now)) {
        updates.push({ id: item.id, patch: { ...fields(c), status: 'new', snooze_until: null }, event: ['reopened', 'snooze ended'] })
      } else updates.push({ id: item.id, patch: fields(c) })
      continue
    }
    // Closed by a person (handled / not useful) stays closed unless the person did something
    // new after it closed; closed automatically reopens whenever the signal is back.
    const newer = ts(c.signal_at) > ts(item.closed_at)
    if (item.closed_by === 'auto' || newer) {
      updates.push({ id: item.id, patch: { ...fields(c), status: 'new', closed_at: null, closed_by: null,
        close_reason: null, close_evidence: null }, event: ['reopened', newer ? 'new activity after it closed' : 'signal is back'] })
    }
  }

  for (const item of existing) {
    if (seen.has(item.dedupe_key)) continue
    if (!OPEN.has(item.status) && item.status !== 'snoozed') continue
    const window = WINDOW_DAYS[item.signal] || 90
    const touched = follow.after(item.signal_at, { address: item.person_email, ids: [item.person_sf_id] })
    if (!touched && ts(now) - ts(item.signal_at) > window * DAY) {
      updates.push({ id: item.id, patch: { status: 'expired', closed_at: nowIso, closed_by: 'auto',
        close_reason: `older than ${window} days with no follow-up seen` }, event: ['expired', null] })
      continue
    }
    const evidence = touched ? `${touched.by || 'someone'} ${touched.how} ${fmt(touched.at)}` : null
    updates.push({ id: item.id, patch: { status: 'handled', closed_at: nowIso, closed_by: 'auto',
      close_reason: touched ? 'follow-up seen in Salesforce' : 'signal cleared (answer recorded, task closed, or no longer applies)',
      close_evidence: evidence }, event: ['auto_closed', evidence] })
  }
  return { inserts, updates }
}

// ---------- report (pure) ----------

const LIST_CAP = 25
function itemLine(i) {
  const who = [i.person_name, i.company].filter(Boolean).join(', ') || i.person_email || 'Unknown'
  return { who, why: i.evidence, quote: i.quote, url: i.sf_url, owner: i.owner_name || 'Unassigned', signal: i.signal, isNew: i.status === 'new' }
}

function buildReport({ clientName, open, closedSinceLast, now }) {
  const sorted = [...open].sort((a, b) => b.score - a.score)
  const fresh = sorted.filter(i => i.status === 'new')
  const bySignal = {}
  for (const i of open) bySignal[i.signal] = (bySignal[i.signal] || 0) + 1
  const byOwner = {}
  for (const i of open) { const o = i.owner_name || 'Unassigned'; byOwner[o] = (byOwner[o] || 0) + 1 }
  const ownerLine = Object.entries(byOwner).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} ${n}`).join(', ')
  const signalLine = Object.keys(SIGNAL_LABEL).filter(s => bySignal[s]).map(s => `${SIGNAL_LABEL[s]} ${bySignal[s]}`).join(', ')
  const subject = `Bubble-up: ${open.length} open, ${fresh.length} new (${clientName})`
  const top = sorted.slice(0, LIST_CAP).map(itemLine)

  const T = {
    p: 'font:14px/1.5 Arial,sans-serif;color:#222;margin:0 0 10px',
    h: 'font:600 15px/1.3 Arial,sans-serif;color:#111;margin:22px 0 6px',
    li: 'font:14px/1.45 Arial,sans-serif;color:#222;margin:0 0 10px',
    sub: 'color:#666;font-size:13px',
  }
  const li = x => `<li style="${T.li}">${x.isNew ? '<b>NEW</b> ' : ''}${x.url ? `<a href="${esc(x.url)}" style="color:#1a4f9c">${esc(x.who)}</a>` : esc(x.who)}
    <span style="${T.sub}">(${esc(x.owner)})</span><br>${esc(x.why)}${x.quote ? `<br><span style="${T.sub}">“${esc(x.quote)}”</span>` : ''}</li>`
  const closedLi = i => `<li style="${T.li}">${esc([i.person_name, i.company].filter(Boolean).join(', ') || i.person_email)}
    <span style="${T.sub}">(${esc(SIGNAL_LABEL[i.signal] || i.signal)})</span>: ${esc(i.close_evidence || i.close_reason)}</li>`

  const html = `<div style="max-width:680px">
    <p style="${T.p}">Tuning list for ${esc(clientName)}, ${esc(fmt(now))}. Only you get this for now; nothing went to Alconox.</p>
    <p style="${T.p}"><b>${open.length} open</b>, ${fresh.length} new since the last list. By signal: ${esc(signalLine || 'none')}. By owner: ${esc(ownerLine || 'none')}.</p>
    ${top.length ? `<h2 style="${T.h}">Top ${top.length} by score</h2><ul style="padding-left:18px;margin:0">${top.map(li).join('')}</ul>` : ''}
    ${open.length > LIST_CAP ? `<p style="${T.p}">The other ${open.length - LIST_CAP} are in the attached spreadsheet.</p>` : ''}
    ${closedSinceLast.length ? `<h2 style="${T.h}">Closed on their own since the last list (${closedSinceLast.length})</h2><ul style="padding-left:18px;margin:0">${closedSinceLast.slice(0, 15).map(closedLi).join('')}</ul>` : ''}
    <p style="${T.p};margin-top:20px">Tell me what's noise and what's missing, and I'll tune the rules.</p>
    <p style="${T.p}">- Jax</p></div>`

  const text = `Tuning list for ${clientName}, ${fmt(now)}. Only you get this for now; nothing went to Alconox.\n\n`
    + `${open.length} open, ${fresh.length} new since the last list.\nBy signal: ${signalLine || 'none'}\nBy owner: ${ownerLine || 'none'}\n`
    + (top.length ? `\nTop ${top.length} by score:\n${top.map(x => `- ${x.isNew ? 'NEW ' : ''}${x.who} (${x.owner})\n  ${x.why}${x.quote ? `\n  "${x.quote}"` : ''}${x.url ? `\n  ${x.url}` : ''}`).join('\n')}\n` : '')
    + (open.length > LIST_CAP ? `\nThe other ${open.length - LIST_CAP} are in the attached spreadsheet.\n` : '')
    + (closedSinceLast.length ? `\nClosed on their own since the last list (${closedSinceLast.length}):\n${closedSinceLast.slice(0, 15).map(i => `- ${[i.person_name, i.company].filter(Boolean).join(', ') || i.person_email}: ${i.close_evidence || i.close_reason}`).join('\n')}\n` : '')
    + `\nTell me what's noise and what's missing, and I'll tune the rules.\n\n- Jax\n`
  return { subject, html, text, open: open.length, fresh: fresh.length }
}

const XLSX_COLUMNS = ['status', 'signal', 'score', 'owner', 'name', 'company', 'email', 'why', 'quote', 'signal_date', 'first_seen', 'salesforce_link']
async function toXlsx(open) {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Open', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.addRow(XLSX_COLUMNS).font = { bold: true }
  const rows = [...open].sort((a, b) => b.score - a.score).map(i => [
    i.status, `${i.signal} ${SIGNAL_LABEL[i.signal] || ''}`.trim(), i.score, i.owner_name || 'Unassigned', i.person_name || '',
    i.company || '', i.person_email || '', i.evidence || '', i.quote || '', (i.signal_at || '').slice(0, 10),
    (i.first_seen_at || '').slice(0, 10), i.sf_url || '',
  ])
  rows.forEach(r => ws.addRow(r))
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: XLSX_COLUMNS.length } }
  ws.columns.forEach((col, i) => { col.width = Math.min(70, Math.max(XLSX_COLUMNS[i].length, ...rows.map(r => String(r[i] ?? '').length)) + 2) })
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ---------- loading + applying (impure) ----------

async function pageAll(build) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < 1000) return out
  }
}

async function loadData(supabase, clientId, now = new Date()) {
  const since = d => new Date(ts(now) - d * DAY).toISOString()
  const { data: client, error: ce } = await supabase.from('clients').select('id, name, salesforce_instance_url').eq('id', clientId).single()
  if (ce) throw ce
  const [opps, questions, emails, tasks, convs, orders, campaigns] = await Promise.all([
    pageAll(() => supabase.from('salesforce_opportunities')
      .select('salesforce_id, name, owner_name, is_won, contact_email, sf_contact_id, sample_request_contact_id, last_activity_date, survey_completed_date, survey_speak_with_expert, survey_planning_purchase, survey_purchase_from, survey_why_not, survey_additional')
      .eq('client_id', clientId).gte('survey_completed_date', since(WINDOW_DAYS.S1).slice(0, 10))),
    pageAll(() => supabase.from('salesforce_ask_questions')
      .select('salesforce_id, name, status, email, sf_lead_id, sf_contact_id, sf_created_at, owner_name, question_text, first_answer_at, last_message_at, last_message_incoming, visible_in_last_snapshot')
      .eq('client_id', clientId).gte('sf_created_at', since(180))),
    pageAll(() => supabase.from('salesforce_email_messages')
      .select('salesforce_id, message_at, incoming, from_address, from_name, to_address, cc_address, subject, body, related_to_name')
      .eq('client_id', clientId).gte('message_at', since(120)).order('message_at')),
    pageAll(() => supabase.from('salesforce_tasks')
      .select('salesforce_id, subject, is_closed, sf_created_at, completed_at, owner_name, created_by_name, who_id, who_name, what_id')
      .eq('client_id', clientId).or(`is_closed.eq.false,sf_created_at.gte.${since(150)}`)),
    pageAll(() => supabase.from('email_conversations')
      .select('subject, body, created_at, contact:contacts(email, first_name, last_name)')
      .eq('client_id', clientId).eq('direction', 'inbound').gte('created_at', since(WINDOW_DAYS.S7))
      .not('body', 'like', '[auto-response]%')),
    pageAll(() => supabase.from('woocommerce_orders').select('email, order_date').eq('client_id', clientId).gte('order_date', since(150))),
    pageAll(() => supabase.from('campaigns').select('id').eq('client_id', clientId).gte('created_at', since(200))),
  ])

  // The customer's last message on each Ask Alconox thread, so "Thanks!" doesn't count as waiting.
  const askMsgs = await pageAll(() => supabase.from('salesforce_ask_messages')
    .select('question_salesforce_id, message_at, body').eq('client_id', clientId).eq('incoming', true)
    .gte('message_at', since(WINDOW_DAYS.S4 + 5)).order('message_at'))
  const lastIncoming = new Map()
  for (const m of askMsgs) lastIncoming.set(m.question_salesforce_id, m) // ordered, so the last one wins
  for (const q of questions) {
    const m = lastIncoming.get(q.salesforce_id)
    if (m && q.last_message_at && ts(m.message_at) === ts(q.last_message_at)) q.last_incoming_body = m.body || ''
  }

  // People: everyone referenced by an open task, a survey, a question or an email.
  const sfIds = new Set([...tasks.filter(t => t.is_closed === false).map(t => t.who_id),
    ...opps.flatMap(o => [o.sample_request_contact_id, o.sf_contact_id])].filter(Boolean))
  const addresses = new Set([...opps.map(o => o.contact_email), ...questions.map(q => q.email),
    ...emails.filter(m => m.incoming).map(m => m.from_address)].filter(Boolean).map(lower))
  const contacts = []
  const cols = 'email, first_name, last_name, company, salesforce_id, salesforce_owner_name'
  const ids = [...sfIds], addrs = [...addresses]
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('contacts').select(cols).eq('client_id', clientId).in('salesforce_id', ids.slice(i, i + 150))
    if (error) throw error
    contacts.push(...(data || []))
  }
  for (let i = 0; i < addrs.length; i += 150) {
    const { data, error } = await supabase.from('contacts').select(cols).eq('client_id', clientId).in('email', addrs.slice(i, i + 150))
    if (error) throw error
    contacts.push(...(data || []))
  }
  const contactsBySfId = new Map(contacts.filter(c => c.salesforce_id).map(c => [c.salesforce_id, c]))
  const contactsByEmail = new Map(contacts.filter(c => c.email).map(c => [lower(c.email), c]))

  // Clicks on this client's campaigns by people with an open trade-show task.
  const taskEmails = [...new Set(tasks.filter(t => t.is_closed === false && /^(HOT|Warm)\b/i.test(t.subject || ''))
    .map(t => contactsBySfId.get(t.who_id)?.email).filter(Boolean).map(lower))]
  const campaignIds = new Set(campaigns.map(c => c.id))
  const clicks = []
  for (let i = 0; i < taskEmails.length; i += 150) {
    const { data, error } = await supabase.from('analytics_events').select('email, campaign_id, timestamp')
      .eq('event_type', 'click').in('email', taskEmails.slice(i, i + 150)).gte('timestamp', since(WINDOW_DAYS.S6))
    if (error) throw error
    clicks.push(...(data || []).filter(c => campaignIds.has(c.campaign_id)))
  }

  const conversations = convs.filter(c => c.contact?.email).map(c => ({
    email: c.contact.email, name: [c.contact.first_name, c.contact.last_name].filter(Boolean).join(' '),
    subject: c.subject, body: String(c.body || '').replace(/^(\[[^\]]*\]\s*)+/, ''), created_at: c.created_at,
  }))

  return { now, client, instanceUrl: client.salesforce_instance_url, opps, questions, emails, tasks,
    conversations, orders, clicks, contactsBySfId, contactsByEmail }
}

async function applyPlan(supabase, clientId, plan) {
  for (let i = 0; i < plan.inserts.length; i += 200) {
    const chunk = plan.inserts.slice(i, i + 200).map(r => ({ ...r, client_id: clientId }))
    const { data, error } = await supabase.from('bubble_items').insert(chunk).select('id, evidence')
    if (error) throw new Error(`bubble_items insert: ${error.message}`)
    const events = (data || []).map(r => ({ client_id: clientId, item_id: r.id, event: 'detected', actor: 'auto', detail: r.evidence }))
    if (events.length) {
      const { error: ee } = await supabase.from('bubble_events').insert(events)
      if (ee) throw new Error(`bubble_events insert: ${ee.message}`)
    }
  }
  const events = []
  for (const u of plan.updates) {
    const { error } = await supabase.from('bubble_items').update(u.patch).eq('id', u.id)
    if (error) throw new Error(`bubble_items update: ${error.message}`)
    if (u.event) events.push({ client_id: clientId, item_id: u.id, event: u.event[0], actor: 'auto', detail: u.event[1] })
  }
  for (let i = 0; i < events.length; i += 200) {
    const { error } = await supabase.from('bubble_events').insert(events.slice(i, i + 200))
    if (error) throw new Error(`bubble_events insert: ${error.message}`)
  }
}

module.exports = function mountBubbleUp(app, { supabase, decryptClient, cron, schedulerEnabled = true, syncActivity, syncOpportunities }) {
  /**
   * @param {string} clientId
   * @param {{to?: string, dryRun?: boolean, sync?: boolean, send?: boolean}} options
   *   dryRun: detect and report, write nothing, send nothing
   */
  async function runBubbleUp(clientId, { to, dryRun = false, sync = true, send = true } = {}) {
    const now = new Date()
    const { data: cfg } = await supabase.from('bubble_config').select('*').eq('client_id', clientId).maybeSingle()
    const conf = cfg || { enabled: true, recipients: [] }
    if (sync && !dryRun) {
      if (syncOpportunities) await syncOpportunities(clientId, new Date(ts(now) - 150 * DAY).toISOString())
      if (syncActivity) await syncActivity(clientId)
    }
    const data = await loadData(supabase, clientId, now)
    const candidates = detect(data)
    const existing = await pageAll(() => supabase.from('bubble_items').select('*').eq('client_id', clientId))
    const plan = reconcile(existing, candidates, data)
    if (!dryRun) await applyPlan(supabase, clientId, plan)

    // The list as it stands after this run.
    let open, closedSinceLast
    if (dryRun) {
      const planned = new Map(existing.map(i => [i.id, i]))
      for (const u of plan.updates) planned.set(u.id, { ...planned.get(u.id), ...u.patch })
      const all = [...planned.values(), ...plan.inserts]
      open = all.filter(i => OPEN.has(i.status))
      closedSinceLast = plan.updates.filter(u => u.patch.status === 'handled').map(u => planned.get(u.id))
    } else {
      open = await pageAll(() => supabase.from('bubble_items').select('*').eq('client_id', clientId).in('status', [...OPEN]))
      const lastSent = conf.last_sent_at || new Date(ts(now) - 7 * DAY).toISOString()
      closedSinceLast = await pageAll(() => supabase.from('bubble_items').select('*').eq('client_id', clientId)
        .eq('status', 'handled').eq('closed_by', 'auto').gte('closed_at', lastSent))
    }
    const report = buildReport({ clientName: data.client.name, open, closedSinceLast, now })
    const summary = { candidates: candidates.length, inserted: plan.inserts.length,
      closed: plan.updates.filter(u => u.patch.status === 'handled').length,
      expired: plan.updates.filter(u => u.patch.status === 'expired').length, ...report }
    if (!dryRun) await supabase.from('bubble_config').update({ last_run_at: now.toISOString() }).eq('client_id', clientId)

    const recipients = to ? [].concat(to) : conf.recipients
    if (dryRun || !send || !recipients.length || !open.length) return { ...summary, recipients, sent: false }

    const { data: clientRow } = await supabase.from('clients').select('id, name, sendgrid_api_key, ip_pool, default_reply_to_email').eq('id', clientId).single()
    const { data: lastCampaign } = await supabase.from('campaigns').select('from_email').eq('client_id', clientId)
      .not('from_email', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const client = decryptClient(clientRow)
    const fromEmail = lastCampaign?.from_email || client.default_reply_to_email
    if (!client.sendgrid_api_key || !fromEmail) throw new Error('client has no SendGrid key / from_email')
    const sg = new MailService(); sg.setApiKey(client.sendgrid_api_key)
    const msg = {
      to: recipients,
      from: { email: fromEmail, name: `${client.name} Bubble-up` },
      replyTo: { email: 'jax@sagerock.com', name: 'Jax' },
      subject: report.subject, text: report.text, html: report.html,
      attachments: [{ content: (await toXlsx(open)).toString('base64'), filename: `bubble-up-${now.toISOString().slice(0, 10)}.xlsx`,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: 'attachment' }],
      trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } },
      categories: ['bubble-up'],
    }
    if (client.ip_pool) msg.ipPoolName = client.ip_pool
    await sg.send(msg)
    if (!to) {
      await supabase.from('bubble_config').update({ last_sent_at: now.toISOString() }).eq('client_id', clientId)
      const fresh = open.filter(i => i.status === 'new').map(i => i.id)
      // Phase 1: "notified" means it reached the tuning list, not an owner.
      for (let i = 0; i < fresh.length; i += 200) {
        await supabase.from('bubble_items').update({ status: 'notified', notified_at: now.toISOString() }).in('id', fresh.slice(i, i + 200))
      }
    }
    console.log(`🫧 bubble-up sent for ${client.name} → ${recipients.join(', ')} (${report.open} open, ${report.fresh} new)`)
    return { ...summary, recipients, sent: true }
  }

  // Weekdays 11:30 UTC (7:30 ET), after the 06:00 Salesforce sync and 07:45 Ask threads.
  if (cron && schedulerEnabled) {
    cron.schedule('30 11 * * 1-5', async () => {
      const { data: cfgs } = await supabase.from('bubble_config').select('client_id').eq('enabled', true)
      for (const c of cfgs || []) {
        try { await runBubbleUp(c.client_id) } catch (e) { console.error(`❌ bubble-up failed for ${c.client_id}:`, e.message) }
      }
    })
  }
  return { runBubbleUp }
}
Object.assign(module.exports, { isCloser, detect, reconcile, buildReport, businessDaysBetween, buildFollowupIndex, toXlsx, loadData, WINDOW_DAYS })
