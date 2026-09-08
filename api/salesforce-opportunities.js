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
async function syncSalesforceOpportunities({ supabase, getSalesforceConnection }, clientId, since, options = {}) {
  const conn = await getSalesforceConnection(clientId)
  // jsforce defaults to an old API version where Opportunity.ContactId doesn't exist.
  if (!conn.version || parseFloat(conn.version) < 50) conn.version = '61.0'
  const authoritative = options.authoritative === true
  const maxRecords = Math.min(Math.max(Number.parseInt(options.maxRecords, 10) || 5000, 1), 20000)
  const where = since && !authoritative ? ` WHERE LastModifiedDate > ${since}` : ''

  // Drop any field the org/user can't see and retry, so a missing custom field
  // never blocks the sync.
  let fields = [...STANDARD_FIELDS, ...CUSTOM_FIELDS]
  const droppedFields = []
  let result
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      result = await conn.query(`SELECT ${fields.join(', ')} FROM Opportunity${where} ORDER BY LastModifiedDate`)
      break
    } catch (err) {
      const msg = err?.message || ''
      const m = msg.match(/No such column '([^']+)'/i)
      if (m && fields.some(f => f.toLowerCase() === m[1].toLowerCase())) {
        console.warn(`⚠️ Opportunity sync: field ${m[1]} not available, dropping it`)
        droppedFields.push(m[1])
        fields = fields.filter(f => f.toLowerCase() !== m[1].toLowerCase())
        continue
      }
      if (/sObject type 'Opportunity' is not supported/i.test(msg)) {
        if (authoritative) throw new Error('Opportunity is not visible to the Salesforce integration user')
        console.warn('⚠️ Opportunity sync: object not visible to integration user, skipping')
        return 0
      }
      throw err
    }
  }
  if (!result) throw new Error('Opportunity query failed after dropping unavailable fields')

  const sourceTotal = Number.isFinite(result.totalSize) ? result.totalSize : null
  const sourceRecords = []
  let complete = true
  while (true) {
    const incoming = result.records || []
    const room = maxRecords - sourceRecords.length
    sourceRecords.push(...incoming.slice(0, Math.max(room, 0)))
    if (incoming.length > room || (sourceTotal != null && sourceRecords.length < sourceTotal && sourceRecords.length >= maxRecords)) {
      complete = false
      break
    }
    if (result.done || !result.nextRecordsUrl) break
    result = await conn.queryMore(result.nextRecordsUrl)
  }
  if (sourceTotal != null && sourceRecords.length < sourceTotal) complete = false
  if (!complete) {
    throw new Error(`Opportunity enumeration exceeded the configured ${maxRecords}-record budget`)
  }

  let total = 0
  const seen = new Set()
  const BATCH = 200
  const rows = sourceRecords.map(o => ({
      ...mapOpp(o, clientId),
      verification_status: 'resolved',
      last_verified_at: new Date().toISOString(),
      visible_in_last_snapshot: true,
  }))
  for (const row of rows) seen.add(row.salesforce_id)
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const { error } = await supabase
      .from('salesforce_opportunities')
      .upsert(chunk, { onConflict: 'client_id,salesforce_id' })
    if (error) throw new Error(`Opportunity upsert failed: ${error.message}`)
    total += chunk.length
  }

  // Only a complete, authoritative enumeration may mark cached rows missing.
  // Missing means unresolved/not currently visible, never implicitly closed.
  if (authoritative) {
    let from = 0
    while (true) {
      const { data: cached, error } = await supabase.from('salesforce_opportunities')
        .select('salesforce_id').eq('client_id', clientId)
        .order('salesforce_id', { ascending: true }).range(from, from + 999)
      if (error) throw new Error(`Opportunity reconciliation read failed: ${error.message}`)
      const missing = (cached || []).map(row => row.salesforce_id).filter(id => !seen.has(id))
      for (let i = 0; i < missing.length; i += BATCH) {
        const { error: markError } = await supabase.from('salesforce_opportunities')
          .update({
            visible_in_last_snapshot: false,
            verification_status: 'unresolved',
            last_verified_at: new Date().toISOString(),
          })
          .eq('client_id', clientId).in('salesforce_id', missing.slice(i, i + BATCH))
        if (markError) throw new Error(`Opportunity reconciliation write failed: ${markError.message}`)
      }
      if (!cached || cached.length < 1000) break
      from += 1000
    }
  }

  // Fill contact_email from the linked contact where the opp itself has none.
  await supabase.rpc('fill_opportunity_emails', { p_client_id: clientId }).then(({ error }) => {
    if (error && !/does not exist/i.test(error.message)) console.warn('⚠️ fill_opportunity_emails:', error.message)
  })

  console.log(`  📈 Opportunities synced: ${total}${authoritative ? ' (authoritative snapshot)' : ''}`)
  if (options.returnManifest) {
    const relationshipComplete = !droppedFields.some(field => field.toLowerCase() === 'contactid')
    return {
      count: total,
      cohortDiscoveryComplete: true,
      relationshipComplete,
      sourceLimitations: relationshipComplete ? [] : [
        'Opportunity.ContactId was unavailable; person-level pipeline linkage is incomplete.',
      ],
    }
  }
  return total
}

module.exports = { syncSalesforceOpportunities }
