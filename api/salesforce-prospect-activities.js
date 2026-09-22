// ============ SALESFORCE PROSPECT ACTIVITY SYNC ============
// Alconox's website writes one Prospect_Activity__c per touch (member resource
// downloads, AI chat, web forms, ...) linked to the Lead or Contact. This pulls
// them into salesforce_prospect_activities and tags the matching contacts so
// downloads can drive audiences. Read-only against Salesforce. Called from both
// the manual sync endpoint and the daily cron, after the Lead/Contact sync so a
// brand-new lead already exists as a contact when its downloads are tagged.
//
// Tags (Resource Download channel only):
//   "Resource Download"               everyone who downloaded anything
//   "Downloaded: <Source_Detail__c>"  per resource
//
// Orgs without the custom object are skipped quietly.

const FIELDS = [
  'Id', 'Name', 'Channel__c', 'Source_Detail__c', 'Web_Page__c', 'Touchpoint_DateTime__c',
  'Download_Count__c', 'Email__c', 'Lead__c', 'Contact__c', 'Account__c', 'Campaign__c',
  'Session_Id__c', 'CreatedDate', 'LastModifiedDate',
]
const DOWNLOAD_CHANNEL = 'Resource Download'
const ALL_DOWNLOADS_TAG = 'Resource Download'

function downloadTag(detail) {
  return `Downloaded: ${String(detail).trim()}`
}

function mapActivity(a, clientId) {
  return {
    client_id: clientId,
    salesforce_id: a.Id,
    name: a.Name || null,
    channel: a.Channel__c || null,
    source_detail: a.Source_Detail__c || null,
    web_page: a.Web_Page__c || null,
    touchpoint_at: a.Touchpoint_DateTime__c || a.CreatedDate || null,
    download_count: a.Download_Count__c != null ? Math.round(a.Download_Count__c) : null,
    email: a.Email__c ? String(a.Email__c).toLowerCase().trim() : null,
    sf_lead_id: a.Lead__c || null,
    sf_contact_id: a.Contact__c || null,
    sf_account_id: a.Account__c || null,
    sf_campaign_id: a.Campaign__c || null,
    session_id: a.Session_Id__c || null,
    sf_created_date: a.CreatedDate || null,
    sf_last_modified: a.LastModifiedDate || null,
    synced_at: new Date().toISOString(),
  }
}

// Rows without Email__c: take the email of the linked contact (Contact first,
// then Lead) from our own contacts table.
async function fillMissingEmails(supabase, clientId, rows) {
  const ids = [...new Set(rows.filter(r => !r.email).flatMap(r => [r.sf_contact_id, r.sf_lead_id]).filter(Boolean))]
  if (!ids.length) return
  const byId = new Map()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('contacts')
      .select('salesforce_id, email').eq('client_id', clientId).in('salesforce_id', ids.slice(i, i + 200))
    if (error) throw new Error(`Prospect activity email lookup failed: ${error.message}`)
    for (const c of data || []) byId.set(c.salesforce_id, c.email)
  }
  for (const r of rows) {
    if (!r.email) r.email = byId.get(r.sf_contact_id) || byId.get(r.sf_lead_id) || null
  }
}

async function tagDownloaders(supabase, clientId, rows) {
  const tagEmails = new Map()
  const add = (tag, email) => {
    if (!tagEmails.has(tag)) tagEmails.set(tag, new Set())
    tagEmails.get(tag).add(email)
  }
  for (const r of rows) {
    if (r.channel !== DOWNLOAD_CHANNEL || !r.email) continue
    add(ALL_DOWNLOADS_TAG, r.email)
    if (r.source_detail) add(downloadTag(r.source_detail), r.email)
  }

  for (const [tag, emails] of tagEmails) {
    try {
      const { error } = await supabase.rpc('append_tag_to_contacts', {
        p_client_id: clientId, p_tag_name: tag, p_emails: [...emails],
      })
      if (error) throw new Error(error.message)
      const { count } = await supabase.from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .filter('tags', 'cs', `{${JSON.stringify(tag)}}`)
      await supabase.from('tags').upsert(
        { name: tag, client_id: clientId, contact_count: count ?? 0 },
        { onConflict: 'name,client_id' })
    } catch (err) {
      // Tag failures never break the sync; the activity rows are already stored.
      console.error(`Error appending tag "${tag}":`, err.message)
    }
  }
  return tagEmails.size
}

/**
 * @param {{supabase, getSalesforceConnection}} deps
 * @param {string} clientId
 * @param {string|null} since ISO timestamp; null = everything
 * @returns {Promise<{count:number, tags:number}>}
 */
async function syncSalesforceProspectActivities({ supabase, getSalesforceConnection }, clientId, since) {
  const conn = await getSalesforceConnection(clientId)
  const where = since ? ` WHERE LastModifiedDate > ${since}` : ''

  let result
  try {
    result = await conn.query(`SELECT ${FIELDS.join(', ')} FROM Prospect_Activity__c${where} ORDER BY LastModifiedDate`)
  } catch (err) {
    if (/sObject type 'Prospect_Activity__c' is not supported|INVALID_TYPE/i.test(err?.message || '')) {
      return { count: 0, tags: 0 }
    }
    throw err
  }

  const rows = []
  while (true) {
    for (const a of result.records || []) rows.push(mapActivity(a, clientId))
    if (result.done || !result.nextRecordsUrl) break
    result = await conn.queryMore(result.nextRecordsUrl)
  }
  if (!rows.length) return { count: 0, tags: 0 }

  await fillMissingEmails(supabase, clientId, rows)

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('salesforce_prospect_activities')
      .upsert(rows.slice(i, i + 200), { onConflict: 'client_id,salesforce_id' })
    if (error) throw new Error(`Prospect activity upsert failed: ${error.message}`)
  }

  const tags = await tagDownloaders(supabase, clientId, rows)
  let rosterGaps = null
  try {
    rosterGaps = await checkCampaignRoster(conn)
  } catch (err) {
    console.warn('⚠️ Prospect activity roster check failed:', err.message)
  }
  console.log(`  🧾 Prospect activities synced: ${rows.length} (${tags} tag(s) applied)`)
  return { count: rows.length, tags, rosterGaps }
}

// The site also adds every downloader to a Salesforce campaign ("Resource
// Download 2026"). Anyone in that campaign with no download activity means the
// activity feed dropped something; log them so the gap is noticed.
async function checkCampaignRoster(conn) {
  const acts = await queryAll(conn, `SELECT Lead__c, Contact__c, Campaign__c FROM Prospect_Activity__c WHERE Channel__c = '${DOWNLOAD_CHANNEL}'`)
  const campaignIds = [...new Set(acts.map(a => a.Campaign__c).filter(Boolean))]
  if (!campaignIds.length) return []
  const people = new Set(acts.flatMap(a => [a.Lead__c, a.Contact__c]).filter(Boolean))
  const members = await queryAll(conn, `SELECT Email, LeadId, ContactId FROM CampaignMember WHERE CampaignId IN (${campaignIds.map(id => `'${id}'`).join(',')})`)
  const gaps = members
    .filter(m => !people.has(m.LeadId) && !people.has(m.ContactId))
    .map(m => m.Email || m.ContactId || m.LeadId)
  if (gaps.length) console.warn(`  ⚠️ ${gaps.length} download-campaign member(s) have no download activity: ${gaps.slice(0, 10).join(', ')}`)
  return gaps
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

module.exports = { syncSalesforceProspectActivities, mapActivity, downloadTag }
