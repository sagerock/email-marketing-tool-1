#!/usr/bin/env node
/**
 * Search for emails matching a pattern
 * Usage: node scripts/search-email.js <pattern>
 */

import { createClient } from '@supabase/supabase-js'

const pattern = process.argv[2]

if (!pattern) {
  console.error('Usage: node scripts/search-email.js <pattern>')
  process.exit(1)
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function search() {
  console.log(`\nSearching contacts for: ${pattern}\n`)

  // Search with wildcard
  const { data: contacts, error } = await supabase
    .from('contacts')
    .select('id, email, first_name, last_name, client_id, unsubscribed')
    .ilike('email', `%${pattern}%`)
    .limit(20)

  if (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }

  if (!contacts || contacts.length === 0) {
    console.log('No contacts found matching that pattern.')
    return
  }

  console.log(`Found ${contacts.length} contacts:\n`)
  for (const c of contacts) {
    console.log(`  ${c.email} - ${c.first_name} ${c.last_name} ${c.unsubscribed ? '(UNSUBSCRIBED)' : ''}`)
  }
}

search().catch(console.error)
