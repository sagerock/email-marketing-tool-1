import { createContext, useContext, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Client } from '../types/index.js'

interface ClientContextType {
  selectedClient: Client | null
  setSelectedClient: (client: Client | null) => void
  clients: Client[]
  loading: boolean
  refreshClients: () => Promise<void>
}

const ClientContext = createContext<ClientContextType | undefined>(undefined)

export function ClientProvider({ children }: { children: ReactNode }) {
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  const fetchClients = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error
      setClients(data || [])

      // Auto-select first client if none selected
      if (data && data.length > 0 && !selectedClient) {
        // Try to restore from localStorage
        const savedClientId = localStorage.getItem('selectedClientId')
        if (savedClientId) {
          const savedClient = data.find((c) => c.id === savedClientId)
          if (savedClient) {
            setSelectedClient(savedClient)
          } else {
            setSelectedClient(data[0])
          }
        } else {
          setSelectedClient(data[0])
        }
      }
    } catch (error) {
      console.error('Error fetching clients:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchClients()
  }, [])

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
