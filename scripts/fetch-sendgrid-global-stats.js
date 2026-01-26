#!/usr/bin/env node
/**
 * Fetch global stats from SendGrid for a date range
 * Usage: node scripts/fetch-sendgrid-global-stats.js <start_date> <end_date>
 */

import { createClient } from '@supabase/supabase-js'

const startDate = process.argv[2] || '2026-01-21'
const endDate = process.argv[3] || '2026-01-23'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function fetchGlobalStats() {
  // Get the client's SendGrid API key (using Alconox client)
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, name, sendgrid_api_key')
    .not('sendgrid_api_key', 'is', null)
    .limit(1)

  if (error || !clients || clients.length === 0) {
    console.error('Could not find client with SendGrid API key')
    process.exit(1)
  }

  const client = clients[0]
  console.log(`\nUsing client: ${client.name}`)
  console.log(`Fetching global stats for ${startDate} to ${endDate}\n`)

  // Fetch global stats from SendGrid
  const url = new URL('https://api.sendgrid.com/v3/stats')
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date', endDate)
  url.searchParams.set('aggregated_by', 'day')

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${client.sendgrid_api_key}`,
    },
  })

  const data = await response.json()

  if (!response.ok) {
    console.error('SendGrid API error:', data)
    process.exit(1)
  }

  // Display stats by day
  let totals = {
    requests: 0,
    delivered: 0,
    opens: 0,
    unique_opens: 0,
    clicks: 0,
    unique_clicks: 0,
    bounces: 0,
    blocks: 0,
    spam_reports: 0,
    unsubscribes: 0,
    invalid_emails: 0,
    deferred: 0,
    bounce_drops: 0,
    spam_report_drops: 0,
    unsubscribe_drops: 0,
  }

  for (const day of data) {
    console.log(`=== ${day.date} ===`)
    for (const stat of day.stats) {
      const m = stat.metrics
      console.log(`  Requests:       ${m.requests?.toLocaleString() || 0}`)
      console.log(`  Delivered:      ${m.delivered?.toLocaleString() || 0}`)
      console.log(`  Opens:          ${m.opens?.toLocaleString() || 0}`)
      console.log(`  Unique Opens:   ${m.unique_opens?.toLocaleString() || 0}`)
      console.log(`  Clicks:         ${m.clicks?.toLocaleString() || 0}`)
      console.log(`  Unique Clicks:  ${m.unique_clicks?.toLocaleString() || 0}`)
      console.log(`  Bounces:        ${m.bounces?.toLocaleString() || 0}`)
      console.log(`  Blocks:         ${m.blocks?.toLocaleString() || 0}`)
      console.log(`  Spam Reports:   ${m.spam_reports || 0}`)
      console.log(`  Unsubscribes:   ${m.unsubscribes || 0}`)
      console.log(`  Invalid Emails: ${m.invalid_emails || 0}`)
      console.log(`  Deferred:       ${m.deferred?.toLocaleString() || 0}`)
      console.log()

      // Add to totals
      totals.requests += m.requests || 0
      totals.delivered += m.delivered || 0
      totals.opens += m.opens || 0
      totals.unique_opens += m.unique_opens || 0
      totals.clicks += m.clicks || 0
      totals.unique_clicks += m.unique_clicks || 0
      totals.bounces += m.bounces || 0
      totals.blocks += m.blocks || 0
      totals.spam_reports += m.spam_reports || 0
      totals.unsubscribes += m.unsubscribes || 0
      totals.invalid_emails += m.invalid_emails || 0
      totals.deferred += m.deferred || 0
      totals.bounce_drops += m.bounce_drops || 0
      totals.spam_report_drops += m.spam_report_drops || 0
      totals.unsubscribe_drops += m.unsubscribe_drops || 0
    }
  }

  console.log(`=== TOTALS (${startDate} to ${endDate}) ===`)
  console.log(`  Requests:       ${totals.requests.toLocaleString()}`)
  console.log(`  Delivered:      ${totals.delivered.toLocaleString()}`)
  console.log(`  Opens:          ${totals.opens.toLocaleString()}`)
  console.log(`  Unique Opens:   ${totals.unique_opens.toLocaleString()}`)
  console.log(`  Clicks:         ${totals.clicks.toLocaleString()}`)
  console.log(`  Unique Clicks:  ${totals.unique_clicks.toLocaleString()}`)
  console.log(`  Bounces:        ${totals.bounces.toLocaleString()}`)
  console.log(`  Blocks:         ${totals.blocks.toLocaleString()}`)
  console.log(`  Spam Reports:   ${totals.spam_reports}`)
  console.log(`  Unsubscribes:   ${totals.unsubscribes}`)
  console.log(`  Invalid Emails: ${totals.invalid_emails}`)
  console.log(`  Deferred:       ${totals.deferred.toLocaleString()}`)
  console.log()
  console.log(`  Delivery Rate:  ${((totals.delivered / totals.requests) * 100).toFixed(1)}%`)
  console.log(`  Open Rate:      ${((totals.unique_opens / totals.delivered) * 100).toFixed(1)}%`)
  console.log(`  Click Rate:     ${((totals.unique_clicks / totals.delivered) * 100).toFixed(1)}%`)
}

fetchGlobalStats().catch(console.error)
