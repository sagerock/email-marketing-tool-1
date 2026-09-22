// ============ AI CHAT CASE FOLLOW-UPS ============
// The alconox.com AI chat lands in Salesforce as a Closed Case with
// Case_Origin_Subtype__c = 'AI Chat'. Its Description is the transcript:
//   [2026-09-16T16:25:13Z] Visitor: ...
//   Alconox: ...
//   ---
//   Pages: <urls>
//   IP: <ip>
//   Session: <id>
//
// This module (1) syncs those cases into salesforce_ai_chat_cases with the IP
// line removed before anything is stored, (2) enrolls each new case's person in
// the client's chat agent (ai_followup_config.trigger_ai_chat) exactly once per
// case, and (3) runs the email-based review: reviewers get the draft, the
// transcript and a signed link to a page where one click approves or skips.
//
// Safety: the review links do nothing on GET. Corporate mail scanners follow
// every link in an email; a GET that sent mail would let a scanner "approve" a
// draft. The GET renders the draft with two POST buttons; only the POST acts.

const crypto = require('node:crypto')

const CHAT_SUBTYPE = 'AI Chat'
const INTERNAL_TAG = 'Alconox Internal'
// alconox.com staff and the Salesforce consultant's test submissions.
const INTERNAL_DOMAINS = ['alconox.com', 'cloudadoptionsolutions.com']
const SPACING_HOURS = 72
const DEFAULT_LEASE_SECONDS = 900
const BATCH = 100
const REVIEW_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000
const TOPIC_MAX_CHARS = 600

const CASE_FIELDS = [
  'Id', 'CaseNumber', 'Subject', 'Status', 'Origin', 'Case_Origin_Subtype__c',
  'SuppliedEmail', 'SuppliedName', 'SuppliedCompany', 'Lead__c', 'ContactId', 'Web_Page__c',
  'Description', 'CreatedDate', 'LastModifiedDate',
]

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim()
}

function isInternalEmail(email) {
  const domain = normalizeEmail(email).split('@')[1] || ''
  return INTERNAL_DOMAINS.includes(domain)
}

// Split a Case Description into what we keep. The IP line is dropped here and
// never returned, so nothing downstream can store it.
function parseCaseDescription(description) {
  const text = String(description || '').replace(/\r\n/g, '\n')
  const parts = text.split(/\n---\n?/)
  const body = parts[0] || ''
  const footer = parts.slice(1).join('\n')

  const pages = []
  let sessionId = null
  for (const rawLine of footer.split('\n')) {
    const line = rawLine.trim()
    const m = line.match(/^(Pages|IP|Session)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (key === 'pages') pages.push(...m[2].split(/[\s,]+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s)))
    else if (key === 'session') sessionId = m[2].trim() || null
    // 'ip' is intentionally ignored.
  }

  const visitorMessages = []
  let chatAt = null
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    const m = line.match(/^(?:\[([^\]]+)\]\s*)?Visitor\s*:\s*(.*)$/i)
    if (!m) continue
    if (!chatAt && m[1]) {
      const d = new Date(m[1])
      if (!Number.isNaN(d.getTime())) chatAt = d.toISOString()
    }
    if (m[2].trim()) visitorMessages.push(m[2].trim())
  }

  // Transcript = the conversation plus the harmless footer lines (no IP).
  const keptFooter = []
  if (pages.length) keptFooter.push(`Pages: ${pages.join(' ')}`)
  if (sessionId) keptFooter.push(`Session: ${sessionId}`)
  const transcript = [body.trim(), keptFooter.length ? `---\n${keptFooter.join('\n')}` : ''].filter(Boolean).join('\n\n')

  return { transcript, pages, sessionId, visitorMessages, chatAt }
}

