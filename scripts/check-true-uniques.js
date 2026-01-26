#!/usr/bin/env node
/**
 * Check true unique counts using pagination
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkTrueUniques() {
  // Find the campaign
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name')
    .ilike('name', '%Most Viewed%')
    .limit(1)

  if (!campaigns || campaigns.length === 0) {
    console.log('Campaign not found')
    return
  }

  const campaignId = campaigns[0].id
  console.log(`Campaign: ${campaigns[0].name}\n`)

  // Paginate through all open events to get true unique count
  console.log('Fetching all open events with pagination...')
  const uniqueOpenEmails = new Set()
  let page = 0
  const pageSize = 1000

  while (true) {
    const { data, error } = await supabase
      .from('analytics_events')
      .select('email')
      .eq('campaign_id', campaignId)
      .eq('event_type', 'open')
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (error) {
      console.error('Error:', error.message)
      break
    }

    if (!data || data.length === 0) break

    for (const row of data) {
      uniqueOpenEmails.add(row.email)
    }

    console.log(`  Page ${page + 1}: fetched ${data.length} rows, ${uniqueOpenEmails.size} unique so far`)

    if (data.length < pageSize) break
    page++
  }

  console.log(`\nTrue unique opens: ${uniqueOpenEmails.size}`)

  // Do the same for clicks
  console.log('\nFetching all click events with pagination...')
  const uniqueClickEmails = new Set()
  const uniqueUnsubClickEmails = new Set()
  page = 0

  while (true) {
    const { data, error } = await supabase
      .from('analytics_events')
      .select('email, url')
      .eq('campaign_id', campaignId)
      .eq('event_type', 'click')
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (error) {
      console.error('Error:', error.message)
      break
    }

    if (!data || data.length === 0) break

    for (const row of data) {
      if (row.url?.includes('/unsubscribe')) {
        uniqueUnsubClickEmails.add(row.email)
      } else {
        uniqueClickEmails.add(row.email)
      }
    }

    console.log(`  Page ${page + 1}: fetched ${data.length} rows, ${uniqueClickEmails.size} engaged clicks, ${uniqueUnsubClickEmails.size} unsub clicks`)

    if (data.length < pageSize) break
    page++
  }

  console.log(`\nTrue unique clicks (excluding unsub): ${uniqueClickEmails.size}`)
  console.log(`True unique unsub clicks: ${uniqueUnsubClickEmails.size}`)

  // Summary comparison
  console.log('\n=== Summary ===')
  console.log('SendGrid reports: 7,847 unique opens, 11,624 unique clicks')
  console.log(`App with pagination: ${uniqueOpenEmails.size} unique opens, ${uniqueClickEmails.size} unique clicks`)
}

checkTrueUniques().catch(console.error)
