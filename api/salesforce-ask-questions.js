// ============ SALESFORCE ASK ALCONOX MIRROR ============
// Alconox's Ask Alconox and TechNotes forms write one Ask_Alconox__c record per
// question, linked to the Lead or Contact. Staff move Status__c from "New
// Question" to "Reviewed" to "Response Emailed". The engagement report counts a
// "Response Emailed" question as a human follow-up (migration 106).
//
// Runs on every engagement refresh. Each run re-reads the recent window and is
// authoritative for it: a question in the window that Salesforce no longer
// returns is hidden rather than deleted. Read-only against Salesforce. Orgs
// without the object (every client but Alconox) are skipped quietly.

const { queryAll } = require('./engagement-reporting')

const OBJECT = 'Ask_Alconox__c'
const FIELDS = [
  'Id', 'Name', 'Status__c', 'Source_Form__c', 'Source_Code__c', 'Email_Address__c',
  'Associated_Lead__c', 'Associated_Contact__c', 'CreatedDate', 'LastModifiedDate', 'LastModifiedBy.Name',
  'OwnerId', 'Owner.Name',
]
const DEFAULT_DAYS = 120
const MAX_RECORDS = 5000

function isUnsupported(error) {
  return /sObject type 'Ask_Alconox__c' is not supported|INVALID_TYPE/i.test(String(error?.message || error))
}

function mapQuestion(q, clientId, verifiedAt) {
  return {
    client_id: clientId,
    salesforce_id: q.Id,
    name: q.Name || null,
    status: q.Status__c || null,
    source_form: q.Source_Form__c || null,
    source_code: q.Source_Code__c || null,
    email: q.Email_Address__c ? String(q.Email_Address__c).toLowerCase().trim() : null,
    sf_lead_id: q.Associated_Lead__c || null,
    sf_contact_id: q.Associated_Contact__c || null,
    sf_created_at: q.CreatedDate || null,
    sf_last_modified_at: q.LastModifiedDate || null,
    last_modified_by: q.LastModifiedBy?.Name || null,
    owner_id: q.OwnerId || null,
    owner_name: q.Owner?.Name || null,
    visible_in_last_snapshot: true,
    last_verified_at: verifiedAt,
  }
}

/**
 * @param {{supabase, getSalesforceConnection, now?: () => Date}} deps
 * @param {string} clientId
 * @param {{days?: number}} options
 * @returns {Promise<{supported:boolean, complete:boolean, count:number, hidden:number}>}
 */
async function syncSalesforceAskQuestions({ supabase, getSalesforceConnection, now = () => new Date() }, clientId, { days = DEFAULT_DAYS } = {}) {
  const conn = await getSalesforceConnection(clientId)
  if (!conn.version || Number.parseFloat(conn.version) < 50) conn.version = '61.0'
  const verifiedAt = now().toISOString()
  const since = new Date(now().getTime() - days * 86400000).toISOString()

  let result
  try {
    result = await queryAll(conn,
      `SELECT ${FIELDS.join(', ')} FROM ${OBJECT} WHERE CreatedDate >= ${since} ORDER BY CreatedDate`,
      MAX_RECORDS)
  } catch (error) {
    if (isUnsupported(error)) return { supported: false, complete: true, count: 0, hidden: 0 }
    throw error
  }

  const rows = result.records.map(q => mapQuestion(q, clientId, verifiedAt))
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('salesforce_ask_questions')
      .upsert(rows.slice(i, i + 200), { onConflict: 'client_id,salesforce_id' })
    if (error) throw new Error(`Ask Alconox upsert failed: ${error.message}`)
  }

  // Only reconcile when Salesforce returned the whole window; a truncated read
  // would otherwise hide questions that still exist.
  let hidden = 0
  if (result.complete) {
    const seen = new Set(rows.map(r => r.salesforce_id))
    const { data, error } = await supabase.from('salesforce_ask_questions')
      .select('salesforce_id')
      .eq('client_id', clientId).eq('visible_in_last_snapshot', true).gte('sf_created_at', since)
    if (error) throw new Error(`Ask Alconox reconcile read failed: ${error.message}`)
    const gone = (data || []).map(r => r.salesforce_id).filter(id => !seen.has(id))
    for (let i = 0; i < gone.length; i += 200) {
      const { error: hideError } = await supabase.from('salesforce_ask_questions')
        .update({ visible_in_last_snapshot: false, last_verified_at: verifiedAt })
        .eq('client_id', clientId).in('salesforce_id', gone.slice(i, i + 200))
      if (hideError) throw new Error(`Ask Alconox reconcile failed: ${hideError.message}`)
    }
    hidden = gone.length
  }
  return { supported: true, complete: result.complete, count: rows.length, hidden }
}

module.exports = { syncSalesforceAskQuestions, mapQuestion }
