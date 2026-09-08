'use strict'

const crypto = require('node:crypto')
const { decrypt } = require('./crypto-utils')

const PAGE_SIZE = 25000
const MAX_ROWS_PER_DAY = 50000
const REPAIR_DAYS = 7

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return isoDate(date)
}

function finalizedDate(now = new Date()) {
  const date = new Date(now)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - 3)
  return isoDate(date)
}

function datesBetween(startDate, endDate) {
  const dates = []
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date)
  return dates
}

function rowKey(values) {
  return crypto.createHash('sha256').update(values.join('\u0000')).digest('hex')
}

function normalizeDetailRow(clientId, dataDate, searchType, apiRow, syncedAt) {
  const [query = '', page = '', country = '', device = ''] = apiRow.keys || []
  return {
    client_id: clientId,
    data_date: dataDate,
    search_type: searchType,
    row_key: rowKey([query, page, country, device]),
    query,
    page,
    country,
    device,
    clicks: apiRow.clicks || 0,
    impressions: apiRow.impressions || 0,
    ctr: apiRow.ctr || 0,
    position: apiRow.position || 0,
    synced_at: syncedAt,
  }
}

async function fetchWithRetry(url, options, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) })
      if (response.ok) return response
      const body = await response.text()
      const error = new Error(`Google API request failed (${response.status}): ${body.slice(0, 500)}`)
      if (response.status < 500 && response.status !== 429) throw error
      lastError = error
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)))
  }
  throw lastError
}

class SearchConsoleClient {
  constructor(credentials) {
    this.credentials = credentials
    this.accessToken = null
    this.accessTokenExpiresAt = 0
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60000) return this.accessToken
    const body = new URLSearchParams({
      client_id: this.credentials.client_id,
      client_secret: this.credentials.client_secret,
      refresh_token: this.credentials.refresh_token,
      grant_type: 'refresh_token',
    })
    const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const token = await response.json()
    this.accessToken = token.access_token
    this.accessTokenExpiresAt = Date.now() + (token.expires_in || 3600) * 1000
    return this.accessToken
  }

  async query(siteUrl, body) {
    const accessToken = await this.getAccessToken()
    const encodedSite = encodeURIComponent(siteUrl)
    const response = await fetchWithRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    return response.json()
  }

  async siteTotals(siteUrl, date, searchType) {
    const result = await this.query(siteUrl, {
      startDate: date,
      endDate: date,
      type: searchType,
      dataState: 'final',
    })
    return result.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  }

  async detailRows(siteUrl, date, searchType) {
    const rows = []
    for (let startRow = 0; startRow < MAX_ROWS_PER_DAY; startRow += PAGE_SIZE) {
      const result = await this.query(siteUrl, {
        startDate: date,
        endDate: date,
        type: searchType,
        dataState: 'final',
        dimensions: ['query', 'page', 'country', 'device'],
        rowLimit: PAGE_SIZE,
        startRow,
      })
      const pageRows = result.rows || []
      rows.push(...pageRows)
      if (pageRows.length < PAGE_SIZE) break
    }
    return { rows, truncated: rows.length >= MAX_ROWS_PER_DAY }
  }
}

function throwIfError(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

async function loadCredentials(supabase, clientId, encryptionKey) {
  const result = await supabase
    .from('search_console_credentials')
    .select('encrypted_credentials')
    .eq('client_id', clientId)
    .single()
  const row = throwIfError(result, 'Could not load Search Console credentials')
  return JSON.parse(decrypt(row.encrypted_credentials, encryptionKey))
}

async function upsertInChunks(supabase, table, rows, onConflict, chunkSize = 500) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const result = await supabase.from(table).upsert(rows.slice(index, index + chunkSize), { onConflict })
    throwIfError(result, `Could not upsert ${table}`)
  }
}

async function syncWindow({ supabase, integration, google, startDate, endDate, searchType, runId }) {
  let detailRowsProcessed = 0
  let daysProcessed = 0
  let truncatedDays = 0

  for (const date of datesBetween(startDate, endDate)) {
    const syncedAt = new Date().toISOString()
    const [totals, detail] = await Promise.all([
      google.siteTotals(integration.site_url, date, searchType),
      google.detailRows(integration.site_url, date, searchType),
    ])

    throwIfError(await supabase.from('search_console_site_daily').upsert({
      client_id: integration.client_id,
      data_date: date,
      search_type: searchType,
      clicks: totals.clicks || 0,
      impressions: totals.impressions || 0,
      ctr: totals.ctr || 0,
      position: totals.position || 0,
      is_final: true,
      synced_at: syncedAt,
    }, { onConflict: 'client_id,data_date,search_type' }), 'Could not upsert site totals')

    const normalized = detail.rows.map(row => normalizeDetailRow(
      integration.client_id,
      date,
      searchType,
      row,
      syncedAt,
    ))
    await upsertInChunks(
      supabase,
      'search_console_query_page_daily',
      normalized,
      'client_id,data_date,search_type,row_key',
    )

    let stale = supabase
      .from('search_console_query_page_daily')
      .delete()
      .eq('client_id', integration.client_id)
      .eq('data_date', date)
      .eq('search_type', searchType)
    stale = normalized.length ? stale.lt('synced_at', syncedAt) : stale
    throwIfError(await stale, 'Could not remove stale Search Console detail rows')

    daysProcessed += 1
    detailRowsProcessed += normalized.length
    if (detail.truncated) truncatedDays += 1

    if (runId && (daysProcessed % 10 === 0 || date === endDate)) {
      throwIfError(await supabase.from('search_console_sync_runs').update({
        days_processed: daysProcessed,
        detail_rows_processed: detailRowsProcessed,
        metadata: { truncated_days: truncatedDays, last_date: date },
      }).eq('id', runId), 'Could not update Search Console sync progress')
    }
  }

  return { daysProcessed, detailRowsProcessed, truncatedDays }
}

