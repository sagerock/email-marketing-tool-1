import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Client, VerifiedSender } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
// Settings page - includes client management, Salesforce integration, and UTM tracking
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import { Plus, Settings as SettingsIcon, X, Trash2, Cloud, CloudOff, RefreshCw, ExternalLink, CheckCircle, XCircle, Loader2 } from 'lucide-react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface SalesforceStatus {
  connected: boolean
  instanceUrl?: string
  connectedAt?: string
  lastSync?: string
  syncStatus?: 'idle' | 'syncing' | 'success' | 'error'
  syncMessage?: string
  syncCount?: number
}

interface SalesforceField {
  name: string
  label: string
  type: string
  custom: boolean
}

export default function Settings() {
  const { refreshClients, selectedClient } = useClient()
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)

  // Salesforce integration state
  const [sfStatus, setSfStatus] = useState<SalesforceStatus | null>(null)
  const [sfLoading, setSfLoading] = useState(false)
  const [sfFields, setSfFields] = useState<{ Lead: SalesforceField[], Contact: SalesforceField[] } | null>(null)
  const [showFields, setShowFields] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [showSfConnect, setShowSfConnect] = useState(false)
  const [sfConnecting, setSfConnecting] = useState(false)
  const [sfCredentials, setSfCredentials] = useState({
    instanceUrl: '',
    clientId: '',
    clientSecret: '',
  })

  // Fetch Salesforce status when selected client changes
  useEffect(() => {
    if (selectedClient) {
      fetchSalesforceStatus()
    }
  }, [selectedClient])

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
      refreshClients()
    } catch (error) {
      console.error('Error deleting client:', error)
      alert('Failed to delete client')
    }
  }

  // Salesforce functions
  const fetchSalesforceStatus = async () => {
    if (!selectedClient) return
    setSfLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/salesforce/status?clientId=${selectedClient.id}`)
      const data = await response.json()
      setSfStatus(data)
    } catch (error) {
      console.error('Error fetching Salesforce status:', error)
      setSfStatus(null)
    } finally {
      setSfLoading(false)
    }
  }

  const connectSalesforce = async () => {
    if (!selectedClient) return
    if (!sfCredentials.instanceUrl || !sfCredentials.clientId || !sfCredentials.clientSecret) {
      alert('Please fill in all fields')
      return
    }

    setSfConnecting(true)
    try {
      const response = await fetch(`${API_URL}/api/salesforce/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient.id,
          instanceUrl: sfCredentials.instanceUrl,
          salesforceClientId: sfCredentials.clientId,
          salesforceClientSecret: sfCredentials.clientSecret,
        }),
      })
      const data = await response.json()
      if (response.ok) {
        alert('Salesforce connected successfully!')
        setShowSfConnect(false)
        setSfCredentials({ instanceUrl: '', clientId: '', clientSecret: '' })
        fetchSalesforceStatus()
      } else {
        alert('Failed to connect: ' + (data.error || 'Unknown error'))
      }
    } catch (error) {
      console.error('Error connecting to Salesforce:', error)
      alert('Failed to connect to Salesforce')
    } finally {
      setSfConnecting(false)
    }
  }

  const disconnectSalesforce = async () => {
    if (!selectedClient) return
    if (!confirm('Are you sure you want to disconnect Salesforce? This will not delete any synced contacts.')) return

    try {
      const response = await fetch(`${API_URL}/api/salesforce/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClient.id }),
      })
      if (response.ok) {
        setSfStatus({ connected: false })
        setSfFields(null)
      } else {
        throw new Error('Failed to disconnect')
      }
    } catch (error) {
      console.error('Error disconnecting Salesforce:', error)
      alert('Failed to disconnect Salesforce')
    }
  }

  const syncSalesforce = async (fullSync = false) => {
    if (!selectedClient) return
    setSyncing(true)
    try {
      const response = await fetch(`${API_URL}/api/salesforce/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClient.id, fullSync }),
      })
      const data = await response.json()
      if (response.ok) {
        alert(data.message)
        fetchSalesforceStatus()
      } else {
        throw new Error(data.error || 'Sync failed')
      }
    } catch (error) {
      console.error('Error syncing Salesforce:', error)
      alert('Sync failed: ' + (error instanceof Error ? error.message : 'Unknown error'))
      fetchSalesforceStatus()
    } finally {
      setSyncing(false)
    }
  }

  const fetchSalesforceFields = async () => {
    if (!selectedClient) return
    try {
      const response = await fetch(`${API_URL}/api/salesforce/fields?clientId=${selectedClient.id}`)
      const data = await response.json()
      setSfFields(data)
      setShowFields(true)
    } catch (error) {
      console.error('Error fetching Salesforce fields:', error)
      alert('Failed to fetch Salesforce fields')
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-600">
            {selectedClient ? `Configuration for ${selectedClient.name}` : 'Select a client to view settings'}
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Client
        </Button>
      </div>

      {/* Client Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Client Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          {!selectedClient ? (
            <div className="text-center py-12 text-gray-500">
              <SettingsIcon className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>Select a client from the sidebar to view settings.</p>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900">{selectedClient.name}</h3>
                  <div className="mt-2 space-y-1 text-sm">
                    <div>
                      <span className="text-gray-500">SendGrid API Key: </span>
                      <span className="font-mono text-gray-900">
                        {selectedClient.sendgrid_api_key.substring(0, 20)}...
                      </span>
                    </div>
                    {selectedClient.ip_pool && (
                      <div>
                        <span className="text-gray-500">IP Pool: </span>
                        <span className="text-gray-900">
                          {selectedClient.ip_pool}
                        </span>
                      </div>
                    )}
                    {selectedClient.mailing_address && (
                      <div>
                        <span className="text-gray-500">Mailing Address: </span>
                        <span className="text-gray-900 whitespace-pre-line">
                          {selectedClient.mailing_address}
                        </span>
                      </div>
                    )}
                    {selectedClient.verified_senders && selectedClient.verified_senders.length > 0 && (
                      <div>
                        <span className="text-gray-500">Verified Senders: </span>
                        <span className="text-gray-900">
                          {selectedClient.verified_senders.map(s => s.email).join(', ')}
                        </span>
                      </div>
                    )}
                    <div className="text-xs text-gray-400">
                      Added {new Date(selectedClient.created_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingClient(selectedClient)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(selectedClient.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Salesforce Integration Card */}
      {selectedClient && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cloud className="h-5 w-5" />
              Salesforce Integration
              <span className="text-sm font-normal text-gray-500">
                ({selectedClient.name})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sfLoading ? (
              <div className="flex items-center gap-2 text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading Salesforce status...
              </div>
            ) : sfStatus?.connected ? (
              <div className="space-y-4">
                {/* Connection Status */}
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-medium">Connected to Salesforce</span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Instance: </span>
                    <a
                      href={sfStatus.instanceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline inline-flex items-center gap-1"
                    >
                      {sfStatus.instanceUrl?.replace('https://', '')}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div>
                    <span className="text-gray-500">Connected: </span>
                    <span>{sfStatus.connectedAt ? new Date(sfStatus.connectedAt).toLocaleDateString() : 'Unknown'}</span>
                  </div>
                  {sfStatus.lastSync && (
                    <div>
                      <span className="text-gray-500">Last Sync: </span>
                      <span>{new Date(sfStatus.lastSync).toLocaleString()}</span>
                    </div>
                  )}
                  {sfStatus.syncCount !== undefined && sfStatus.syncCount !== null && (
                    <div>
                      <span className="text-gray-500">Last Sync Count: </span>
                      <span>{sfStatus.syncCount} records</span>
                    </div>
                  )}
                </div>

                {/* Sync Status */}
                {sfStatus.syncStatus && sfStatus.syncStatus !== 'idle' && (
                  <div className={`flex items-center gap-2 text-sm p-2 rounded ${
                    sfStatus.syncStatus === 'syncing' ? 'bg-blue-50 text-blue-700' :
                    sfStatus.syncStatus === 'success' ? 'bg-green-50 text-green-700' :
                    'bg-red-50 text-red-700'
                  }`}>
                    {sfStatus.syncStatus === 'syncing' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {sfStatus.syncStatus === 'success' && <CheckCircle className="h-4 w-4" />}
                    {sfStatus.syncStatus === 'error' && <XCircle className="h-4 w-4" />}
                    <span>{sfStatus.syncMessage}</span>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button
                    onClick={() => syncSalesforce(false)}
                    disabled={syncing}
                  >
                    {syncing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Syncing...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Sync Now
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => syncSalesforce(true)}
                    disabled={syncing}
                  >
                    Full Sync
                  </Button>
                  <Button
                    variant="outline"
                    onClick={fetchSalesforceFields}
                  >
                    View Fields
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={disconnectSalesforce}
                  >
                    <CloudOff className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                </div>

                {/* Field Browser */}
                {showFields && sfFields && (
                  <div className="mt-4 border rounded-lg p-4 bg-gray-50">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-medium">Salesforce Fields</h4>
                      <button
                        onClick={() => setShowFields(false)}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                      {['Lead', 'Contact'].map((objectName) => (
                        <div key={objectName}>
                          <h5 className="font-medium text-sm text-gray-700 mb-2">{objectName} Fields</h5>
                          <div className="max-h-64 overflow-y-auto bg-white rounded border">
                            <table className="w-full text-xs">
                              <thead className="bg-gray-100 sticky top-0">
                                <tr>
                                  <th className="text-left p-2">Label</th>
                                  <th className="text-left p-2">API Name</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(sfFields as Record<string, SalesforceField[]>)[objectName]?.map((field) => (
                                  <tr key={field.name} className="border-t hover:bg-gray-50">
                                    <td className="p-2">{field.label}</td>
                                    <td className="p-2 font-mono text-gray-600">
                                      {field.name}
                                      {field.custom && <span className="ml-1 text-blue-500">*</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      * indicates custom fields. Use the API Name when configuring field mappings.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-gray-500">
                  <CloudOff className="h-5 w-5" />
                  <span>Salesforce is not connected</span>
                </div>
                <p className="text-sm text-gray-600">
                  Connect to Salesforce to sync contacts and leads automatically.
                  You'll need your Salesforce instance URL and Connected App credentials.
                </p>

                {!showSfConnect ? (
                  <Button onClick={() => setShowSfConnect(true)}>
                    <Cloud className="h-4 w-4 mr-2" />
                    Connect Salesforce
                  </Button>
                ) : (
                  <div className="space-y-3 p-4 border rounded-lg bg-gray-50">
                    <h4 className="font-medium">Enter Salesforce Credentials</h4>
                    <Input
                      label="Salesforce Instance URL"
                      placeholder="https://yourcompany.my.salesforce.com"
                      value={sfCredentials.instanceUrl}
                      onChange={(e) => setSfCredentials({ ...sfCredentials, instanceUrl: e.target.value })}
                    />
                    <Input
                      label="Client ID (Consumer Key)"
                      placeholder="3MVG9..."
                      value={sfCredentials.clientId}
                      onChange={(e) => setSfCredentials({ ...sfCredentials, clientId: e.target.value })}
                    />
                    <Input
                      label="Client Secret (Consumer Secret)"
                      type="password"
                      placeholder="Your client secret"
                      value={sfCredentials.clientSecret}
                      onChange={(e) => setSfCredentials({ ...sfCredentials, clientSecret: e.target.value })}
                    />
                    <p className="text-xs text-gray-500">
                      Get these from your Salesforce Connected App (Setup → App Manager → Your App → View)
                    </p>
                    <div className="flex gap-2">
                      <Button onClick={connectSalesforce} disabled={sfConnecting}>
                        {sfConnecting ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          'Connect'
                        )}
                      </Button>
                      <Button variant="outline" onClick={() => setShowSfConnect(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Add Client Modal */}
      {showAddModal && (
        <AddClientModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
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
    ip_pool: '',
    mailing_address: '',
    default_utm_params: '',
  })
  const [verifiedSenders, setVerifiedSenders] = useState<VerifiedSender[]>([])
  const [newSender, setNewSender] = useState({ email: '', name: '' })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error } = await supabase.from('clients').insert({
        name: formData.name,
        sendgrid_api_key: formData.sendgrid_api_key,
        ip_pool: formData.ip_pool.trim() || null,
        mailing_address: formData.mailing_address || null,
        default_utm_params: formData.default_utm_params || null,
        verified_senders: verifiedSenders.length > 0 ? verifiedSenders : [],
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
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
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
            label="IP Pool (optional)"
            placeholder="my-ip-pool"
            value={formData.ip_pool}
            onChange={(e) =>
              setFormData({ ...formData, ip_pool: e.target.value })
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default UTM Parameters (optional)
            </label>
            <input
              type="text"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="utm_source=newsletter&utm_medium=email"
              value={formData.default_utm_params}
              onChange={(e) =>
                setFormData({ ...formData, default_utm_params: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-gray-500">
              These UTM parameters will be automatically appended to all links in your emails. Can be customized per campaign.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Verified Sender Emails *
            </label>
            <p className="text-xs text-gray-500 mb-3">
              Add sender emails that are verified in SendGrid. You must verify these in SendGrid before using them.
            </p>

            {/* List of current senders */}
            {verifiedSenders.length > 0 && (
              <div className="space-y-2 mb-3">
                {verifiedSenders.map((sender, index) => (
                  <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 rounded border border-gray-200">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{sender.name}</p>
                      <p className="text-xs text-gray-600">{sender.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setVerifiedSenders(verifiedSenders.filter((_, i) => i !== index))}
                      className="text-red-600 hover:text-red-800"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new sender form */}
            <div className="space-y-2 p-3 bg-blue-50 border border-blue-200 rounded">
              <Input
                label="Sender Email"
                type="email"
                placeholder="hello@example.com"
                value={newSender.email}
                onChange={(e) => setNewSender({ ...newSender, email: e.target.value })}
              />
              <Input
                label="Sender Name"
                placeholder="Marketing Team"
                value={newSender.name}
                onChange={(e) => setNewSender({ ...newSender, name: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (newSender.email && newSender.name) {
                    setVerifiedSenders([...verifiedSenders, newSender])
                    setNewSender({ email: '', name: '' })
                  } else {
                    alert('Please enter both email and name')
                  }
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Sender
              </Button>
            </div>

            {verifiedSenders.length === 0 && (
              <p className="mt-2 text-xs text-amber-600">
                You must add at least one verified sender to send campaigns.
              </p>
            )}
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
    ip_pool: client.ip_pool || '',
    mailing_address: client.mailing_address || '',
    default_utm_params: client.default_utm_params || '',
  })
  const [verifiedSenders, setVerifiedSenders] = useState<VerifiedSender[]>(
    client.verified_senders || []
  )
  const [newSender, setNewSender] = useState({ email: '', name: '' })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error} = await supabase
        .from('clients')
        .update({
          name: formData.name,
          sendgrid_api_key: formData.sendgrid_api_key,
          ip_pool: formData.ip_pool.trim() || null,
          mailing_address: formData.mailing_address || null,
          default_utm_params: formData.default_utm_params || null,
          verified_senders: verifiedSenders.length > 0 ? verifiedSenders : [],
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
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
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
            label="IP Pool (optional)"
            placeholder="my-ip-pool"
            value={formData.ip_pool}
            onChange={(e) =>
              setFormData({ ...formData, ip_pool: e.target.value })
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default UTM Parameters (optional)
            </label>
            <input
              type="text"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="utm_source=newsletter&utm_medium=email"
              value={formData.default_utm_params}
              onChange={(e) =>
                setFormData({ ...formData, default_utm_params: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-gray-500">
              These UTM parameters will be automatically appended to all links in your emails. Can be customized per campaign.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Verified Sender Emails *
            </label>
            <p className="text-xs text-gray-500 mb-3">
              Add sender emails that are verified in SendGrid. You must verify these in SendGrid before using them.
            </p>

            {/* List of current senders */}
            {verifiedSenders.length > 0 && (
              <div className="space-y-2 mb-3">
                {verifiedSenders.map((sender, index) => (
                  <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 rounded border border-gray-200">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{sender.name}</p>
                      <p className="text-xs text-gray-600">{sender.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setVerifiedSenders(verifiedSenders.filter((_, i) => i !== index))}
                      className="text-red-600 hover:text-red-800"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new sender form */}
            <div className="space-y-2 p-3 bg-blue-50 border border-blue-200 rounded">
              <Input
                label="Sender Email"
                type="email"
                placeholder="hello@example.com"
                value={newSender.email}
                onChange={(e) => setNewSender({ ...newSender, email: e.target.value })}
              />
              <Input
                label="Sender Name"
                placeholder="Marketing Team"
                value={newSender.name}
                onChange={(e) => setNewSender({ ...newSender, name: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (newSender.email && newSender.name) {
                    setVerifiedSenders([...verifiedSenders, newSender])
                    setNewSender({ email: '', name: '' })
                  } else {
                    alert('Please enter both email and name')
                  }
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Sender
              </Button>
            </div>

            {verifiedSenders.length === 0 && (
              <p className="mt-2 text-xs text-amber-600">
                You must add at least one verified sender to send campaigns.
              </p>
            )}
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
