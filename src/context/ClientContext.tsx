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
  refreshClients: () => Promise<void>
}

const ClientContext = createContext<ClientContextType | undefined>(undefined)

export function ClientProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  const fetchClients = async () => {
    // Don't fetch if not authenticated
    if (!user) {
      setClients([])
      setSelectedClient(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      console.log('ClientContext - Fetching clients...')
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error
      console.log('ClientContext - Fetched', data?.length || 0, 'clients')
      setClients(data || [])

      // Auto-select first client if none selected
      if (data && data.length > 0 && !selectedClient) {
        // Try to restore from localStorage
        const savedClientId = localStorage.getItem('selectedClientId')
        if (savedClientId) {
          const savedClient = data.find((c) => c.id === savedClientId)
          if (savedClient) {
            console.log('ClientContext - Restored client from localStorage:', savedClient.name)
            setSelectedClient(savedClient)
          } else {
            console.log('ClientContext - Auto-selecting first client:', data[0].name)
            setSelectedClient(data[0])
          }
        } else {
          console.log('ClientContext - Auto-selecting first client:', data[0].name)
          setSelectedClient(data[0])
        }
      }
    } catch (error) {
      console.error('ClientContext - Error fetching clients:', error)
    } finally {
      setLoading(false)
    }
  }

  // Only fetch clients when user is authenticated and auth is done loading
  useEffect(() => {
    if (!authLoading) {
      console.log('ClientContext - Auth loading complete, user:', user?.email ?? 'None')
      fetchClients()
    }
  }, [user, authLoading])

  // Save selected client to localStorage
  useEffect(() => {
    if (selectedClient) {
      localStorage.setItem('selectedClientId', selectedClient.id)
    }
  }, [selectedClient])

  return (
    <ClientContext.Provider
      value={{
        selectedClient,
        setSelectedClient,
        clients,
        loading,
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