function mapCase(c, clientId) {
  const parsed = parseCaseDescription(c.Description)
  return {
    client_id: clientId,
    salesforce_id: c.Id,
    case_number: c.CaseNumber || null,
    subject: c.Subject || null,
    status: c.Status || null,
    email: c.SuppliedEmail ? normalizeEmail(c.SuppliedEmail) : null,
    supplied_name: c.SuppliedName || null,
    supplied_company: c.SuppliedCompany || null,
    sf_lead_id: c.Lead__c || null,
    sf_contact_id: c.ContactId || null,
    web_page: c.Web_Page__c || parsed.pages[0] || null,
    pages: parsed.pages,
    session_id: parsed.sessionId,
    transcript: parsed.transcript,
    visitor_messages: parsed.visitorMessages,
    chat_at: parsed.chatAt || c.CreatedDate || null,
    sf_created_date: c.CreatedDate || null,
    sf_last_modified: c.LastModifiedDate || null,
    synced_at: new Date().toISOString(),
  }
}

async function queryAll(conn, soql) {
  let result = await conn.query(soql)
  const records = []
  while (true) {
    records.push(...(result.records || []))
    if (result.done || !result.nextRecordsUrl) return records
    result = await conn.queryMore(result.nextRecordsUrl)
  }
}

// Rows without SuppliedEmail: resolve from the linked Contact/Lead we already hold.
async function fillMissingEmails(supabase, clientId, rows) {
  const ids = [...new Set(rows.filter(r => !r.email).flatMap(r => [r.sf_contact_id, r.sf_lead_id]).filter(Boolean))]
  if (!ids.length) return
  const { data, error } = await supabase.from('contacts')
    .select('salesforce_id, email').eq('client_id', clientId).in('salesforce_id', ids)
  if (error) throw new Error(`AI chat case email lookup failed: ${error.message}`)
  const byId = new Map((data || []).map(c => [c.salesforce_id, c.email]))
  for (const r of rows) if (!r.email) r.email = byId.get(r.sf_contact_id) || byId.get(r.sf_lead_id) || null
}

/**
 * Sync AI Chat cases from Salesforce. Read-only against Salesforce.
 * @param {string|null} since ISO timestamp; null = everything
 */
async function syncAiChatCases({ supabase, getSalesforceConnection }, clientId, since) {
  const conn = await getSalesforceConnection(clientId)
  const where = `WHERE Case_Origin_Subtype__c = '${CHAT_SUBTYPE}'${since ? ` AND LastModifiedDate > ${since}` : ''}`
  let records
  try {
    records = await queryAll(conn, `SELECT ${CASE_FIELDS.join(', ')} FROM Case ${where} ORDER BY LastModifiedDate`)
  } catch (err) {
    // Orgs without the custom subtype field, or without Case read access.
    if (/No such column|INVALID_FIELD|INVALID_TYPE|sObject type 'Case' is not supported/i.test(err?.message || '')) {
      return { count: 0 }
    }
    throw err
  }
  const rows = records.map(c => mapCase(c, clientId))
  if (!rows.length) return { count: 0 }
  await fillMissingEmails(supabase, clientId, rows)
  for (let i = 0; i < rows.length; i += BATCH) {
    // Never overwrite the follow-up bookkeeping columns; they are not in `rows`.
    const { error } = await supabase.from('salesforce_ai_chat_cases')
      .upsert(rows.slice(i, i + BATCH), { onConflict: 'client_id,salesforce_id' })
    if (error) throw new Error(`AI chat case upsert failed: ${error.message}`)
  }
  console.log(`  💬 AI chat cases synced: ${rows.length}`)
  return { count: rows.length }
}

// ---------- enrollment ----------

async function loadChatConfigs(supabase, clientId) {
  const { data, error } = await supabase
    .from('ai_followup_config')
    .select('id, name, enabled, trigger_ai_chat, chat_trigger_since, review_notify_emails')
    .eq('client_id', clientId)
    .eq('trigger_ai_chat', true)
  if (error) throw new Error(`Chat-trigger config lookup failed: ${error.message}`)
  return data || []
}

async function loadPendingCases(supabase, clientId, limit) {
  const { data, error } = await supabase
    .from('salesforce_ai_chat_cases')
    .select('id, salesforce_id, case_number, email, supplied_name, supplied_company, web_page, visitor_messages, chat_at')
    .eq('client_id', clientId)
    .is('followup_processed_at', null)
    .order('chat_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`Pending chat case lookup failed: ${error.message}`)
  return data || []
}

async function loadContact(supabase, clientId, email) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, email, first_name, unsubscribed, bounce_status, tags, form_submissions')
    .eq('client_id', clientId)
    .eq('email', email)
    .maybeSingle()
  if (error) throw new Error(`Contact lookup failed: ${error.message}`)
  return data || null
}

