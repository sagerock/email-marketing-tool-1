import { createContext, useContext, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Client } from '../types/index.js'
import { useAuth } from '../contexts/AuthContext'

interface ClientContextType {
  selectedClient: Client | null
  setSelectedClient: (client: Client | null) => void
  clients: Client[]
  loading: boolean
  canSwitchClients: boolean
  refreshClients: () => Promise<void>
}

const ClientContext = createContext<ClientContextType | undefined>(undefined)

export function ClientProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading, adminUser, adminLoading, isClientAdmin, assignedClientId } = useAuth()
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  const canSwitchClients = !isClientAdmin

  const fetchClients = async () => {
    // Don't fetch if not authenticated or admin status unknown
    if (!user || !adminUser) {
      setClients([])
      setSelectedClient(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      let query = supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false })

      // Client admins only see their assigned client
      if (isClientAdmin && assignedClientId) {
        query = query.eq('id', assignedClientId)
      }

      const { data, error } = await query

      if (error) throw error
      setClients(data || [])

      // Auto-select client
      if (data && data.length > 0 && !selectedClient) {
        if (isClientAdmin) {
          // Client admins always get their assigned client
          setSelectedClient(data[0])
        } else {
          // Super admins: restore from localStorage or pick first
          const savedClientId = localStorage.getItem('selectedClientId')
          if (savedClientId) {
            const savedClient = data.find((c) => c.id === savedClientId)
            setSelectedClient(savedClient || data[0])
          } else {
            setSelectedClient(data[0])
          }
        }
      }
    } catch (error) {
      console.error('ClientContext - Error fetching clients:', error)
    } finally {
      setLoading(false)
    }
  }

  // Fetch clients when auth and admin status are resolved
  useEffect(() => {
    if (!authLoading && !adminLoading) {
      fetchClients()
    }
  }, [user, authLoading, adminUser, adminLoading])

  // Save selected client to localStorage (only for super admins)
  useEffect(() => {
    if (selectedClient && canSwitchClients) {
      localStorage.setItem('selectedClientId', selectedClient.id)
    }
  }, [selectedClient, canSwitchClients])

  return (
    <ClientContext.Provider
      value={{
        selectedClient,
        setSelectedClient,
        clients,
        loading,
        canSwitchClients,
        refreshClients: fetchClients,
      }}
    >
      {children}
    </ClientContext.Provider>
  )
}

export function useClient() {
  const context = useContext(ClientContext)
  if (context === undefined) {
    throw new Error('useClient must be used within a ClientProvider')
  }
  return context
}
