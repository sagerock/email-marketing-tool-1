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

  const checkAdminStatus = async (userId: string) => {
    try {
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
        console.warn('Admin check failed:', error.message)
        setAdminUser(null)
        return
      }

      setAdminUser(data)
    } catch (error) {
      console.error('Error checking admin status:', error)
      setAdminUser(null)
    } finally {
      setAdminLoading(false)
    }
  }

  const refreshAdminStatus = async () => {
    if (user) {
      setAdminLoading(true)
      await checkAdminStatus(user.id)
    }
  }

  useEffect(() => {
    // Get initial session
    const initAuth = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession()

        if (error) throw error

        setSession(session)
        setUser(session?.user ?? null)

        if (session?.user) {
          await checkAdminStatus(session.user.id)
        } else {
          setAdminLoading(false)
        }

        setLoading(false)
      } catch (err) {
        console.error('AuthContext - Failed to get session:', err)
        setSession(null)
        setUser(null)
        setAdminLoading(false)
        setLoading(false)
      }
    }

    initAuth()

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)

      if (session?.user) {
        setAdminLoading(true)
        await checkAdminStatus(session.user.id)
      } else {
        setAdminUser(null)
        setAdminLoading(false)
      }

      if (loading) {
        setLoading(false)
      }
    })

    return () => {
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
