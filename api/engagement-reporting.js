// Reporting-only Salesforce refresh and snapshot service.
//
// This path deliberately does not reuse the normal Salesforce sync: that sync
// tags contacts, enrolls follow-ups, and advances clients.last_salesforce_sync.
// Reporting refreshes only read Salesforce and write versioned cache evidence.

const crypto = require('crypto')

const DEFAULT_MAX_RECORDS = 5000
const PAGE_SIZE = 1000
const SF_ID = /^[a-zA-Z0-9]{15,18}$/
const REPORT_TIMEZONE = 'America/New_York'

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, min), max)
}

function iso(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`)
  return d.toISOString()
}

function zonedParts(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}

function zonedLocalToUtc(parts, timezone, milliseconds = 0) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, milliseconds)
  let guess = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = zonedParts(new Date(guess), timezone)
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, milliseconds)
    const correction = target - actualAsUtc
    guess += correction
    if (correction === 0) break
  }
  return new Date(guess)
}

// Shift by local calendar days so a rolling window remains deterministic over
// daylight-saving changes instead of assuming that every local day is 24 hours.
function shiftZonedCalendarDays(value, days, timezone = REPORT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`)
  const local = zonedParts(date, timezone)
  const shifted = new Date(Date.UTC(
    local.year, local.month - 1, local.day + days,
    local.hour, local.minute, local.second, date.getUTCMilliseconds()
  ))
  return zonedLocalToUtc({
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(), hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(),
  }, timezone, shifted.getUTCMilliseconds())
}

function chunks(values, size) {
  const out = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

function recordTypeForId(id, fallback) {
  if (String(id).startsWith('00Q')) return 'lead'
  if (String(id).startsWith('003')) return 'contact'
  return fallback
}

function sourceField(record, recordType) {
  return recordType === 'lead' ? record.Source_code__c : record.Source_Code1__c
}

function mapSalesforceRecord(record, recordType, clientId, runId, contactId, verifiedAt, instanceUrl = '') {
  return {
    run_id: runId,
    client_id: clientId,
    contact_id: contactId || null,
    salesforce_id: record.Id,
    salesforce_link: instanceUrl ? `${String(instanceUrl).replace(/\/$/, '')}/${record.Id}` : null,
    record_type: recordType,
    email: record.Email ? String(record.Email).trim().toLowerCase() : null,
    first_name: record.FirstName || null,
    last_name: record.LastName || null,
    company: record.Company || record.Account?.Name || null,
    owner_name: record.Owner?.Name || null,
    source_code: sourceField(record, recordType) || null,
    salesforce_status: record.Status || null,
    is_converted: record.IsConverted ?? null,
    salesforce_created_date: record.CreatedDate || null,
    salesforce_last_activity_date: record.LastActivityDate || null,
    verification_status: 'resolved',
    verified_at: verifiedAt,
    identity_detail: {},
  }
}

async function queryAll(conn, soql, maxRecords = DEFAULT_MAX_RECORDS) {
  async function withRetry(call) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await call()
      } catch (error) {
        lastError = error
        if (!/REQUEST_LIMIT_EXCEEDED|SERVER_UNAVAILABLE|ECONNRESET|ETIMEDOUT|\b429\b|\b503\b/i.test(String(error?.message || error)) || attempt === 2) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 200 * (2 ** attempt)))
      }
    }
    throw lastError
  }
  let page = await withRetry(() => conn.query(soql))
  const records = []
  const sourceTotal = Number.isFinite(page.totalSize) ? page.totalSize : null
  let complete = true
  while (true) {
    const room = maxRecords - records.length
    if (room <= 0) {
      complete = false
      break
    }
    const incoming = page.records || []
    records.push(...incoming.slice(0, room))
    if (incoming.length > room) {
      complete = false
      break
    }
    if (page.done || !page.nextRecordsUrl) break
    const nextUrl = page.nextRecordsUrl
    page = await withRetry(() => conn.queryMore(nextUrl))
  }
  if (sourceTotal != null && records.length < sourceTotal) complete = false
  return { records, sourceTotal, complete }
}

function unavailableField(message) {
  const match = String(message || '').match(/No such column '([^']+)'/i)
  return match?.[1] || null
}