async function contactNeedsSpacing(supabase, clientId, contactId, leaseSeconds) {
  const sinceIso = new Date(Date.now() - SPACING_HOURS * 3600 * 1000).toISOString()
  const { data: recent, error: e1 } = await supabase.from('ai_followup_drafts').select('id')
    .eq('client_id', clientId).eq('contact_id', contactId).eq('status', 'sent').gt('sent_at', sinceIso).limit(1)
  if (e1) throw new Error(`Spacing lookup failed: ${e1.message}`)
  if (recent && recent.length) return true
  const nowIso = new Date().toISOString()
  const horizonIso = new Date(Date.now() + leaseSeconds * 1000).toISOString()
  const { data: leased, error: e2 } = await supabase.from('ai_followup_contacts').select('id')
    .eq('client_id', clientId).eq('contact_id', contactId).eq('status', 'in_progress')
    .gt('next_followup_at', nowIso).lte('next_followup_at', horizonIso).limit(1)
  if (e2) throw new Error(`Lease lookup failed: ${e2.message}`)
  return Boolean(leased && leased.length)
}

async function markProcessed(supabase, caseId, patch) {
  const { error } = await supabase.from('salesforce_ai_chat_cases')
    .update({ followup_processed_at: new Date().toISOString(), ...patch })
    .eq('id', caseId).is('followup_processed_at', null)
  if (error) throw new Error(`Chat case update failed: ${error.message}`)
}

// What the generate endpoint sees. Visitor side only: the bot's answers never
// reach the model, so it cannot restate them.
function chatSubmission(caseRow) {
  const topic = (caseRow.visitor_messages || []).join(' / ').slice(0, TOPIC_MAX_CHARS)
  const fields = {}
  if (topic) fields.Topic = topic
  if (caseRow.web_page) fields.Page = caseRow.web_page
  return {
    form_name: 'AI Chat',
    submitted_at: caseRow.chat_at || new Date().toISOString(),
    source: 'salesforce_ai_chat_case',
    salesforce_case_id: caseRow.salesforce_id,
    case_number: caseRow.case_number,
    fields,
  }
}

function decide(caseRow, configs, contact, now = new Date()) {
  const config = configs[0] || null
  if (!config) return { action: 'skip', reason: 'no_chat_agent' }
  if (!config.enabled) return { action: 'skip', reason: 'agent_disabled', config }
  if (!config.chat_trigger_since) return { action: 'hold', reason: 'trigger_not_enabled', config }
  const at = caseRow.chat_at ? new Date(caseRow.chat_at) : null
  if (!at || Number.isNaN(at.getTime())) return { action: 'skip', reason: 'no_chat_time', config }
  if (at <= new Date(config.chat_trigger_since)) return { action: 'skip', reason: 'before_cutover', config }
  if (at > now) return { action: 'hold', reason: 'chat_in_future', config }
  const email = normalizeEmail(caseRow.email)
  if (!email) return { action: 'skip', reason: 'no_email', config }
  if (isInternalEmail(email)) return { action: 'skip', reason: 'internal_domain', config }
  if (!(caseRow.visitor_messages || []).length) return { action: 'skip', reason: 'empty_chat', config }
  if (!contact) return { action: 'hold', reason: 'contact_not_synced_yet', config }
  if ((contact.tags || []).includes(INTERNAL_TAG)) return { action: 'skip', reason: 'internal_tag', config }
  if (contact.unsubscribed) return { action: 'skip', reason: 'unsubscribed', config }
  if (contact.bounce_status === 'hard') return { action: 'skip', reason: 'hard_bounced', config }
  return { action: 'enroll', config, contact }
}

/**
 * Enroll new AI Chat cases in the client's chat agent.
 * @param {{supabase, generateDraft?: (contactId, configId) => Promise<any>, leaseSeconds?: number, now?: Date}} deps
 * @param {{dryRun?: boolean, limit?: number, simulateCutover?: string}} [options]
 */
