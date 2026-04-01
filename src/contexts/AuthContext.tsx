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
  isClientAdmin: boolean
  assignedClientId: string | null
  loading: boolean
  adminLoading: boolean
  adminCheckFailed: boolean
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
  const [adminLoading, setAdminLoading] = useState(true)
  const [adminCheckFailed, setAdminCheckFailed] = useState(false)

  const checkAdminStatus = async (userId: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`Admin check attempt ${attempt + 1} starting for user ${userId}`)

        const queryPromise = supabase
          .from('admin_users')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle()

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Admin check query timeout after 10s')), 10000)
        )

        const { data, error } = await Promise.race([queryPromise, timeoutPromise])

        if (error) {
          console.warn(`Admin check attempt ${attempt + 1} failed:`, error.message)
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
            continue
          }
          setAdminUser(null)
          setAdminCheckFailed(true)
          setAdminLoading(false)
          return
        }

        console.log(`Admin check succeeded:`, data ? 'admin found' : 'no admin record')
        setAdminUser(data)
        setAdminCheckFailed(false)
        setAdminLoading(false)
        return
      } catch (error) {
        console.warn(`Admin check attempt ${attempt + 1} error:`, error)
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        console.error('All admin check attempts failed:', error)
        setAdminUser(null)
        setAdminCheckFailed(true)
        setAdminLoading(false)
      }
    }
  }

  const refreshAdminStatus = async () => {
    if (user) {
      setAdminLoading(true)
      await checkAdminStatus(user.id)
    }
  }

  useEffect(() => {
    // Use onAuthStateChange as the single source of truth.
    // It emits INITIAL_SESSION on startup (replaces getSession() call)
    // and handles all subsequent auth changes.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('Auth event:', event, 'has session:', !!session, 'has user:', !!session?.user)

      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)

      if (session?.user) {
        // Don't await inside onAuthStateChange — supabase-js holds an internal
        // lock during this callback. Awaiting a Supabase query here deadlocks
        // because the query needs the same lock to read the auth token.
        setAdminLoading(true)
        checkAdminStatus(session.user.id)
      } else {
        setAdminUser(null)
        setAdminLoading(false)
      }
    })

    // Safety fallback: if no auth event fires within 5 seconds,
    // stop loading so the user isn't stuck on the spinner forever.
    // Only clears loading (not adminLoading) to avoid clobbering an in-progress admin check.
    const fallback = setTimeout(() => {
      setLoading(prev => {
        if (prev) {
          console.warn('Auth fallback: no session event received in 5s, clearing loading state')
          return false
        }
        return prev
      })
    }, 5000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(fallback)
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
  const isClientAdmin = adminUser?.role === 'client_admin'
  const assignedClientId = adminUser?.client_id ?? null

  const value = {
    user,
    session,
    adminUser,
    isAdmin,
    isSuperAdmin,
    isClientAdmin,
    assignedClientId,
    loading,
    adminLoading,
    adminCheckFailed,
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
