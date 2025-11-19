#!/usr/bin/env node

/**
 * Apply admin_users migration to Supabase
 * This script reads the migration file and applies it using the service role key
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: './api/.env' })

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing environment variables')
  console.error('Make sure VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY are set in api/.env')
  process.exit(1)
}

console.log('🔧 Connecting to Supabase...')
console.log('URL:', SUPABASE_URL)

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

async function applyMigration() {
  try {
    // Read the migration file
    const migrationPath = path.join(__dirname, 'supabase/migrations/003_add_admin_system_fixed.sql')
    console.log('📄 Reading migration file:', migrationPath)

    const sql = fs.readFileSync(migrationPath, 'utf8')
    console.log('✓ Migration file loaded')
    console.log('📝 SQL Preview:')
    console.log(sql.split('\n').slice(0, 10).join('\n'))
    console.log('...\n')

    // Execute the migration using RPC
    console.log('🚀 Executing migration...')

    // We need to use the SQL API endpoint directly
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({ query: sql })
    })

    if (!response.ok) {
      // RPC method might not exist, try direct SQL execution
      console.log('⚠️  RPC method not available, trying direct SQL...')

      // We'll need to use a different approach - execute via pg connection
      // For now, let's just provide instructions
      throw new Error('Please apply the migration manually through the Supabase dashboard')
    }

    console.log('✅ Migration applied successfully!')

    // Verify the table exists
    console.log('\n🔍 Verifying admin_users table...')
    const { data, error } = await supabase.from('admin_users').select('count')

    if (error) {
      console.log('⚠️  Warning:', error.message)
    } else {
      console.log('✅ admin_users table exists and is accessible!')
    }

    console.log('\n✨ Done! The migration has been applied.')
    console.log('\n📌 Next steps:')
    console.log('1. Refresh your browser')
    console.log('2. The 500 error should be gone')
    console.log('3. You can create admin users by running SQL in Supabase dashboard')

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message)
    console.log('\n📋 Manual steps required:')
    console.log('1. Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new')
    console.log('2. Copy the contents of: supabase/migrations/003_add_admin_system_fixed.sql')
    console.log('3. Paste and click "Run"')
    console.log('\n💡 Or run this in the SQL editor:')

    const migrationPath = path.join(__dirname, 'supabase/migrations/003_add_admin_system_fixed.sql')
    const sql = fs.readFileSync(migrationPath, 'utf8')
    console.log('\n' + sql)
  }
}

applyMigration()
