// ============ SALESFORCE TASK + EMAILMESSAGE MIRROR ============
// Bubble-up (migration 112) needs to see who followed up with whom. Tasks hold the trade-show
// follow-ups and logged calls; EmailMessage holds the mail Alconox saves in Salesforce, both
// directions. Read-only against Salesforce; upserts, so re-runs are safe.
//
// Tasks: every open Task plus anything modified in the last TASK_DAYS days.
// Email: everything sent or received in the last EMAIL_DAYS days, body cut to BODY_MAX.
// Orgs where the object isn't visible to the integration user are skipped quietly.

const TASK_DAYS = 120
const EMAIL_DAYS = 90
const BODY_MAX = 2000
const MAX_RECORDS = 40000

const TASK_FIELDS = [
  'Id', 'Subject', 'Status', 'Priority', 'IsClosed', 'TaskSubtype', 'ActivityDate', 'CreatedDate',
  'LastModifiedDate', 'CompletedDateTime', 'OwnerId', 'Owner.Name', 'CreatedBy.Name',
  'WhoId', 'Who.Name', 'WhatId', 'What.Name', 'Description',
]
const EMAIL_FIELDS = [
  'Id', 'MessageDate', 'Incoming', 'FromAddress', 'FromName', 'ToAddress', 'CcAddress', 'Subject',
  'TextBody', 'RelatedToId', 'RelatedTo.Name',
]

const unsupported = e => /is not supported|INVALID_TYPE/i.test(String(e?.message || e))
const lower = s => (s ? String(s).toLowerCase().trim() : null)
const cut = (s, n = BODY_MAX) => (s ? String(s).slice(0, n) : null)

async function readAll(conn, soql) {
  let r = await conn.query(soql)
  const out = [...(r.records || [])]
  while (!r.done && r.nextRecordsUrl) {
    if (out.length >= MAX_RECORDS) throw new Error(`more than ${MAX_RECORDS} records for: ${soql.slice(0, 80)}`)
    r = await conn.queryMore(r.nextRecordsUrl)
    out.push(...(r.records || []))
  }
  return out
}

// Fields the org lacks (CompletedDateTime, TaskSubtype on old orgs) are dropped and retried.
async function readTolerant(conn, fields, from, where) {
  let list = [...fields]
  for (let i = 0; i < 10; i++) {
    try {
      return await readAll(conn, `SELECT ${list.join(', ')} FROM ${from} WHERE ${where}`)
    } catch (e) {
      const m = String(e?.message || '').match(/No such column '([^']+)'/i)
      if (!m || !list.some(f => f.toLowerCase() === m[1].toLowerCase())) throw e
      list = list.filter(f => f.toLowerCase() !== m[1].toLowerCase())
    }
  }
  throw new Error(`${from} query failed after dropping fields`)
}

function mapTask(t, clientId, at) {
  return {
    client_id: clientId, salesforce_id: t.Id, subject: t.Subject || null, status: t.Status || null,
    priority: t.Priority || null, is_closed: t.IsClosed ?? null, task_subtype: t.TaskSubtype || null,
    activity_date: t.ActivityDate || null, sf_created_at: t.CreatedDate || null,
    sf_last_modified_at: t.LastModifiedDate || null, completed_at: t.CompletedDateTime || null,
    owner_id: t.OwnerId || null, owner_name: t.Owner?.Name || null, created_by_name: t.CreatedBy?.Name || null,
    who_id: t.WhoId || null, who_name: t.Who?.Name || null, what_id: t.WhatId || null,
    what_name: t.What?.Name || null, description: cut(t.Description), synced_at: at,
  }
}

function mapEmail(m, clientId, at) {
  return {
    client_id: clientId, salesforce_id: m.Id, message_at: m.MessageDate || null, incoming: !!m.Incoming,
    from_address: lower(m.FromAddress), from_name: m.FromName || null, to_address: m.ToAddress || null,
    cc_address: m.CcAddress || null, subject: m.Subject || null, body: cut(m.TextBody),
    related_to_id: m.RelatedToId || null, related_to_name: m.RelatedTo?.Name || null, synced_at: at,
  }
}

async function upsert(supabase, table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict: 'client_id,salesforce_id' })
    if (error) throw new Error(`${table} upsert failed: ${error.message}`)
  }
}

/**
 * @param {{supabase, getSalesforceConnection, now?: () => Date}} deps
 * @returns {Promise<{tasks: number|null, emails: number|null}>} null = object not visible
 */
async function syncSalesforceActivity({ supabase, getSalesforceConnection, now = () => new Date() }, clientId,
  { taskDays = TASK_DAYS, emailDays = EMAIL_DAYS } = {}) {
  const conn = await getSalesforceConnection(clientId)
  if (!conn.version || Number.parseFloat(conn.version) < 50) conn.version = '61.0'
  const at = now().toISOString()
  const out = { tasks: null, emails: null }

  try {
    const tasks = await readTolerant(conn, TASK_FIELDS, 'Task',
      `IsClosed = false OR LastModifiedDate = LAST_N_DAYS:${taskDays}`)
    await upsert(supabase, 'salesforce_tasks', tasks.map(t => mapTask(t, clientId, at)))
    out.tasks = tasks.length
    // Every open Task comes back each run, so an "open" row this run didn't touch was deleted
    // in Salesforce. Drop it rather than keep a ghost on the trade-show list.
    const { error } = await supabase.from('salesforce_tasks').delete()
      .eq('client_id', clientId).eq('is_closed', false).lt('synced_at', at)
    if (error) throw new Error(`salesforce_tasks cleanup failed: ${error.message}`)
  } catch (e) { if (!unsupported(e)) throw e }

  try {
    const emails = await readTolerant(conn, EMAIL_FIELDS, 'EmailMessage', `MessageDate = LAST_N_DAYS:${emailDays}`)
    await upsert(supabase, 'salesforce_email_messages', emails.map(m => mapEmail(m, clientId, at)))
    out.emails = emails.length
  } catch (e) { if (!unsupported(e)) throw e }

  return out
}

module.exports = { syncSalesforceActivity, mapTask, mapEmail }
