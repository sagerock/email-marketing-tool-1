#!/usr/bin/env node
/**
 * Check analytics data for a campaign
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkAnalytics() {
  // Find the "Most Viewed" campaign
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, recipient_count')
    .ilike('name', '%Most Viewed%')
    .limit(1)

  if (!campaigns || campaigns.length === 0) {
    console.log('Campaign not found')
    return
  }

  const campaign = campaigns[0]
  console.log(`\nCampaign: ${campaign.name}`)
  console.log(`Recipient count: ${campaign.recipient_count}\n`)

  // Count events by type
  const eventTypes = ['delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe']

  console.log('=== Event Counts ===')
  for (const eventType of eventTypes) {
    const { count } = await supabase
      .from('analytics_events')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('event_type', eventType)

    console.log(`${eventType}: ${count}`)
  }

  // Check unique opens - with default limit
  console.log('\n=== Unique Opens Check ===')
  const { data: opensDefault } = await supabase
    .from('analytics_events')
    .select('email')
    .eq('campaign_id', campaign.id)
    .eq('event_type', 'open')

  console.log(`Rows returned (default limit): ${opensDefault?.length || 0}`)
  const uniqueDefault = new Set(opensDefault?.map(e => e.email) || [])
  console.log(`Unique emails from default query: ${uniqueDefault.size}`)

  // Now with higher limit
  const { data: opensAll, count: totalOpens } = await supabase
    .from('analytics_events')
    .select('email', { count: 'exact' })
    .eq('campaign_id', campaign.id)
    .eq('event_type', 'open')
    .limit(100000)

  console.log(`\nRows returned (100k limit): ${opensAll?.length || 0}`)
  console.log(`Total opens (count): ${totalOpens}`)
  const uniqueAll = new Set(opensAll?.map(e => e.email) || [])
  console.log(`Unique emails from full query: ${uniqueAll.size}`)

  // Check unique clicks
  console.log('\n=== Unique Clicks Check ===')
  const { data: clicksAll, count: totalClicks } = await supabase
    .from('analytics_events')
    .select('email, url', { count: 'exact' })
    .eq('campaign_id', campaign.id)
    .eq('event_type', 'click')
    .limit(1000000)

  console.log(`Total click events: ${totalClicks}`)
  console.log(`Rows returned: ${clicksAll?.length || 0}`)

  // Separate engaged vs unsubscribe clicks
  const engagedClicks = new Set()
  const unsubClicks = new Set()
  for (const event of (clicksAll || [])) {
    if (event.url?.includes('/unsubscribe')) {
      unsubClicks.add(event.email)
    } else {
      engagedClicks.add(event.email)
    }
  }
  console.log(`Unique emails who clicked (excl unsub): ${engagedClicks.size}`)
  console.log(`Unique emails who clicked unsub link: ${unsubClicks.size}`)
}

checkAnalytics().catch(console.error)
