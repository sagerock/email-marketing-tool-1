import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { User, Session } from '@supabase/supabase-js'

interface AdminUser {
  id: string
  user_id: string
  email: string
  role: 'super_admin' | 'admin' | 'client_admin'
  client_id: string | null
  created_at: string
}

interface AuthContextType {
  user: User | null
  session: Session | null
  adminUser: AdminUser | null
  isAdmin: boolean
  isSuperAdmin: boolean
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshAdminStatus: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [adminUser, setAdminUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)

  const checkAdminStatus = async (userId: string) => {
    // TEMPORARILY DISABLED - uncomment when admin system is needed
    // The admin check is causing issues with session restoration
    console.log('ℹ️ Admin check skipped (feature disabled)')
    setAdminUser(null)
    return

    /*
    try {
      // Check if admin_users table exists first
      const { data: tableCheck, error: tableError } = await supabase
        .from('admin_users')
        .select('count')
        .limit(0)

      // If table doesn't exist (500 error), skip admin check entirely
      if (tableError && (tableError.code === 'PGRST116' || tableError.message.includes('500'))) {
        console.warn('⚠️ admin_users table does not exist yet - skipping admin check')
        console.warn('👉 To fix: Apply the migration in supabase/migrations/003_add_admin_system_fixed.sql')
        setAdminUser(null)
        return
      }

      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Admin check timeout')), 5000)
      )

      const queryPromise = supabase
        .from('admin_users')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      const { data, error } = await Promise.race([queryPromise, timeoutPromise]) as any

      if (error) {
        // Table might not exist yet or user is not an admin
        console.warn('Admin check failed (table may not exist):', error.message)
        setAdminUser(null)
        return
      }

      setAdminUser(data)
    } catch (error) {
      console.error('Error checking admin status:', error)
      setAdminUser(null)
    }
    */
  }

  const refreshAdminStatus = async () => {
    if (user) {
      await checkAdminStatus(user.id)
    }
  }

  useEffect(() => {
    console.log('🔐 AuthContext - Initializing auth...')

    // Get initial session
    const initAuth = async () => {
      try {
        console.log('🔐 AuthContext - Fetching initial session from Supabase...')

        // Check localStorage first
        const storedSession = localStorage.getItem('supabase.auth.token')
        console.log('🔐 LocalStorage has session:', storedSession ? 'YES' : 'NO')
        if (storedSession) {
          try {
            const parsed = JSON.parse(storedSession)
            console.log('🔐 LocalStorage session expires at:', new Date(parsed.expires_at * 1000).toLocaleString())
          } catch (e) {
            console.warn('🔐 Could not parse stored session')
          }
        }

        const { data: { session }, error } = await supabase.auth.getSession()

        if (error) {
          console.error('❌ AuthContext - Error getting session:', error)
          throw error
        }

        if (session) {
          console.log('✅ AuthContext - Session restored successfully!')
          console.log('👤 User:', session.user.email)
          console.log('🕒 Expires:', new Date(session.expires_at! * 1000).toLocaleString())
        } else {
          console.log('❌ AuthContext - No active session found')
        }

        setSession(session)
        setUser(session?.user ?? null)

        // Check admin status in background, don't block loading
        if (session?.user) {
          checkAdminStatus(session.user.id).catch(err => {
            console.error('Failed to check admin status:', err)
          })
        }

        console.log('🔐 AuthContext - Setting loading to FALSE')
        setLoading(false)
      } catch (err) {
        console.error('❌ AuthContext - Failed to get session:', err)
        setSession(null)
        setUser(null)
        setLoading(false)
      }
    }

    initAuth()

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      console.log('Auth state changed:', _event, 'User:', session?.user?.email ?? 'None')
      setSession(session)
      setUser(session?.user ?? null)

      // Check admin status in background
      if (session?.user) {
        checkAdminStatus(session.user.id).catch(err => {
          console.error('Failed to check admin status:', err)
        })
      } else {
        setAdminUser(null)
      }

      // Don't set loading to false here if it's already false
      // This prevents flickering on auth state changes
      if (loading) {
        setLoading(false)
      }
    })

    return () => {
      console.log('AuthContext - Cleaning up subscription')
      subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
    })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }

  const isAdmin = adminUser !== null
  const isSuperAdmin = adminUser?.role === 'super_admin'

  const value = {
    user,
    session,
    adminUser,
    isAdmin,
    isSuperAdmin,
    loading,
    signIn,
    signUp,
    signOut,
    refreshAdminStatus,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