async function enrollChatFollowups(deps, clientId, options = {}) {
  const { supabase, generateDraft } = deps
  const leaseSeconds = deps.leaseSeconds || DEFAULT_LEASE_SECONDS
  const now = deps.now || new Date()
  const dryRun = Boolean(options.dryRun)
  const summary = { enrolled: [], skipped: [], held: [], configs: 0 }

  let configs = await loadChatConfigs(supabase, clientId)
  if (dryRun && options.simulateCutover) {
    configs = configs.map(c => ({ ...c, chat_trigger_since: c.chat_trigger_since || options.simulateCutover }))
  }
  summary.configs = configs.length
  if (!configs.length) return summary

  const cases = await loadPendingCases(supabase, clientId, options.limit || BATCH)
  for (const caseRow of cases) {
    const email = normalizeEmail(caseRow.email)
    const contact = email && !isInternalEmail(email) ? await loadContact(supabase, clientId, email) : null
    const decision = decide(caseRow, configs, contact, now)
    const record = {
      case_id: caseRow.id, case_number: caseRow.case_number, email, chat_at: caseRow.chat_at,
      agent: decision.config?.name || null, reason: decision.reason || null,
    }
    if (decision.action === 'hold') { summary.held.push(record); continue }
    if (decision.action === 'skip') {
      summary.skipped.push(record)
      if (!dryRun) await markProcessed(supabase, caseRow.id, { followup_skip_reason: decision.reason })
      continue
    }
    const { config } = decision
    if (dryRun) { summary.enrolled.push({ ...record, dry_run: true }); continue }

    const submissions = [...(contact.form_submissions || []), chatSubmission(caseRow)]
    const { error: subError } = await supabase.from('contacts').update({ form_submissions: submissions }).eq('id', contact.id)
    if (subError) throw new Error(`Contact submission update failed: ${subError.message}`)

    const spaced = await contactNeedsSpacing(supabase, clientId, contact.id, leaseSeconds)
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
    const { data: enrollment, error: enrollError } = await supabase.from('ai_followup_contacts').insert({
      config_id: config.id, contact_id: contact.id, client_id: clientId,
      status: 'in_progress', current_step: 0,
      next_followup_at: spaced ? now.toISOString() : leaseUntil,
      source_case_id: caseRow.id,
    }).select('id').single()

    if (enrollError) {
      if (enrollError.code === '23505') {
        // One chat follow-up per person; a second chat never starts a second sequence.
        summary.skipped.push({ ...record, reason: 'already_enrolled' })
        await markProcessed(supabase, caseRow.id, { followup_skip_reason: 'already_enrolled' })
        continue
      }
      throw new Error(`Enrollment insert failed: ${enrollError.message}`)
    }
    await markProcessed(supabase, caseRow.id, { followup_enrollment_id: enrollment.id })
    summary.enrolled.push({ ...record, enrollment_id: enrollment.id, immediate: !spaced })
    console.log(`💬 AI chat follow-up: enrolled ${email} (case ${caseRow.case_number})${spaced ? ' — spaced, scheduler will draft' : ''}`)

    if (spaced || !generateDraft) continue
    try {
      await generateDraft(contact.id, config.id)
    } catch (genError) {
      console.error(`⚠️ Immediate chat follow-up generation failed for ${email}:`, genError.message)
      await supabase.from('ai_followup_contacts')
        .update({ next_followup_at: new Date().toISOString() })
        .eq('id', enrollment.id).eq('next_followup_at', leaseUntil)
    }
  }
  if (summary.enrolled.length || summary.skipped.length) {
    console.log(`  💬 Chat follow-ups: ${summary.enrolled.length} enrolled, ${summary.skipped.length} skipped, ${summary.held.length} held${dryRun ? ' (dry run)' : ''}`)
  }
  return summary
}

// ---------- email review ----------

function reviewSecret() {
  const s = process.env.AI_REVIEW_LINK_SECRET || process.env.ENCRYPTION_KEY
  if (!s) throw new Error('AI_REVIEW_LINK_SECRET (or ENCRYPTION_KEY) is required for review links')
  return s
}

