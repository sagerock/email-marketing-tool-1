#!/usr/bin/env node
/**
 * Find all duplicate sends for a specific campaign
 * Usage: node scripts/find-all-duplicates.js <campaign_name_pattern>
 */

import { createClient } from '@supabase/supabase-js'

const pattern = process.argv[2]

if (!pattern) {
  console.error('Usage: node scripts/find-all-duplicates.js <campaign_name_pattern>')
  process.exit(1)
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function findDuplicates() {
  console.log(`\nSearching for campaigns matching: ${pattern}\n`)

  // Find the campaign
  const { data: campaigns, error: campError } = await supabase
    .from('campaigns')
    .select('id, name, sent_at, recipient_count')
    .ilike('name', `%${pattern}%`)
    .limit(5)

  if (campError) {
    console.error('Error finding campaign:', campError.message)
    process.exit(1)
  }

  if (!campaigns || campaigns.length === 0) {
    console.log('No campaigns found matching that pattern.')
    return
  }

  for (const campaign of campaigns) {
    console.log(`\n=== Campaign: "${campaign.name}" ===`)
    console.log(`Sent: ${campaign.sent_at ? new Date(campaign.sent_at).toLocaleString() : 'Not sent'}`)
    console.log(`Expected recipients: ${campaign.recipient_count}`)

    // Count delivered events grouped by email
    const { data: duplicates, error: dupError } = await supabase
      .rpc('count_duplicate_deliveries', { campaign_uuid: campaign.id })

    if (dupError) {
      // Fallback: get all delivered events and count in JS
      console.log('\nFetching delivery events...')

      const { data: events, error: eventsError } = await supabase
        .from('analytics_events')
        .select('email')
        .eq('campaign_id', campaign.id)
        .eq('event_type', 'delivered')

      if (eventsError) {
        console.error('Error fetching events:', eventsError.message)
        continue
      }

      if (!events || events.length === 0) {
        console.log('No delivery events found for this campaign.')
        continue
      }

      // Count per email
      const emailCounts = {}
      for (const e of events) {
        emailCounts[e.email] = (emailCounts[e.email] || 0) + 1
      }

      const totalDeliveries = events.length
      const uniqueEmails = Object.keys(emailCounts).length
      const duplicateEmails = Object.entries(emailCounts).filter(([_, count]) => count > 1)

      console.log(`\nTotal delivery events: ${totalDeliveries}`)
      console.log(`Unique emails: ${uniqueEmails}`)
      console.log(`Emails with duplicates: ${duplicateEmails.length}`)

      if (duplicateEmails.length > 0) {
        console.log(`\n⚠️  DUPLICATE RECIPIENTS:`)
        // Sort by count descending
        duplicateEmails.sort((a, b) => b[1] - a[1])
        for (const [email, count] of duplicateEmails.slice(0, 50)) {
          console.log(`  ${email}: ${count} deliveries`)
        }
        if (duplicateEmails.length > 50) {
          console.log(`  ... and ${duplicateEmails.length - 50} more`)
        }
      } else {
        console.log('\n✓ No duplicate deliveries found.')
      }
    }
  }
}

findDuplicates().catch(console.error)
