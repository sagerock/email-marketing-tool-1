import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Client } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import { Plus, Settings as SettingsIcon, X } from 'lucide-react'

export default function Settings() {
  const { refreshClients } = useClient()
  const [clients, setClients] = useState<Client[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error
      setClients(data || [])
    } catch (error) {
      console.error('Error fetching clients:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (
      !confirm(
        'Are you sure? This will delete the client and all associated data (contacts, campaigns, etc.)'
      )
    )
      return

    try {
      const { error } = await supabase.from('clients').delete().eq('id', id)
      if (error) throw error
      fetchClients()
    } catch (error) {
      console.error('Error deleting client:', error)
      alert('Failed to delete client')
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage clients and SendGrid configurations
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Client
        </Button>
      </div>

      {/* Clients List */}
      <Card>
        <CardHeader>
          <CardTitle>Client Configurations</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading clients...</div>
          ) : clients.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <SettingsIcon className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>No clients configured. Add your first client to get started.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {clients.map((client) => (
                <div
                  key={client.id}
                  className="border border-gray-200 rounded-lg p-4 hover:border-gray-300"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-semibold text-gray-900">{client.name}</h3>
                      <div className="mt-2 space-y-1 text-sm">
                        <div>
                          <span className="text-gray-500">SendGrid API Key: </span>
                          <span className="font-mono text-gray-900">
                            {client.sendgrid_api_key.substring(0, 20)}...
                          </span>
                        </div>
                        {client.ip_pools && client.ip_pools.length > 0 && (
                          <div>
                            <span className="text-gray-500">IP Pools: </span>
                            <span className="text-gray-900">
                              {client.ip_pools.join(', ')}
                            </span>
                          </div>
                        )}
                        <div className="text-xs text-gray-400">
                          Added {new Date(client.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingClient(client)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(client.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Information Card */}
      <Card>
        <CardHeader>
          <CardTitle>SendGrid Setup</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm text-gray-600">
            <p>
              To use this email marketing tool, you'll need a SendGrid account and API
              key:
            </p>
            <ol>
              <li>Create a SendGrid account at sendgrid.com</li>
              <li>Generate an API key with Full Access permissions</li>
              <li>Add your client configuration above with the API key</li>
              <li>
                (Optional) Configure dedicated IP addresses and create IP pools in
                SendGrid
              </li>
            </ol>
            <p className="mt-4">
              <strong>Webhook Setup:</strong> For analytics to work, configure SendGrid
              Event Webhook to point to your server endpoint (e.g.,
              /api/webhook/sendgrid)
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Add Client Modal */}
      {showAddModal && (
        <AddClientModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            fetchClients()
            refreshClients()
          }}
        />
      )}

      {/* Edit Client Modal */}
      {editingClient && (
        <EditClientModal
          client={editingClient}
          onClose={() => setEditingClient(null)}
          onSuccess={() => {
            setEditingClient(null)
            fetchClients()
            refreshClients()
          }}
        />
      )}
    </div>
  )
}

function AddClientModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void
  onSuccess: () => void
}) {
  const [formData, setFormData] = useState({
    name: '',
    sendgrid_api_key: '',
    ip_pools: '',
    mailing_address: '',
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const ip_pools = formData.ip_pools
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)

      const { error } = await supabase.from('clients').insert({
        name: formData.name,
        sendgrid_api_key: formData.sendgrid_api_key,
        ip_pools: ip_pools.length > 0 ? ip_pools : null,
        mailing_address: formData.mailing_address || null,
      })

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error adding client:', error)
      alert('Failed to add client')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Add New Client</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Client Name *"
            required
            placeholder="My Company"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />
          <Input
            label="SendGrid API Key *"
            required
            type="password"
            placeholder="SG.xxx..."
            value={formData.sendgrid_api_key}
            onChange={(e) =>
              setFormData({ ...formData, sendgrid_api_key: e.target.value })
            }
          />
          <Input
            label="IP Pools (comma-separated, optional)"
            placeholder="pool1, pool2"
            value={formData.ip_pools}
            onChange={(e) =>
              setFormData({ ...formData, ip_pools: e.target.value })
            }
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Mailing Address (CAN-SPAM Compliance) *
            </label>
            <textarea
              required
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm resize-none"
              placeholder="123 Main St&#10;Suite 100&#10;San Francisco, CA 94105"
              value={formData.mailing_address}
              onChange={(e) =>
                setFormData({ ...formData, mailing_address: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-gray-500">
              Required by CAN-SPAM law. This will be included in all emails via {'{{mailing_address}}'} merge tag.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Client'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function EditClientModal({
  client,
  onClose,
  onSuccess,
}: {
  client: Client
  onClose: () => void
  onSuccess: () => void
}) {
  const [formData, setFormData] = useState({
    name: client.name,
    sendgrid_api_key: client.sendgrid_api_key,
    ip_pools: client.ip_pools?.join(', ') || '',
    mailing_address: client.mailing_address || '',
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const ip_pools = formData.ip_pools
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)

      const { error} = await supabase
        .from('clients')
        .update({
          name: formData.name,
          sendgrid_api_key: formData.sendgrid_api_key,
          ip_pools: ip_pools.length > 0 ? ip_pools : null,
          mailing_address: formData.mailing_address || null,
        })
        .eq('id', client.id)

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error updating client:', error)
      alert('Failed to update client')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Edit Client</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Client Name *"
            required
            placeholder="My Company"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />
          <Input
            label="SendGrid API Key *"
            required
            type="password"
            placeholder="SG.xxx..."
            value={formData.sendgrid_api_key}
            onChange={(e) =>
              setFormData({ ...formData, sendgrid_api_key: e.target.value })
            }
          />
          <Input
            label="IP Pools (comma-separated, optional)"
            placeholder="pool1, pool2"
            value={formData.ip_pools}
            onChange={(e) =>
              setFormData({ ...formData, ip_pools: e.target.value })
            }
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Mailing Address (CAN-SPAM Compliance) *
            </label>
            <textarea
              required
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm resize-none"
              placeholder="123 Main St&#10;Suite 100&#10;San Francisco, CA 94105"
              value={formData.mailing_address}
              onChange={(e) =>
                setFormData({ ...formData, mailing_address: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-gray-500">
              Required by CAN-SPAM law. This will be included in all emails via {'{{mailing_address}}'} merge tag.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Updating...' : 'Update Client'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