function signReviewToken(draftId, reviewerEmail, expiresAt, secret = reviewSecret()) {
  const payload = `${draftId}:${normalizeEmail(reviewerEmail)}:${expiresAt}`
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function verifyReviewToken({ draftId, reviewerEmail, expiresAt, token }, secret = reviewSecret(), now = Date.now()) {
  const exp = Number(expiresAt)
  if (!draftId || !reviewerEmail || !Number.isFinite(exp) || !token) return { ok: false, reason: 'malformed' }
  if (exp < now) return { ok: false, reason: 'expired' }
  const expected = signReviewToken(draftId, reviewerEmail, exp, secret)
  const a = Buffer.from(String(token)), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  return { ok: true }
}

function reviewUrl(baseUrl, draftId, reviewerEmail, expiresAt) {
  const token = signReviewToken(draftId, reviewerEmail, expiresAt)
  const q = new URLSearchParams({ r: normalizeEmail(reviewerEmail), e: String(expiresAt), t: token })
  return `${baseUrl.replace(/\/+$/, '')}/api/ai-followup/review/${draftId}?${q}`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function parseReviewers(config) {
  return String(config?.review_notify_emails || '').split(',').map(normalizeEmail).filter(e => e.includes('@'))
}

// One review email per reviewer (each link is personal and signed).
function buildReviewEmail({ draft, contact, config, caseRow, reviewerEmail, baseUrl, expiresAt }) {
  const link = reviewUrl(baseUrl, draft.id, reviewerEmail, expiresAt)
  const who = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email
  const company = caseRow?.supplied_company || contact.company || ''
  const subject = `Review: chat follow-up to ${who}${company ? ` (${company})` : ''} — case ${caseRow?.case_number || '?'}`
  const text = [
    `A chat follow-up draft is waiting for your review. Nothing sends until someone approves it.`,
    ``,
    `To: ${who} <${contact.email}>${company ? ` — ${company}` : ''}`,
    `Case: ${caseRow?.case_number || '?'}${caseRow?.chat_at ? ` (chat ${String(caseRow.chat_at).slice(0, 10)})` : ''}`,
    `Agent: ${config.name} — from ${config.from_email}, replies go to ${config.reply_to || config.from_email}`,
    ``,
    `Review (approve and send, or skip): ${link}`,
    ``,
    `--- Draft subject ---`,
    draft.subject,
    ``,
    `--- Draft body ---`,
    draft.plain_text,
    ``,
    `--- Chat transcript (for context; not sent to the customer) ---`,
    caseRow?.transcript || '(transcript unavailable)',
    ``,
    `This link is personal to you and expires in 7 days.`,
  ].join('\n')
  const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;max-width:680px">
  <p>A chat follow-up draft is waiting for your review. <strong>Nothing sends until someone approves it.</strong></p>
  <p><strong>To:</strong> ${escapeHtml(who)} &lt;${escapeHtml(contact.email)}&gt;${company ? ` — ${escapeHtml(company)}` : ''}<br>
     <strong>Case:</strong> ${escapeHtml(caseRow?.case_number || '?')}${caseRow?.chat_at ? ` (chat ${escapeHtml(String(caseRow.chat_at).slice(0, 10))})` : ''}<br>
     <strong>Agent:</strong> ${escapeHtml(config.name)} — from ${escapeHtml(config.from_email)}, replies go to ${escapeHtml(config.reply_to || config.from_email)}</p>
  <p style="margin:18px 0"><a href="${escapeHtml(link)}" style="background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Review this draft</a>
     <span style="color:#666;margin-left:10px">approve and send, or skip</span></p>
  <p><strong>Draft subject</strong><br>${escapeHtml(draft.subject)}</p>
  <div style="border:1px solid #ddd;border-radius:6px;padding:12px;background:#fafafa;white-space:pre-wrap">${escapeHtml(draft.plain_text)}</div>
  <p style="margin-top:20px"><strong>Chat transcript</strong> <span style="color:#666">(for context; not sent to the customer)</span></p>
  <div style="border:1px solid #ddd;border-radius:6px;padding:12px;background:#fff;white-space:pre-wrap;font-size:13px;color:#333">${escapeHtml(caseRow?.transcript || '(transcript unavailable)')}</div>
  <p style="color:#666;font-size:12px;margin-top:18px">This link is personal to you and expires in 7 days.</p>
</div>`
  return { subject, text, html, link }
}

/**
 * Email reviewers about pending drafts from chat agents that have not been
 * notified yet. Runs after enrollment and on the hourly sweep so scheduler-
 * generated drafts are covered too.
 * @param {{supabase, sendMail: (clientId, msg) => Promise<void>, baseUrl: string, now?: Date}} deps
 */
async function notifyPendingChatReviews({ supabase, sendMail, baseUrl, now = new Date() }, clientId, options = {}) {
  const configs = await loadChatConfigs(supabase, clientId)
  const out = { notified: [], skipped: [] }
  for (const cfgLite of configs) {
    const { data: config, error: cfgError } = await supabase.from('ai_followup_config')
      .select('id, name, from_email, from_name, reply_to, review_notify_emails').eq('id', cfgLite.id).single()
    if (cfgError) throw new Error(`Config load failed: ${cfgError.message}`)
    const reviewers = options.onlyReviewers?.length ? options.onlyReviewers.map(normalizeEmail) : parseReviewers(config)
    if (!reviewers.length) { out.skipped.push({ config: config.name, reason: 'no_reviewers' }); continue }

    const { data: drafts, error: dErr } = await supabase.from('ai_followup_drafts')
      .select('id, subject, plain_text, contact_id, followup_contact_id, created_at, contact:contacts(id, email, first_name, last_name, company)')
      .eq('client_id', clientId).eq('config_id', config.id).eq('status', 'pending').is('review_notified_at', null)
      .order('created_at', { ascending: true }).limit(20)
    if (dErr) throw new Error(`Pending draft lookup failed: ${dErr.message}`)

    for (const draft of drafts || []) {
      let caseRow = null
      if (draft.followup_contact_id) {
        const { data: enr } = await supabase.from('ai_followup_contacts').select('source_case_id').eq('id', draft.followup_contact_id).maybeSingle()
        if (enr?.source_case_id) {
          const { data: cs } = await supabase.from('salesforce_ai_chat_cases')
            .select('case_number, supplied_company, chat_at, transcript').eq('id', enr.source_case_id).maybeSingle()
          caseRow = cs || null
        }
      }
      const expiresAt = now.getTime() + REVIEW_TOKEN_TTL_MS
      const sent = []
      for (const reviewerEmail of reviewers) {
        const mail = buildReviewEmail({ draft, contact: draft.contact, config, caseRow, reviewerEmail, baseUrl, expiresAt })
        await sendMail(clientId, {
          to: reviewerEmail,
          from: { email: config.from_email, name: `${config.from_name || 'Alconox'} AI follow-up review` },
          replyTo: 'sage@sagerock.com',
          subject: mail.subject, text: mail.text, html: mail.html,
        })
        sent.push(reviewerEmail)
      }
      if (!options.dryRun) {
        const { error: markErr } = await supabase.from('ai_followup_drafts')
          .update({ review_notified_at: now.toISOString() }).eq('id', draft.id).is('review_notified_at', null)
        if (markErr) throw new Error(`Draft notify mark failed: ${markErr.message}`)
      }
      out.notified.push({ draft_id: draft.id, to: sent, contact: draft.contact?.email, case_number: caseRow?.case_number || null })
      console.log(`📨 Chat follow-up review sent to ${sent.join(', ')} for draft ${draft.id}`)
    }
  }
  return out
}

// ---------- review page + actions ----------

function page(title, bodyHtml, status = 200) {
  return { status, html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.5;margin:0;background:#f4f5f7}main{max-width:720px;margin:24px auto;background:#fff;padding:24px;border-radius:8px}pre{white-space:pre-wrap;background:#fafafa;border:1px solid #ddd;border-radius:6px;padding:12px;font-family:inherit}form{display:inline-block;margin-right:12px}button{font-size:15px;padding:10px 18px;border-radius:6px;border:0;cursor:pointer}.ok{background:#1d4ed8;color:#fff}.skip{background:#e5e7eb;color:#111}.muted{color:#666;font-size:13px}</style></head><body><main>${bodyHtml}</main></body></html>` }
}

/**
 * Mount the review routes.
 *   GET  /api/ai-followup/review/:draftId?r=&e=&t=      shows the draft + buttons (no side effects)
 *   POST /api/ai-followup/review/:draftId/approve       body: r, e, t   -> sends
 *   POST /api/ai-followup/review/:draftId/skip          body: r, e, t   -> rejects
 * @param {{supabase, sendAiFollowupDraft, express}} deps
 */
function mountReviewRoutes(app, { supabase, sendAiFollowupDraft, express }) {
  const form = express.urlencoded({ extended: false })

  async function loadDraft(draftId) {
    const { data, error } = await supabase.from('ai_followup_drafts')
      .select('id, subject, plain_text, status, step_number, sent_at, reviewed_by_email, followup_contact_id, contact:contacts(email, first_name, last_name, company), config:ai_followup_config(id, name, trigger_ai_chat, from_email, reply_to, review_notify_emails)')
      .eq('id', draftId).maybeSingle()
    if (error) throw error
    return data
  }

  function authorize(draft, params) {
    const reviewer = normalizeEmail(params.r)
    const check = verifyReviewToken({ draftId: draft.id, reviewerEmail: reviewer, expiresAt: params.e, token: params.t })
    if (!check.ok) return { ok: false, reason: check.reason }
    if (!draft.config?.trigger_ai_chat) return { ok: false, reason: 'not_reviewable' }
    if (!parseReviewers(draft.config).includes(reviewer)) return { ok: false, reason: 'not_a_reviewer' }
    return { ok: true, reviewer }
  }

  function statusPage(draft) {
    if (draft.status === 'sent') return page('Already sent', `<h2>Already sent</h2><p>This follow-up was approved${draft.reviewed_by_email ? ` by ${escapeHtml(draft.reviewed_by_email)}` : ''} and sent to ${escapeHtml(draft.contact?.email || '')}.</p>`)
    if (draft.status === 'rejected') return page('Skipped', `<h2>Skipped</h2><p>This draft was skipped${draft.reviewed_by_email ? ` by ${escapeHtml(draft.reviewed_by_email)}` : ''}. Nothing was sent.</p>`)
    return page('Not available', `<h2>Not available</h2><p>This draft is ${escapeHtml(draft.status)} and can no longer be reviewed here.</p>`, 409)
  }

  app.get('/api/ai-followup/review/:draftId', async (req, res) => {
    try {
      const draft = await loadDraft(req.params.draftId)
      if (!draft) { const p = page('Not found', '<h2>Not found</h2><p>That draft does not exist.</p>', 404); return res.status(p.status).send(p.html) }
      const auth = authorize(draft, req.query)
      if (!auth.ok) { const p = page('Link not valid', `<h2>Link not valid</h2><p>This review link is ${escapeHtml(auth.reason.replace(/_/g, ' '))}. Ask for a fresh review email.</p>`, 403); return res.status(p.status).send(p.html) }
      if (draft.status !== 'pending') { const p = statusPage(draft); return res.status(p.status).send(p.html) }

      const q = new URLSearchParams({ r: auth.reviewer, e: String(req.query.e), t: String(req.query.t) })
      const hidden = ['r', 'e', 't'].map(k => `<input type="hidden" name="${k}" value="${escapeHtml(q.get(k))}">`).join('')
      const who = [draft.contact?.first_name, draft.contact?.last_name].filter(Boolean).join(' ') || draft.contact?.email
      const p = page('Review chat follow-up', `
<h2>Review chat follow-up</h2>
<p><strong>To:</strong> ${escapeHtml(who)} &lt;${escapeHtml(draft.contact?.email || '')}&gt;${draft.contact?.company ? ` — ${escapeHtml(draft.contact.company)}` : ''}<br>
<strong>From:</strong> ${escapeHtml(draft.config.from_email)} · replies go to ${escapeHtml(draft.config.reply_to || draft.config.from_email)}<br>
<strong>Reviewing as:</strong> ${escapeHtml(auth.reviewer)}</p>
<p><strong>Subject:</strong> ${escapeHtml(draft.subject)}</p>
<pre>${escapeHtml(draft.plain_text)}</pre>
<p style="margin-top:20px">
  <form method="post" action="/api/ai-followup/review/${escapeHtml(draft.id)}/approve">${hidden}<button class="ok" type="submit">Approve and send</button></form>
  <form method="post" action="/api/ai-followup/review/${escapeHtml(draft.id)}/skip">${hidden}<button class="skip" type="submit">Skip (do not send)</button></form>
</p>
<p class="muted">Approving sends this exact text to the customer. Skipping records that it was reviewed and nothing goes out.</p>`)
      res.status(p.status).send(p.html)
    } catch (err) {
      console.error('Review page error:', err)
      const p = page('Error', `<h2>Something went wrong</h2><p>${escapeHtml(err.message)}</p>`, 500)
      res.status(p.status).send(p.html)
    }
  })

  app.post('/api/ai-followup/review/:draftId/:action(approve|skip)', form, async (req, res) => {
    try {
      const draft = await loadDraft(req.params.draftId)
      if (!draft) { const p = page('Not found', '<h2>Not found</h2><p>That draft does not exist.</p>', 404); return res.status(p.status).send(p.html) }
      const auth = authorize(draft, req.body || {})
      if (!auth.ok) { const p = page('Link not valid', `<h2>Link not valid</h2><p>This review link is ${escapeHtml(auth.reason.replace(/_/g, ' '))}.</p>`, 403); return res.status(p.status).send(p.html) }
      if (draft.status !== 'pending') { const p = statusPage(draft); return res.status(p.status).send(p.html) }

      if (req.params.action === 'approve') {
        // sendAiFollowupDraft claims pending -> sending atomically, so two
        // reviewers clicking at once cannot double-send.
        await sendAiFollowupDraft(draft.id, null)
        await supabase.from('ai_followup_drafts').update({ reviewed_by_email: auth.reviewer }).eq('id', draft.id)
        console.log(`✅ Chat follow-up approved by ${auth.reviewer} and sent to ${draft.contact?.email}`)
        const p = page('Sent', `<h2>Sent</h2><p>The follow-up is on its way to ${escapeHtml(draft.contact?.email || '')}. Thanks, ${escapeHtml(auth.reviewer)}.</p>`)
        return res.status(p.status).send(p.html)
      }

      const now = new Date().toISOString()
      const { data: updated, error } = await supabase.from('ai_followup_drafts')
        .update({ status: 'rejected', rejection_reason: `Skipped from review email by ${auth.reviewer}`, reviewed_by_email: auth.reviewer, reviewed_at: now })
        .eq('id', draft.id).eq('status', 'pending').select('id').maybeSingle()
      if (error) throw error
      if (!updated) { const fresh = await loadDraft(draft.id); const p = statusPage(fresh); return res.status(p.status).send(p.html) }
      if (draft.followup_contact_id) {
        await supabase.from('ai_followup_contacts').update({ status: 'completed', completed_at: now, next_followup_at: null }).eq('id', draft.followup_contact_id)
      }
      console.log(`⏭️ Chat follow-up skipped by ${auth.reviewer} for ${draft.contact?.email}`)
      const p = page('Skipped', `<h2>Skipped</h2><p>Nothing was sent to ${escapeHtml(draft.contact?.email || '')}. Thanks, ${escapeHtml(auth.reviewer)}.</p>`)
      return res.status(p.status).send(p.html)
    } catch (err) {
      console.error('Review action error:', err)
      const msg = err.validation ? err.message : 'Something went wrong. The draft is still in the queue at mail.sagerock.com.'
      const p = page('Error', `<h2>Could not complete that</h2><p>${escapeHtml(msg)}</p>`, err.statusCode || 500)
      res.status(p.status).send(p.html)
    }
  })
}

module.exports = {
  parseCaseDescription,
  mapCase,
  syncAiChatCases,
  enrollChatFollowups,
  decide,
  chatSubmission,
  notifyPendingChatReviews,
  buildReviewEmail,
  signReviewToken,
  verifyReviewToken,
  reviewUrl,
  parseReviewers,
  mountReviewRoutes,
  isInternalEmail,
}
