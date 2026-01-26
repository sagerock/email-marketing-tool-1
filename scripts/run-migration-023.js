#!/usr/bin/env node
/**
 * Run migration 023 to add 'block' event type
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing environment variables.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function runMigration() {
  console.log('Running migration to add block event type...\n')

  // Drop and recreate the constraint for analytics_events
  console.log('Updating analytics_events constraint...')
  const { error: error1 } = await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE analytics_events DROP CONSTRAINT IF EXISTS analytics_events_event_type_check;
      ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_event_type_check
        CHECK (event_type IN ('delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe', 'block'));
    `
  })

  if (error1) {
    console.log('Note: Could not use RPC, trying direct approach...')
    // Try a different approach - just test inserting a block event
    const { error: testError } = await supabase
      .from('analytics_events')
      .insert({
        campaign_id: '00000000-0000-0000-0000-000000000000',
        email: 'test@test.com',
        event_type: 'block',
        timestamp: new Date().toISOString(),
      })

    if (testError && testError.message.includes('violates check constraint')) {
      console.error('Migration needed! The constraint does not allow "block" yet.')
      console.error('\nPlease run this SQL in the Supabase SQL Editor:')
      console.error(`
-- Add 'block' to the allowed event types
ALTER TABLE analytics_events DROP CONSTRAINT IF EXISTS analytics_events_event_type_check;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_event_type_check
  CHECK (event_type IN ('delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe', 'block'));

-- Also update sequence_analytics if it has the same constraint
ALTER TABLE sequence_analytics DROP CONSTRAINT IF EXISTS sequence_analytics_event_type_check;
ALTER TABLE sequence_analytics ADD CONSTRAINT sequence_analytics_event_type_check
  CHECK (event_type IN ('delivered', 'open', 'click', 'bounce', 'spam', 'unsubscribe', 'block'));
      `)
      process.exit(1)
    } else if (testError) {
      // Some other error (probably foreign key violation which is expected)
      console.log('Constraint may already allow "block" type (got different error: ' + testError.message + ')')
    } else {
      console.log('Block event type is already allowed!')
      // Clean up test row
      await supabase
        .from('analytics_events')
        .delete()
        .eq('campaign_id', '00000000-0000-0000-0000-000000000000')
        .eq('email', 'test@test.com')
    }
  } else {
    console.log('Migration completed successfully!')
  }
}

runMigration().catch(console.error)
