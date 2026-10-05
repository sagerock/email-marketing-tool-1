// Backfill Ask Alconox questions with their text and the email conversation that answered them
// (migration 107). Read-only against Salesforce; re-runnable (upserts).
//   node api/scripts/backfill-ask-alconox-threads.js <clientId> [--dry] [--days=N] [--verbose]
//
// Salesforce saves most staff answers on the person's Lead/Contact, not on the question record,
// so each question's emails are matched three ways, strongest first:
//   record   EmailMessage.RelatedToId is the question
//   subject  one of the person's emails names the AA number ("Your Ask Alconox request (AA-3630)")
//   person   no answer found above: the person's first staff email after the question, before
//            their next question or 30 days, plus the replies that share its subject
// The automatic "working on a response" confirmation is kept but flagged, and never counts as
// the answer.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const jsforce = require('jsforce')
const { createClient } = require('@supabase/supabase-js')
const { decrypt } = require('../crypto-utils')

const clientId = process.argv[2]
if (!clientId || clientId.startsWith('--')) { console.error('clientId required'); process.exit(1) }
const DRY = process.argv.includes('--dry')
const daysArg = process.argv.find(a => a.startsWith('--days='))
const VERBOSE = process.argv.includes('--verbose')
const DAYS = daysArg ? Number(daysArg.split('=')[1]) : null

const supabase = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
const BODY_MAX = 20000
const PERSON_WINDOW_DAYS = 30
const THREAD_WINDOW_DAYS = 120