async function syncIntegration({ supabase, integration, encryptionKey, startDate, endDate }) {
  const finalDate = finalizedDate()
  const resolvedEnd = endDate || finalDate
  const resolvedStart = startDate || (
    integration.last_final_date
      ? addDays(integration.last_final_date, -(REPAIR_DAYS - 1))
      : integration.backfill_start_date
  )
  if (!resolvedStart) throw new Error(`No backfill start date configured for ${integration.site_url}`)
  if (resolvedStart > resolvedEnd) return { skipped: true, reason: 'No finalized dates to sync' }

  const credentials = await loadCredentials(supabase, integration.client_id, encryptionKey)
  const google = new SearchConsoleClient(credentials)
  const searchTypes = integration.search_types?.length ? integration.search_types : ['web']
  const startedAt = new Date().toISOString()

  throwIfError(await supabase.from('search_console_integrations').update({
    last_sync_started_at: startedAt,
    last_sync_status: 'running',
    last_sync_error: null,
  }).eq('client_id', integration.client_id), 'Could not mark Search Console integration running')

  const aggregate = { daysProcessed: 0, detailRowsProcessed: 0, truncatedDays: 0 }
  try {
    for (const searchType of searchTypes) {
      const run = throwIfError(await supabase.from('search_console_sync_runs').insert({
        client_id: integration.client_id,
        start_date: resolvedStart,
        end_date: resolvedEnd,
        search_type: searchType,
        status: 'running',
      }).select('id').single(), 'Could not create Search Console sync run')

      try {
        const result = await syncWindow({
          supabase,
          integration,
          google,
          startDate: resolvedStart,
          endDate: resolvedEnd,
          searchType,
          runId: run.id,
        })
        aggregate.daysProcessed += result.daysProcessed
        aggregate.detailRowsProcessed += result.detailRowsProcessed
        aggregate.truncatedDays += result.truncatedDays
        throwIfError(await supabase.from('search_console_sync_runs').update({
          status: 'success',
          completed_at: new Date().toISOString(),
          days_processed: result.daysProcessed,
          detail_rows_processed: result.detailRowsProcessed,
          metadata: { truncated_days: result.truncatedDays },
        }).eq('id', run.id), 'Could not complete Search Console sync run')
      } catch (error) {
        await supabase.from('search_console_sync_runs').update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: error.message,
        }).eq('id', run.id)
        throw error
      }
    }

    const completedAt = new Date().toISOString()
    throwIfError(await supabase.from('search_console_integrations').update({
      last_final_date: resolvedEnd,
      last_sync_completed_at: completedAt,
      last_sync_status: 'success',
      last_sync_error: null,
    }).eq('client_id', integration.client_id), 'Could not mark Search Console integration complete')

    return { startDate: resolvedStart, endDate: resolvedEnd, ...aggregate }
  } catch (error) {
    await supabase.from('search_console_integrations').update({
      last_sync_completed_at: new Date().toISOString(),
      last_sync_status: 'error',
      last_sync_error: error.message.slice(0, 2000),
    }).eq('client_id', integration.client_id)
    throw error
  }
}

async function runAllSearchConsoleSyncs({ supabase, encryptionKey, startDate, endDate, clientId }) {
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY is required for Search Console sync')
  let query = supabase.from('search_console_integrations').select('*').eq('enabled', true)
  if (clientId) query = query.eq('client_id', clientId)
  const integrations = throwIfError(await query, 'Could not load Search Console integrations') || []
  const results = []
  for (const integration of integrations) {
    try {
      const result = await syncIntegration({ supabase, integration, encryptionKey, startDate, endDate })
      results.push({ clientId: integration.client_id, siteUrl: integration.site_url, ok: true, ...result })
    } catch (error) {
      results.push({ clientId: integration.client_id, siteUrl: integration.site_url, ok: false, error: error.message })
    }
  }
  return results
}

module.exports = {
  MAX_ROWS_PER_DAY,
  PAGE_SIZE,
  SearchConsoleClient,
  addDays,
  datesBetween,
  finalizedDate,
  normalizeDetailRow,
  rowKey,
  runAllSearchConsoleSyncs,
  syncIntegration,
  syncWindow,
}