function unavailableRelationship(message) {
  const match = String(message || '').match(/relationship ['"]?([^'"\s]+)['"]?/i)
  return match?.[1] || null
}

function isUnavailableObject(error) {
  return /sObject type .* is not supported|INVALID_TYPE|insufficient access/i.test(String(error?.message || error))
}

async function queryObject(conn, { object, fields, where, maxRecords }) {
  let selected = [...fields]
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const order = object === 'Lead' || object === 'Contact' ? ' ORDER BY CreatedDate DESC, Id' : ''
      return await queryAll(conn, `SELECT ${selected.join(', ')} FROM ${object}${where ? ` WHERE ${where}` : ''}${order}`, maxRecords)
    } catch (error) {
      const missing = unavailableField(error?.message)
      const index = selected.findIndex(field => field.toLowerCase() === String(missing).toLowerCase())
      if (missing && index >= 0) {
        selected.splice(index, 1)
        continue
      }
      const relationship = unavailableRelationship(error?.message)
      const before = selected.length
      if (relationship) selected = selected.filter(field => !field.toLowerCase().startsWith(`${relationship.toLowerCase()}.`))
      if (selected.length < before) continue
      throw error
    }
  }
  throw new Error(`${object} query failed after removing unavailable fields`)
}

async function defaultLoadKnownCandidates(supabase, clientId, maxRecords, options) {
  const { data, error } = await supabase.rpc('engagement_reporting_candidates', {
    p_client_id: clientId,
    p_start: options.start,
    p_end_exclusive: options.endExclusive,
    p_limit: maxRecords,
  })
  if (error) throw error
  const rows = (data || []).map(({ total_count: _totalCount, ...row }) => row)
  const totalCount = Number(data?.[0]?.total_count || 0)
  return { rows, totalCount, complete: rows.length === totalCount }
}

