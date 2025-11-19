import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

console.log('🔧 Supabase Configuration Check:')
console.log('📍 URL:', supabaseUrl || '❌ MISSING')
console.log('🔑 Anon Key:', supabaseAnonKey ? '✅ Present (' + supabaseAnonKey.substring(0, 20) + '...)' : '❌ MISSING')
console.log('🌍 Environment:', import.meta.env.MODE)
console.log('📦 All Env Vars:', import.meta.env)

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ CRITICAL ERROR: Missing Supabase environment variables!')
  console.error('This means the environment variables are not set in Vercel.')
  console.error('Expected: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
  throw new Error('Missing Supabase environment variables - check Vercel settings')
}

console.log('✅ Supabase client creating...')

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: window.localStorage,
    storageKey: 'supabase.auth.token',
    flowType: 'pkce'
  }
})

console.log('✅ Supabase client created successfully')
