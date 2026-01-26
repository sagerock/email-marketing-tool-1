#!/usr/bin/env node
/**
 * Check all info about a contact/email
 * Usage: node scripts/check-contact.js <email>
 */

import { createClient } from '@supabase/supabase-js'

const email = process.argv[2]

if (!email) {
  console.error('Usage: node scripts/check-contact.js <email>')
  process.exit(1)
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkContact() {
  console.log(`\nChecking all data for: ${email}\n`)

  // Check contacts table
  const { data: contacts, error: contactError } = await supabase
    .from('contacts')
    .select('*')
    .ilike('email', email)

  if (contactError) {
    console.error('Error fetching contacts:', contactError.message)
  } else if (contacts && contacts.length > 0) {
    console.log(`=== CONTACTS (${contacts.length} found) ===`)
    for (const c of contacts) {
      console.log(`  ID: ${c.id}`)
      console.log(`  Email: ${c.email}`)
      console.log(`  Name: ${c.first_name} ${c.last_name}`)
      console.log(`  Client ID: ${c.client_id}`)
      console.log(`  Unsubscribed: ${c.unsubscribed}`)
      console.log(`  Bounce Status: ${c.bounce_status || 'none'}`)
      console.log(`  Tags: ${c.tags?.join(', ') || 'none'}`)
      console.log()
    }
  } else {
    console.log('=== CONTACTS: Not found ===\n')
  }

  // Check all analytics events
  const { data: events, error: eventsError } = await supabase
    .from('analytics_events')
    .select('*')
    .ilike('email', email)
    .order('timestamp', { ascending: false })
    .limit(50)

  if (eventsError) {
    console.error('Error fetching events:', eventsError.message)
  } else if (events && events.length > 0) {
    console.log(`=== ANALYTICS EVENTS (${events.length} found) ===`)

    // Get campaign names
    const campaignIds = [...new Set(events.map(e => e.campaign_id))]
    const { data: campaigns } = await supabase
      .from('campaigns')
      .select('id, name')
      .in('id', campaignIds)

    const campaignMap = {}
    for (const c of campaigns || []) {
      campaignMap[c.id] = c.name
    }

    for (const e of events) {
      const campaignName = campaignMap[e.campaign_id] || 'Unknown'
      console.log(`  ${new Date(e.timestamp).toLocaleString()} - ${e.event_type.toUpperCase()} - "${campaignName}"`)
    }
  } else {
    console.log('=== ANALYTICS EVENTS: None found ===')
  }
}

checkContact().catch(console.error)