async function defaultLoadCandidatesBySalesforceIds(supabase, clientId, ids) {
  const rows = []
  for (const part of chunks([...new Set(ids)], 150)) {
    if (!part.length) continue
    const { data, error } = await supabase.from('contacts')
      .select('id,salesforce_id,record_type,email')
      .eq('client_id', clientId)
      .in('salesforce_id', part)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

function candidateWhere(ids) {
  const valid = ids.filter(id => SF_ID.test(String(id)))
  if (!valid.length) return null
  return `Id IN (${valid.map(id => `'${id}'`).join(',')})`
}

function createEngagementReporting({
  supabase,
  getSalesforceConnection,
  now = () => new Date(),
  maxRecords = DEFAULT_MAX_RECORDS,
  loadKnownCandidates = defaultLoadKnownCandidates,
  loadCandidatesBySalesforceIds = defaultLoadCandidatesBySalesforceIds,
  syncOpportunities = null,
}) {
  const flights = new Map()

  async function createRun(clientId, options, asOf, start, endExclusive) {
    const row = {
      client_id: clientId,
      scope: options.scope,
      cohort_type: options.cohortType,
      timezone: options.timezone,
      as_of: asOf,
      window_start: start,
      window_end_exclusive: endExclusive,
      status: 'running',
      started_at: asOf,
      parameters: {
        include_contacts: options.includeContacts,
        max_records: options.maxRecords,
        days: options.days,
      },
    }
    const { data, error } = await supabase.from('engagement_refresh_runs').insert(row).select('id').single()
    if (error) throw error
    return data.id
  }

  async function saveRecords(records) {
    for (const part of chunks(records, 200)) {
      const { error } = await supabase.from('engagement_refresh_records')
        .upsert(part, { onConflict: 'run_id,record_type,salesforce_id' })
      if (error) throw error
    }
  }

  async function finishRun(runId, patch) {
    const { error } = await supabase.from('engagement_refresh_runs').update(patch).eq('id', runId)
    if (error) throw error
  }

  async function refreshSnapshot(clientId, requested = {}) {
    const options = {
      scope: requested.scope || 'recent_leads',
      cohortType: requested.cohortType || (requested.scope === 'known_people' ? 'local_engagement_view' : 'salesforce_leads'),
      timezone: REPORT_TIMEZONE,
      includeContacts: Boolean(requested.includeContacts),
      maxRecords: clampInt(requested.maxRecords, maxRecords, 1, maxRecords),
      days: clampInt(requested.days, 30, 1, 365),
    }
    if (!['recent_leads', 'salesforce_people', 'known_people'].includes(options.scope)) {
      throw new Error(`Unsupported engagement refresh scope: ${options.scope}`)
    }
    const asOf = iso(requested.asOf || now())
    const endExclusive = iso(requested.endExclusive || asOf)
    const start = iso(requested.start || shiftZonedCalendarDays(endExclusive, -options.days, options.timezone))
    const key = [clientId, options.scope, start, endExclusive, options.includeContacts, options.maxRecords].join(':')
    if (flights.has(key)) return flights.get(key)

    const flight = (async () => {
      let runId
      try {
        runId = await createRun(clientId, options, asOf, start, endExclusive)
        const conn = await getSalesforceConnection(clientId)
        if (!conn.version || Number.parseFloat(conn.version) < 50) conn.version = '61.0'
        const verifiedAt = iso(now())
        const candidateById = new Map()
        const expected = new Map()
        let queryPlans = []
        let discoveryComplete = true
        let budgetExceeded = false
        let sourceTotal = 0
        const queryLimitations = []

        if (options.scope === 'known_people') {
          const loaded = await loadKnownCandidates(supabase, clientId, options.maxRecords, {
            start, endExclusive,
          })
          const candidates = Array.isArray(loaded) ? loaded : loaded.rows
          const knownCandidatesComplete = Array.isArray(loaded) ? true : loaded.complete
          if (!knownCandidatesComplete) {
            queryLimitations.push(
              `The dashboard/digest cohort exceeded the configured ${options.maxRecords}-record budget.`
            )
          }
          discoveryComplete = discoveryComplete && knownCandidatesComplete
          for (const candidate of candidates) {
            if (!SF_ID.test(String(candidate.salesforce_id))) continue
            candidateById.set(candidate.salesforce_id, candidate)
          }
          for (const candidate of candidates) {
            if (!SF_ID.test(String(candidate.salesforce_id))) continue
            const type = recordTypeForId(candidate.salesforce_id, candidate.record_type)
            expected.set(`${type}:${candidate.salesforce_id}`, candidate)
          }
          for (const type of ['lead', 'contact']) {
            const ids = [...expected.entries()].filter(([key]) => key.startsWith(`${type}:`)).map(([, c]) => c.salesforce_id)
            for (const part of chunks(ids, 150)) {
              const where = candidateWhere(part)
              if (where) queryPlans.push({ type, where, limit: part.length })
            }
          }
        } else {
          const dateWhere = options.scope === 'recent_leads'
            ? `CreatedDate >= ${start} AND CreatedDate < ${endExclusive}`
            : null
          queryPlans.push({ type: 'lead', where: dateWhere, limit: options.maxRecords })
          if (options.includeContacts) queryPlans.push({ type: 'contact', where: dateWhere, limit: options.maxRecords })
        }

        const fields = {
          lead: ['Id', 'Email', 'FirstName', 'LastName', 'Company', 'Owner.Name', 'Source_code__c', 'Status', 'IsConverted', 'CreatedDate', 'LastActivityDate'],
          contact: ['Id', 'Email', 'FirstName', 'LastName', 'Account.Name', 'Owner.Name', 'Source_Code1__c', 'CreatedDate', 'LastActivityDate'],
        }
        const resolved = []
        for (const plan of queryPlans) {
          const object = plan.type === 'lead' ? 'Lead' : 'Contact'
          let result
          try {
            result = await queryObject(conn, {
              object, fields: fields[plan.type], where: plan.where,
              maxRecords: Math.min(plan.limit, options.maxRecords),
            })
          } catch (error) {
            if (!isUnavailableObject(error)) throw error
            discoveryComplete = false
            queryLimitations.push(`${object} was not accessible to the Salesforce integration user.`)
            continue
          }
          discoveryComplete = discoveryComplete && result.complete
          budgetExceeded = budgetExceeded || !result.complete
          sourceTotal += result.sourceTotal == null ? result.records.length : result.sourceTotal
          for (const record of result.records) {
            const candidate = candidateById.get(record.Id)
            resolved.push(mapSalesforceRecord(
              record, plan.type, clientId, runId, candidate?.id, verifiedAt, conn.instanceUrl
            ))
            expected.delete(`${plan.type}:${record.Id}`)
          }
        }

        if (options.scope !== 'known_people' && resolved.length) {
          const linked = await loadCandidatesBySalesforceIds(
            supabase, clientId, resolved.map(row => row.salesforce_id)
          )
          const linkedById = new Map(linked.map(candidate => [candidate.salesforce_id, candidate]))
          for (const row of resolved) row.contact_id = linkedById.get(row.salesforce_id)?.id || null
        }

        const unresolved = [...expected.entries()].map(([identity, candidate]) => ({
          run_id: runId,
          client_id: clientId,
          contact_id: candidate.id,
          salesforce_id: candidate.salesforce_id,
          record_type: identity.split(':', 1)[0],
          email: candidate.email || null,
          verification_status: 'unresolved',
          verified_at: verifiedAt,
          identity_detail: { reason: 'Salesforce did not return the requested ID; it may be converted, merged, deleted, or inaccessible.' },
        }))
        await saveRecords([...resolved, ...unresolved])

        const { error: applyError } = await supabase.rpc('apply_engagement_snapshot', { p_run_id: runId })
        if (applyError) throw applyError
        let opportunityComplete = null
        if (syncOpportunities) {
          try {
            const opportunityResult = await syncOpportunities(clientId)
            opportunityComplete = opportunityResult?.cohortDiscoveryComplete !== false &&
              opportunityResult?.relationshipComplete !== false
            for (const limitation of opportunityResult?.sourceLimitations || []) {
              queryLimitations.push(limitation)
            }
          } catch (error) {
            opportunityComplete = false
            queryLimitations.push(`Opportunity coverage was unavailable: ${String(error?.message || error)}`)
          }
        }
        const { error: freezeError } = await supabase.rpc('freeze_engagement_snapshot_evidence', {
          p_run_id: runId,
          p_opportunity_verified: opportunityComplete === true,
        })
        if (freezeError) throw freezeError

        const completedAt = iso(now())
        const status = discoveryComplete && unresolved.length === 0 && opportunityComplete !== false
          ? 'complete' : 'partial'
        const limitations = [...queryLimitations]
        if (budgetExceeded) limitations.push(`Salesforce result exceeded the configured ${options.maxRecords}-record budget.`)
        if (unresolved.length) limitations.push(`${unresolved.length} requested Salesforce record(s) were unresolved.`)
        await finishRun(runId, {
          status,
          completed_at: completedAt,
          expected_count: options.scope === 'known_people' ? resolved.length + unresolved.length : sourceTotal,
          resolved_count: resolved.length,
          unresolved_count: unresolved.length,
          failed_count: 0,
          cohort_discovery_complete: discoveryComplete,
          opportunity_discovery_complete: opportunityComplete === true,
          source_limitations: limitations,
        })
        return {
          id: runId, snapshot_id: runId, scope: options.scope, status,
          as_of: asOf, verification_started_at: asOf,
          verification_completed_at: completedAt,
          expected_count: options.scope === 'known_people' ? resolved.length + unresolved.length : sourceTotal,
          resolved_count: resolved.length, unresolved_count: unresolved.length,
          failed_count: 0, cohort_discovery_complete: discoveryComplete,
          opportunity_discovery_complete: opportunityComplete === true,
          source_limitations: limitations,
        }
      } catch (error) {
        if (runId) {
          try {
            await finishRun(runId, {
              status: 'failed', completed_at: iso(now()), failed_count: 1,
              error_message: String(error?.message || error),
            })
          } catch (finishError) {
            console.error('engagement reporting: unable to mark failed run:', finishError.message)
          }
        }
        throw error
      }
    })().finally(() => flights.delete(key))
    flights.set(key, flight)
    return flight
  }

  async function latestComplete(clientId, scope, maxAgeMinutes, requested = {}) {
    const cutoff = new Date(now().getTime() - maxAgeMinutes * 60000).toISOString()
    const { data, error } = await supabase.from('engagement_refresh_runs')
      .select('*').eq('client_id', clientId).eq('scope', scope).eq('status', 'complete')
      .gte('completed_at', cutoff).order('completed_at', { ascending: false }).limit(20)
    if (error) throw error
    const expectedDays = clampInt(requested.days, 30, 1, 365)
    const expectedContacts = Boolean(requested.includeContacts)
    return (data || []).find(run => {
      if (scope === 'known_people') return true
      return Number(run.parameters?.days) === expectedDays &&
        Boolean(run.parameters?.include_contacts) === expectedContacts
    }) || null
  }

  async function ensureFresh(clientId, requested = {}) {
    const scope = requested.scope || 'recent_leads'
    const maxAgeMinutes = clampInt(requested.maxAgeMinutes, 15, 1, 1440)
    const current = await latestComplete(clientId, scope, maxAgeMinutes, requested)
    if (current) return current
    return refreshSnapshot(clientId, { ...requested, scope })
  }

  async function report(clientId, requested = {}) {
    const queryType = requested.queryType || 'recent_leads'
    if (!['inactive_people', 'recent_leads', 'lead_summary'].includes(queryType)) {
      throw new Error(`Unsupported engagement report query: ${queryType}`)
    }
    const scope = queryType === 'inactive_people' ? 'salesforce_people'
      : 'recent_leads'
    let snapshot
    if (requested.snapshotId) {
      const { data, error } = await supabase.from('engagement_refresh_runs')
        .select('*').eq('id', requested.snapshotId).eq('client_id', clientId).single()
      if (error || !data) throw new Error('Engagement snapshot was not found for this tenant')
      if (data.scope !== scope) throw new Error('Engagement snapshot does not match the requested cohort')
      if (!['complete', 'partial'].includes(data.status)) throw new Error('Engagement snapshot is not ready')
      snapshot = data
    } else {
      snapshot = await ensureFresh(clientId, {
        scope,
        days: requested.days,
        start: requested.start,
        endExclusive: requested.endExclusive,
        includeContacts: queryType === 'inactive_people' && Boolean(requested.includeContacts),
        maxAgeMinutes: requested.maxAgeMinutes,
      })
    }
    const limit = clampInt(requested.limit, 50, 1, 100)
    const offset = clampInt(requested.offset, 0, 0, 100000)
    const { data, error } = await supabase.rpc('engagement_snapshot_report', {
      p_client_id: clientId,
      p_snapshot_id: snapshot.id || snapshot.snapshot_id,
      p_query_type: queryType,
      p_limit: limit,
      p_offset: offset,
      p_filters: requested.filters || {},
      p_grace_days: clampInt(requested.graceDays, 3, 0, 60),
    })
    if (error) throw error
    return data
  }

  function verifyInternalRequest(req) {
    const expected = process.env.ASK_ENGAGEMENT_API_KEY
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
    if (!expected || !supplied) return false
    const a = Buffer.from(expected)
    const b = Buffer.from(supplied)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  return { ensureFresh, latestComplete, refreshSnapshot, report, verifyInternalRequest }
}

function mountEngagementReporting(app, deps) {
  const service = createEngagementReporting(deps)

  const handler = async (req, res) => {
    if (!service.verifyInternalRequest(req)) return res.status(401).json({ error: 'Unauthorized' })
    const clientId = process.env.ASK_ENGAGEMENT_CLIENT_ID
    if (!clientId) return res.status(503).json({ error: 'Engagement reporting tenant is not configured' })
    if (process.env.ENGAGEMENT_REPORTING_ENABLED !== 'true') {
      return res.status(503).json({ error: 'Engagement reporting is not enabled' })
    }
    try {
      res.json(await service.report(clientId, req.body || {}))
    } catch (error) {
      console.error('engagement internal report:', error.message)
      res.status(503).json({ error: 'Engagement verification is unavailable', detail: error.message })
    }
  }
  if (deps.reportingLimiter) app.post('/api/internal/engagement/report', deps.reportingLimiter, handler)
  else app.post('/api/internal/engagement/report', handler)

  return service
}

module.exports = {
  createEngagementReporting,
  mapSalesforceRecord,
  mountEngagementReporting,
  queryAll,
  shiftZonedCalendarDays,
}
