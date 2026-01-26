#!/usr/bin/env node
/**
 * Check if an email received duplicate sends for any campaign
 * Usage: node scripts/check-duplicate-sends.js <email>
 */

import { createClient } from '@supabase/supabase-js'

const email = process.argv[2]

if (!email) {
  console.error('Usage: node scripts/check-duplicate-sends.js <email>')
  process.exit(1)
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkDuplicates() {
  console.log(`\nChecking duplicate sends for: ${email}\n`)

  // Use raw SQL for better performance on large tables
  const { data, error } = await supabase.rpc('check_duplicate_sends', {
    target_email: email.toLowerCase()
  })

  if (error) {
    // Fallback to direct query if RPC doesn't exist
    if (error.message.includes('function') || error.message.includes('does not exist')) {
      console.log('Running direct query...\n')

      // Get delivered events with index hint via exact match
      const { data: deliveredEvents, error: queryError } = await supabase
        .from('analytics_events')
        .select('campaign_id, timestamp, sg_event_id')
        .eq('email', email.toLowerCase())
        .eq('event_type', 'delivered')
        .order('timestamp', { ascending: true })
        .limit(100)

      if (queryError) {
        console.error('Error fetching events:', queryError.message)
        process.exit(1)
      }

      if (!deliveredEvents || deliveredEvents.length === 0) {
        console.log('No delivered events found for this email.')
        return
      }

      await processEvents(deliveredEvents)
      return
    }

    console.error('Error:', error.message)
    process.exit(1)
  }

  if (data) {
    await processEvents(data)
  }
}

async function processEvents(deliveredEvents) {
  // Group by campaign_id
  const campaignDeliveries = {}
  for (const event of deliveredEvents) {
    if (!campaignDeliveries[event.campaign_id]) {
      campaignDeliveries[event.campaign_id] = []
    }
    campaignDeliveries[event.campaign_id].push(event)
  }

  // Get campaign names
  const campaignIds = Object.keys(campaignDeliveries)
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, sent_at')
    .in('id', campaignIds)

  const campaignMap = {}
  for (const c of campaigns || []) {
    campaignMap[c.id] = c
  }

  // Report findings
  let duplicatesFound = false
  console.log(`Found ${deliveredEvents.length} delivered events across ${campaignIds.length} campaigns:\n`)

  for (const [campaignId, events] of Object.entries(campaignDeliveries)) {
    const campaign = campaignMap[campaignId]
    const campaignName = campaign?.name || 'Unknown Campaign'
    const sentAt = campaign?.sent_at ? new Date(campaign.sent_at).toLocaleString() : 'Unknown'

    if (events.length > 1) {
      duplicatesFound = true
      console.log(`⚠️  DUPLICATE: "${campaignName}"`)
      console.log(`   Campaign sent: ${sentAt}`)
      console.log(`   Delivered ${events.length} times:`)
      for (const e of events) {
        console.log(`     - ${new Date(e.timestamp).toLocaleString()}`)
      }
      console.log()
    } else {
      console.log(`✓ "${campaignName}" - delivered once (${new Date(events[0].timestamp).toLocaleString()})`)
    }
  }

  if (!duplicatesFound) {
    console.log('\n✓ No duplicate sends detected for this email.')
  } else {
    console.log('\n⚠️  Duplicates were found! Review the campaigns above.')
  }
}

checkDuplicates().catch(console.error)
