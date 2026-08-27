// ============ SALESFORCE OPPORTUNITY SYNC ============
// Pulls Opportunities (Alconox: sample requests + deals) into
// salesforce_opportunities so the Engagement view can show pipeline state next
// to our own email engagement. Read-only against Salesforce. Called from both
// the manual sync endpoint and the daily cron, after the Lead/Contact sync.
//
// Field list is deliberately tolerant: if the org lacks a custom field the query
// falls back to standard fields only, so this never blocks the contact sync.

const STANDARD_FIELDS = [
  'Id', 'Name', 'StageName', 'IsClosed', 'IsWon', 'Type', 'Amount', 'OwnerId', 'Owner.Name',
  'ContactId', 'AccountId', 'CreatedDate', 'CloseDate', 'LastStageChangeDate', 'LastActivityDate',
  'LastModifiedDate',
]
// Alconox custom fields (sample-request tracker). Optional.
const CUSTOM_FIELDS = [
  'Source_Code__c', 'Email__c', 'Sample_Shipped_Timestamp__c', 'Email_Reply_Date__c',
  'Email_Total_Sent__c', 'Email_Total_Opens__c', 'Survey_Completed__c',
]

function mapOpp(o, clientId) {
  return {
    client_id: clientId,
    salesforce_id: o.Id,
    name: o.Name || null,
    stage: o.StageName || null,
    is_closed: o.IsClosed ?? null,
    is_won: o.IsWon ?? null,
    type: o.Type || null,
    source_code: o.Source_Code__c || null,
    owner_name: o.Owner?.Name || null,
    sf_contact_id: o.ContactId || null,
    sf_account_id: o.AccountId || null,
    contact_email: o.Email__c ? String(o.Email__c).toLowerCase().trim() : null,
    amount: o.Amount ?? null,
    sf_created_date: o.CreatedDate || null,
    close_date: o.CloseDate || null,
    last_stage_change: o.LastStageChangeDate || null,
    last_activity_date: o.LastActivityDate || null,
    sample_shipped_at: o.Sample_Shipped_Timestamp__c || null,
    email_reply_date: o.Email_Reply_Date__c || null,
    email_total_sent: o.Email_Total_Sent__c != null ? Math.round(o.Email_Total_Sent__c) : null,
    email_total_opens: o.Email_Total_Opens__c != null ? Math.round(o.Email_Total_Opens__c) : null,
    survey_completed: o.Survey_Completed__c ?? null,
    synced_at: new Date().toISOString(),
  }
}

/**
 * @param {{supabase, getSalesforceConnection}} deps
 * @param {string} clientId
 * @param {string|null} since ISO timestamp; null = everything
 * @returns {Promise<number>} rows upserted
 */
async function syncSalesforceOpportunities({ supabase, getSalesforceConnection }, clientId, since) {
  const conn = await getSalesforceConnection(clientId)
  // jsforce defaults to an old API version where Opportunity.ContactId doesn't exist.
  if (!conn.version || parseFloat(conn.version) < 50) conn.version = '61.0'
  const where = since ? ` WHERE LastModifiedDate > ${since}` : ''

  // Drop any field the org/user can't see and retry, so a missing custom field
  // never blocks the sync.
  let fields = [...STANDARD_FIELDS, ...CUSTOM_FIELDS]
  let result
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      result = await conn.query(`SELECT ${fields.join(', ')} FROM Opportunity${where} ORDER BY LastModifiedDate`)
      break
    } catch (err) {
      const msg = err?.message || ''
      const m = msg.match(/No such column '([^']+)'/i)
      if (m && fields.some(f => f.toLowerCase() === m[1].toLowerCase())) {
        console.warn(`⚠️ Opportunity sync: field ${m[1]} not available, dropping it`)
        fields = fields.filter(f => f.toLowerCase() !== m[1].toLowerCase())
        continue
      }
      if (/sObject type 'Opportunity' is not supported/i.test(msg)) {
        console.warn('⚠️ Opportunity sync: object not visible to integration user, skipping')
        return 0
      }
      throw err
    }
  }
  if (!result) throw new Error('Opportunity query failed after dropping unavailable fields')

  let total = 0
  const BATCH = 200
  while (true) {
    const rows = (result.records || []).map(o => mapOpp(o, clientId))
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      const { error } = await supabase
        .from('salesforce_opportunities')
        .upsert(chunk, { onConflict: 'client_id,salesforce_id' })
      if (error) console.error('❌ Opportunity upsert failed:', error.message)
      else total += chunk.length
    }
    if (result.done || !result.nextRecordsUrl) break
    result = await conn.queryMore(result.nextRecordsUrl)
  }

  // Fill contact_email from the linked contact where the opp itself has none.
  await supabase.rpc('fill_opportunity_emails', { p_client_id: clientId }).then(({ error }) => {
    if (error && !/does not exist/i.test(error.message)) console.warn('⚠️ fill_opportunity_emails:', error.message)
  })

  console.log(`  📈 Opportunities synced: ${total}`)
  return total
}

module.exports = { syncSalesforceOpportunities }
