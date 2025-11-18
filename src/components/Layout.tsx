import { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '../lib/utils'
import { Users, Mail, BarChart3, FileText, Settings, Building2 } from 'lucide-react'
import { useClient } from '../context/ClientContext'

interface LayoutProps {
  children: ReactNode
}

const navigation = [
  { name: 'Contacts', href: '/', icon: Users },
  { name: 'Email Designs', href: '/templates', icon: FileText },
  { name: 'Campaigns', href: '/campaigns', icon: Mail },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const { selectedClient, setSelectedClient, clients, loading } = useClient()

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 w-64 bg-white border-r border-gray-200">
        <div className="flex h-16 items-center px-6 border-b border-gray-200">
          <h1 className="text-xl font-bold text-gray-900">Email Marketing</h1>
        </div>

        {/* Client Selector */}
        {!loading && clients.length > 0 && (
          <div className="px-3 py-4 border-b border-gray-200">
            <label className="block text-xs font-medium text-gray-500 mb-2 px-3">
              CURRENT CLIENT
            </label>
            <select
              value={selectedClient?.id || ''}
              onChange={(e) => {
                const client = clients.find((c) => c.id === e.target.value)
                setSelectedClient(client || null)
              }}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            {selectedClient && (
              <div className="mt-2 px-3 flex items-center gap-2 text-xs text-gray-500">
                <Building2 className="h-3 w-3" />
                <span className="truncate">{selectedClient.name}</span>
              </div>
            )}
          </div>
        )}

        {!loading && clients.length === 0 && (
          <div className="px-6 py-4 border-b border-gray-200">
            <p className="text-xs text-gray-500 text-center">
              No clients yet. Add one in Settings.
            </p>
          </div>
        )}

        <nav className="px-3 py-4 space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon
            const isActive = location.pathname === item.href
            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  isActive
                    ? 'bg-blue-50 text-blue-600'
                    : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                )}
              >
                <Icon className="h-5 w-5" />
                {item.name}
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Main content */}
      <main className="pl-64">
        <div className="px-8 py-6">{children}</div>
      </main>
    </div>
  )
}