async function getConn() {
  const { data: c, error } = await supabase.from('clients')
    .select('salesforce_instance_url, salesforce_client_id, salesforce_client_secret').eq('id', clientId).single()
  if (error) throw error
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: decrypt(c.salesforce_client_id, process.env.ENCRYPTION_KEY),
    client_secret: decrypt(c.salesforce_client_secret, process.env.ENCRYPTION_KEY),
  })
  const t = await (await fetch(`${c.salesforce_instance_url}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json()
  if (!t.access_token) throw new Error('token: ' + JSON.stringify(t))
  return new jsforce.Connection({ instanceUrl: c.salesforce_instance_url, accessToken: t.access_token, version: '61.0' })
}

async function all(conn, soql) {
  let r = await conn.query(soql), out = r.records
  while (!r.done) { r = await conn.queryMore(r.nextRecordsUrl); out = out.concat(r.records) }
  return out
}
const inList = ids => ids.map(id => `'${id}'`).join(',')
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))
const normSubject = s => String(s || '').replace(/^\s*((re|fw|fwd|aw|sv|wg)\s*:\s*|\[?\{?external\}?\]?\s*:?\s*)+/gi, '').trim().toLowerCase()
const isConfirmation = m => /Confirmation of Ask Alconox/i.test(m.subject || '') || /working on a response to your question/i.test(m.body || '')
const isAutomated = m => /Ask Alconox AA-\d+ Assigned|^Your sample request \(SR-\d+\)|^(Automatic reply|Undeliverable|Out of Office)|preparing to ship|order has been received|^Attached is (the )?invoice/i.test(m.subject || '')
const isStaff = m => !m.incoming && /@alconox\.com$/i.test(m.from || '')
const isInternalOnly = m => !!m.to && m.to.split(/[;,]/).every(a => /@alconox\.com\s*$/i.test(a.trim()))

const EM_FIELDS = 'Id, MessageDate, Incoming, FromAddress, ToAddress, Subject, TextBody, RelatedToId'
const toMsg = e => ({
  id: e.Id, at: e.MessageDate, incoming: !!e.Incoming, from: (e.FromAddress || '').toLowerCase(),
  to: e.ToAddress || '', subject: e.Subject || '', body: (e.TextBody || '').slice(0, BODY_MAX), relatedTo: e.RelatedToId,
})

;(async () => {
  const conn = await getConn()
  const where = DAYS ? `WHERE CreatedDate = LAST_N_DAYS:${DAYS}` : ''
  const questions = await all(conn, `SELECT Id, Name, Status__c, Source_Form__c, Source_Code__c, Email_Address__c,
    Associated_Lead__c, Associated_Contact__c, CreatedDate, LastModifiedDate, LastModifiedBy.Name,
    Comments__c, Describe_the_current_cleaning_problem__c FROM Ask_Alconox__c ${where} ORDER BY CreatedDate`)
  console.log(`${questions.length} questions`)

  // Emails saved on the question records
  const byRecord = {}
  for (const ch of chunks(questions.map(q => q.Id), 200)) {
    for (const e of await all(conn, `SELECT ${EM_FIELDS} FROM EmailMessage WHERE RelatedToId IN (${inList(ch)})`)) {
      (byRecord[e.RelatedToId] ||= []).push(toMsg(e))
    }
  }

  // Emails saved on the person's Lead/Contact
  const personIds = [...new Set(questions.flatMap(q => [q.Associated_Lead__c, q.Associated_Contact__c]).filter(Boolean))]
  const byPerson = {}
  for (const ch of chunks(personIds, 100)) {
    const rows = await all(conn, `SELECT RelationId, EmailMessage.Id, EmailMessage.MessageDate, EmailMessage.Incoming,
      EmailMessage.FromAddress, EmailMessage.ToAddress, EmailMessage.Subject, EmailMessage.TextBody, EmailMessage.RelatedToId
      FROM EmailMessageRelation WHERE RelationId IN (${inList(ch)})`)
    for (const r of rows) {
      const list = (byPerson[r.RelationId] ||= new Map())
      if (r.EmailMessage) list.set(r.EmailMessage.Id, toMsg(r.EmailMessage))
    }
    process.stdout.write(`\r  people ${Object.keys(byPerson).length}/${personIds.length}`)
  }
  console.log()

  // Each person's questions in order, to bound the "person" fallback window
  const questionsByPerson = {}
  for (const q of questions) for (const p of [q.Associated_Lead__c, q.Associated_Contact__c].filter(Boolean)) (questionsByPerson[p] ||= []).push(q)

  const now = new Date().toISOString()
  const questionRows = [], messageRows = []
  const tally = { record: 0, subject: 0, person: 0, none: 0 }
  for (const q of questions) {
    const people = [q.Associated_Lead__c, q.Associated_Contact__c].filter(Boolean)
    const personMsgs = new Map()
    for (const p of people) for (const [id, m] of (byPerson[p] || new Map())) personMsgs.set(id, m)
    const matched = new Map() // id -> {m, match}
    for (const m of byRecord[q.Id] || []) matched.set(m.id, { m, match: 'record' })
    const aaRe = new RegExp(`\\b${q.Name.replace('-', '-?')}\\b`, 'i')
    for (const m of personMsgs.values()) if (!matched.has(m.id) && aaRe.test(m.subject)) matched.set(m.id, { m, match: 'subject' })

    const isAnswer = x => isStaff(x.m) && !isConfirmation(x.m) && !isAutomated(x.m) && !isInternalOnly(x.m)
    if (![...matched.values()].some(isAnswer)) {
      const start = q.CreatedDate
      const nextQ = people.flatMap(p => questionsByPerson[p] || []).filter(o => o.Id !== q.Id && o.CreatedDate > start).map(o => o.CreatedDate).sort()[0]
      const capEnd = new Date(new Date(start).getTime() + PERSON_WINDOW_DAYS * 86400000).toISOString()
      const end = nextQ && nextQ < capEnd ? nextQ : capEnd
      const first = [...personMsgs.values()].filter(m => m.at >= start && m.at < end && isAnswer({ m }))
        .sort((a, b) => a.at.localeCompare(b.at))[0]
      if (first) {
        const subj = normSubject(first.subject)
        const threadEnd = new Date(new Date(first.at).getTime() + THREAD_WINDOW_DAYS * 86400000).toISOString()
        for (const m of personMsgs.values()) {
          if (matched.has(m.id) || m.at < start || m.at > threadEnd) continue
          if (m.id === first.id || (subj && normSubject(m.subject) === subj)) matched.set(m.id, { m, match: 'person' })
        }
      }
    }

    const msgs = [...matched.values()].sort((a, b) => a.m.at.localeCompare(b.m.at))
    const answer = msgs.find(isAnswer)
    const conversation = msgs.filter(x => !isConfirmation(x.m) && !isAutomated(x.m))
    const last = conversation[conversation.length - 1]
    const answerMatch = answer ? answer.match : 'none'
    tally[answerMatch]++
    if (VERBOSE && answerMatch !== 'record' && answerMatch !== 'subject' && q.Status__c === 'Response Emailed') {
      console.log(`${q.Name} ${q.CreatedDate.slice(0, 10)} [${answerMatch}] Q: ${String(q.Comments__c || '').replace(/\s+/g, ' ').slice(0, 90)}`)
      if (answer) console.log(`    A ${answer.m.at.slice(0, 10)} ${answer.m.from} | ${answer.m.subject} | ${answer.m.body.replace(/\s+/g, ' ').slice(0, 110)}`)
    }

    questionRows.push({
      client_id: clientId, salesforce_id: q.Id, name: q.Name, status: q.Status__c || null,
      source_form: q.Source_Form__c || null, source_code: q.Source_Code__c || null,
      email: q.Email_Address__c ? String(q.Email_Address__c).toLowerCase().trim() : null,
      sf_lead_id: q.Associated_Lead__c || null, sf_contact_id: q.Associated_Contact__c || null,
      sf_created_at: q.CreatedDate, sf_last_modified_at: q.LastModifiedDate, last_modified_by: q.LastModifiedBy?.Name || null,
      visible_in_last_snapshot: true, last_verified_at: now,
      question_text: [q.Comments__c, q.Describe_the_current_cleaning_problem__c].filter(Boolean).join('\n\n') || null,
      first_answer_at: answer?.m.at || null, first_answer_by: answer?.m.from || null, answer_match: answerMatch,
      message_count: conversation.length, last_message_at: last?.m.at || null,
      last_message_incoming: last ? last.m.incoming : null, threads_synced_at: now,
    })
    for (const { m, match } of msgs) messageRows.push({
      client_id: clientId, question_salesforce_id: q.Id, question_name: q.Name, email_message_id: m.id,
      message_at: m.at, incoming: m.incoming, is_confirmation: isConfirmation(m), from_address: m.from,
      to_address: m.to, subject: m.subject, body: m.body, match, synced_at: now,
    })
  }

  const answered = questions.filter(q => q.Status__c === 'Response Emailed')
  const answeredFound = questionRows.filter(r => r.status === 'Response Emailed' && r.answer_match !== 'none').length
  console.log(`answer found by: ${JSON.stringify(tally)}`)
  console.log(`marked Response Emailed: ${answered.length}, answer found for ${answeredFound} (${(100 * answeredFound / Math.max(1, answered.length)).toFixed(1)}%)`)
  console.log(`${messageRows.length} messages`)
  const byYear = {}
  for (const r of questionRows.filter(r => r.status === 'Response Emailed')) {
    const y = r.sf_created_at.slice(0, 4); byYear[y] ||= [0, 0]; byYear[y][0]++; if (r.answer_match !== 'none') byYear[y][1]++
  }
  console.log('answered / answer found, by year:', JSON.stringify(byYear))
  if (DRY) { console.log('--dry: nothing written'); return }

  for (const ch of chunks(questionRows, 200)) {
    const { error } = await supabase.from('salesforce_ask_questions').upsert(ch, { onConflict: 'client_id,salesforce_id' })
    if (error) throw new Error('question upsert: ' + error.message)
  }
  for (const ch of chunks(messageRows, 200)) {
    const { error } = await supabase.from('salesforce_ask_messages').upsert(ch, { onConflict: 'client_id,question_salesforce_id,email_message_id' })
    if (error) throw new Error('message upsert: ' + error.message)
  }
  console.log(`wrote ${questionRows.length} questions, ${messageRows.length} messages`)
})().catch(e => { console.error(e); process.exit(1) })
