/**
 * Backfill unsubscribed_at dates for contacts missing them.
 *
 * Strategy:
 * 1. Find contacts where unsubscribed=true but unsubscribed_at is null
 * 2. Look up unsubscribe events in analytics_events for those contacts
 * 3. Update contacts with the event timestamp
 *
 * Usage: node api/backfill-unsubscribe-dates.js
 */

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function backfill() {
  // Step 1: Get all unsubscribed contacts without a date
  console.log('Fetching unsubscribed contacts without dates...')

  let allContacts = []
  let offset = 0
  const pageSize = 1000

  while (true) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, email, client_id')
      .eq('unsubscribed', true)
      .is('unsubscribed_at', null)
      .range(offset, offset + pageSize - 1)

    if (error) {
      console.error('Error fetching contacts:', error)
      return
    }

    allContacts = allContacts.concat(data)
    if (data.length < pageSize) break
    offset += pageSize
  }

  console.log(`Found ${allContacts.length} contacts missing unsubscribed_at`)

  if (allContacts.length === 0) {
    console.log('Nothing to backfill.')
    return
  }

  // Step 2: Look up unsubscribe events for these contacts
  let updated = 0
  let noEvent = 0
  const batchSize = 50

  for (let i = 0; i < allContacts.length; i += batchSize) {
    const batch = allContacts.slice(i, i + batchSize)
    const emails = batch.map(c => c.email)

    // Get unsubscribe events for this batch
    const { data: events, error: evError } = await supabase
      .from('analytics_events')
      .select('email, timestamp, created_at')
      .eq('event_type', 'unsubscribe')
      .in('email', emails)

    if (evError) {
      console.error('Error fetching events:', evError)
      continue
    }

    // Build a map of email -> earliest unsubscribe timestamp
    const emailDateMap = {}
    for (const evt of (events || [])) {
      const ts = evt.timestamp || evt.created_at
      if (!ts) continue
      if (!emailDateMap[evt.email] || ts < emailDateMap[evt.email]) {
        emailDateMap[evt.email] = ts
      }
    }

    // Update contacts that have matching events
    for (const contact of batch) {
      const ts = emailDateMap[contact.email]
      if (ts) {
        const { error: upError } = await supabase
          .from('contacts')
          .update({ unsubscribed_at: ts })
          .eq('id', contact.id)

        if (upError) {
          console.error(`Error updating ${contact.email}:`, upError)
        } else {
          updated++
        }
      } else {
        noEvent++
      }
    }

    process.stdout.write(`\rProcessed ${Math.min(i + batchSize, allContacts.length)}/${allContacts.length} (updated: ${updated}, no event found: ${noEvent})`)
  }

  console.log(`\n\nDone! Updated: ${updated}, No event found: ${noEvent}`)
  if (noEvent > 0) {
    console.log(`${noEvent} contacts have no unsubscribe event in analytics_events and will remain without dates.`)
  }
}

backfill().catch(console.error)
