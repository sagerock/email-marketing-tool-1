import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Client, VerifiedSender, IndustryLink } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
// Settings page - includes client management, Salesforce integration, and UTM tracking
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import { Plus, Settings as SettingsIcon, X, Trash2, Cloud, CloudOff, RefreshCw, ExternalLink, CheckCircle, XCircle, Loader2, Link2, Edit2, Users, TrendingUp } from 'lucide-react'

const API_URL = import.meta.env.VITE_API_URL || ''

interface SalesforceStatus {
  connected: boolean
  instanceUrl?: string
  connectedAt?: string
  lastSync?: string
  syncStatus?: 'idle' | 'syncing' | 'success' | 'error'
  syncMessage?: string
  syncCount?: number
  campaignSyncStatus?: 'idle' | 'syncing' | 'success' | 'error'
  campaignSyncMessage?: string
  lastCampaignSync?: string
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
  const [syncingCampaigns, setSyncingCampaigns] = useState(false)
  const [showSfConnect, setShowSfConnect] = useState(false)
  const [sfConnecting, setSfConnecting] = useState(false)
  const [sfCredentials, setSfCredentials] = useState({
    instanceUrl: '',
    clientId: '',
    clientSecret: '',
  })

  // Industry Links state
  const [industryLinks, setIndustryLinks] = useState<IndustryLink[]>([])
  const [showAddIndustryLink, setShowAddIndustryLink] = useState(false)
  const [editingIndustryLink, setEditingIndustryLink] = useState<IndustryLink | null>(null)
  const [newIndustryLink, setNewIndustryLink] = useState({ industry: '', link_url: '' })
  const [savingIndustryLink, setSavingIndustryLink] = useState(false)

  // Engagement backfill state
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState<{ updated: number; total: number } | null>(null)

  // Bounce type sync state
  const [syncingBounceTypes, setSyncingBounceTypes] = useState(false)
  const [bounceTypeSyncResult, setBounceTypeSyncResult] = useState<{ hard: number; soft: number } | null>(null)

  // Fetch Salesforce status and industry links when selected client changes
  useEffect(() => {
    if (selectedClient) {
      fetchSalesforceStatus()
      fetchIndustryLinks()
    }
  }, [selectedClient])

  // Industry Links functions
  const fetchIndustryLinks = async () => {
    if (!selectedClient) return
    try {
      const { data, error } = await supabase
        .from('industry_links')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('industry', { ascending: true })

      if (error) throw error
      setIndustryLinks(data || [])
    } catch (error) {
      console.error('Error fetching industry links:', error)
    }
  }

  const saveIndustryLink = async () => {
    if (!selectedClient) return
    if (!newIndustryLink.industry.trim() || !newIndustryLink.link_url.trim()) {
      alert('Please fill in both Industry and URL')
      return
    }

    setSavingIndustryLink(true)
    try {
      if (editingIndustryLink) {
        const { error } = await supabase
          .from('industry_links')
          .update({
            industry: newIndustryLink.industry.trim(),
            link_url: newIndustryLink.link_url.trim(),
          })
          .eq('id', editingIndustryLink.id)

        if (error) throw error
      } else {
        const { error } = await supabase
          .from('industry_links')
          .insert({
            industry: newIndustryLink.industry.trim(),
            link_url: newIndustryLink.link_url.trim(),
            client_id: selectedClient.id,
          })

        if (error) {
          if (error.message.includes('duplicate') || error.message.includes('unique')) {
            alert('An entry for this industry already exists')
            return
          }
          throw error
        }
      }

      setNewIndustryLink({ industry: '', link_url: '' })
      setShowAddIndustryLink(false)
      setEditingIndustryLink(null)
      fetchIndustryLinks()
    } catch (error) {
      console.error('Error saving industry link:', error)
      alert('Failed to save industry link')
    } finally {
      setSavingIndustryLink(false)
    }
  }

  const deleteIndustryLink = async (id: string) => {
    if (!confirm('Are you sure you want to delete this industry link?')) return

    try {
      const { error } = await supabase
        .from('industry_links')
        .delete()
        .eq('id', id)

      if (error) throw error
      fetchIndustryLinks()
    } catch (error) {
      console.error('Error deleting industry link:', error)
      alert('Failed to delete industry link')
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

  const syncSalesforceCampaigns = async () => {
    if (!selectedClient) return
    setSyncingCampaigns(true)
    try {
      const response = await fetch(`${API_URL}/api/salesforce/sync-campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClient.id }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Campaign sync failed')
      }
      // Poll status until no longer syncing
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`${API_URL}/api/salesforce/status?clientId=${selectedClient.id}`)
          const statusData = await statusRes.json()
          setSfStatus(statusData)
          if (statusData.campaignSyncStatus !== 'syncing') {
            clearInterval(pollInterval)
            setSyncingCampaigns(false)
          }
        } catch {
          clearInterval(pollInterval)
          setSyncingCampaigns(false)
        }
      }, 3000)
    } catch (error) {
      console.error('Error syncing Salesforce campaigns:', error)
      setSyncingCampaigns(false)
      fetchSalesforceStatus()
    }
  }

  const backfillEngagement = async () => {
    if (!selectedClient) return
    if (!confirm('This will recalculate engagement scores for all contacts based on historical analytics data. This may take a few minutes for large contact lists. Continue?')) return

    setBackfilling(true)
    setBackfillResult(null)
    try {
      const response = await fetch(`${API_URL}/api/contacts/backfill-engagement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClient.id }),
      })
      const data = await response.json()
      if (response.ok) {
        setBackfillResult({ updated: data.updated, total: data.total })
        alert(data.message)
      } else {
        throw new Error(data.error || 'Backfill failed')
      }
    } catch (error) {
      console.error('Error backfilling engagement:', error)
      alert('Backfill failed: ' + (error instanceof Error ? error.message : 'Unknown error'))
    } finally {
      setBackfilling(false)
    }
  }

  const syncBounceTypes = async () => {
    if (!selectedClient) return
    if (!confirm('This will sync bounce types from SendGrid to accurately classify hard vs soft bounces. Continue?')) return

    setSyncingBounceTypes(true)
    setBounceTypeSyncResult(null)
    try {
      const response = await fetch(`${API_URL}/api/contacts/sync-bounce-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClient.id }),
      })
      const data = await response.json()
      if (response.ok) {
        setBounceTypeSyncResult({ hard: data.hardBounces, soft: data.softBounces })
        alert(data.message)
      } else {
        throw new Error(data.error || 'Sync failed')
      }
    } catch (error) {
      console.error('Error syncing bounce types:', error)
      alert('Sync failed: ' + (error instanceof Error ? error.message : 'Unknown error'))
    } finally {
      setSyncingBounceTypes(false)
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
                      <span className="text-gray-500">Last Contact Sync: </span>
                      <span>{new Date(sfStatus.lastSync).toLocaleString()}</span>
                    </div>
                  )}
                  {sfStatus.syncCount !== undefined && sfStatus.syncCount !== null && (
                    <div>
                      <span className="text-gray-500">Last Sync Count: </span>
                      <span>{sfStatus.syncCount} records</span>
                    </div>
                  )}
                  {sfStatus.lastCampaignSync && (
                    <div>
                      <span className="text-gray-500">Last Campaign Sync: </span>
                      <span>{new Date(sfStatus.lastCampaignSync).toLocaleString()}</span>
                    </div>
                  )}
                </div>

                {/* Contact Sync Status */}
                {sfStatus.syncStatus && sfStatus.syncStatus !== 'idle' && (
                  <div className={`flex items-center gap-2 text-sm p-2 rounded ${
                    sfStatus.syncStatus === 'syncing' ? 'bg-blue-50 text-blue-700' :
                    sfStatus.syncStatus === 'success' ? 'bg-green-50 text-green-700' :
                    'bg-red-50 text-red-700'
                  }`}>
                    {sfStatus.syncStatus === 'syncing' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {sfStatus.syncStatus === 'success' && <CheckCircle className="h-4 w-4" />}
                    {sfStatus.syncStatus === 'error' && <XCircle className="h-4 w-4" />}
                    <span>Contacts: {sfStatus.syncMessage}</span>
                  </div>
                )}

                {/* Campaign Sync Status */}
                {sfStatus.campaignSyncStatus && sfStatus.campaignSyncStatus !== 'idle' && (
                  <div className={`flex items-center gap-2 text-sm p-2 rounded ${
                    sfStatus.campaignSyncStatus === 'syncing' ? 'bg-blue-50 text-blue-700' :
                    sfStatus.campaignSyncStatus === 'success' ? 'bg-green-50 text-green-700' :
                    'bg-red-50 text-red-700'
                  }`}>
                    {sfStatus.campaignSyncStatus === 'syncing' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {sfStatus.campaignSyncStatus === 'success' && <CheckCircle className="h-4 w-4" />}
                    {sfStatus.campaignSyncStatus === 'error' && <XCircle className="h-4 w-4" />}
                    <span>Campaigns: {sfStatus.campaignSyncMessage}</span>
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
                        Sync Contacts
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
                    onClick={syncSalesforceCampaigns}
                    disabled={syncingCampaigns}
                  >
                    {syncingCampaigns ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Syncing...
                      </>
                    ) : (
                      <>
                        <Users className="h-4 w-4 mr-2" />
                        Sync Campaigns
                      </>
                    )}
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

      {/* Industry Links Card */}
      {selectedClient && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Industry Links
              <span className="text-sm font-normal text-gray-500">
                ({selectedClient.name})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Map industry names to URLs for dynamic email content. When sending emails, the
              <code className="mx-1 px-1 bg-gray-100 rounded text-xs">{'{{industry_link}}'}</code>
              merge tag will be replaced with the URL for the contact's industry.
            </p>

            {/* Industry Links Table */}
            {industryLinks.length > 0 ? (
              <div className="border rounded-lg overflow-hidden mb-4">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">Industry</th>
                      <th className="text-left px-4 py-3 text-sm font-medium text-gray-700">URL</th>
                      <th className="text-right px-4 py-3 text-sm font-medium text-gray-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {industryLinks.map((link) => (
                      <tr key={link.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">{link.industry}</td>
                        <td className="px-4 py-3 text-sm">
                          <a
                            href={link.link_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline inline-flex items-center gap-1"
                          >
                            {link.link_url.length > 50 ? link.link_url.substring(0, 50) + '...' : link.link_url}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                        <td className="px-4 py-3 text-sm text-right">
                          <button
                            onClick={() => {
                              setEditingIndustryLink(link)
                              setNewIndustryLink({ industry: link.industry, link_url: link.link_url })
                              setShowAddIndustryLink(true)
                            }}
                            className="text-gray-600 hover:text-gray-900 mr-2"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => deleteIndustryLink(link.id)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500 border rounded-lg mb-4">
                <Link2 className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                <p>No industry links configured yet.</p>
                <p className="text-sm">Add links to enable dynamic industry URLs in emails.</p>
              </div>
            )}

            {/* Add/Edit Form */}
            {showAddIndustryLink ? (
              <div className="p-4 border rounded-lg bg-gray-50">
                <h4 className="font-medium mb-3">
                  {editingIndustryLink ? 'Edit Industry Link' : 'Add Industry Link'}
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="Industry Name"
                    placeholder="e.g., Pharmaceutical"
                    value={newIndustryLink.industry}
                    onChange={(e) => setNewIndustryLink({ ...newIndustryLink, industry: e.target.value })}
                  />
                  <Input
                    label="URL"
                    placeholder="https://example.com/industries/pharma"
                    value={newIndustryLink.link_url}
                    onChange={(e) => setNewIndustryLink({ ...newIndustryLink, link_url: e.target.value })}
                  />
                </div>
                <div className="flex gap-2 mt-4">
                  <Button onClick={saveIndustryLink} disabled={savingIndustryLink}>
                    {savingIndustryLink ? 'Saving...' : editingIndustryLink ? 'Update' : 'Add'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowAddIndustryLink(false)
                      setEditingIndustryLink(null)
                      setNewIndustryLink({ industry: '', link_url: '' })
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={() => setShowAddIndustryLink(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Industry Link
              </Button>
            )}

            <p className="text-xs text-gray-500 mt-4">
              Tip: If a contact's industry doesn't match any entry, the default fallback URL is
              <code className="mx-1 px-1 bg-gray-100 rounded">https://alconox.com/industries/</code>
            </p>
          </CardContent>
        </Card>
      )}

      {/* Engagement Data Card */}
      {selectedClient && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Engagement Data
              <span className="text-sm font-normal text-gray-500">
                ({selectedClient.name})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Recalculate engagement scores for all contacts based on historical analytics data.
              This updates opens, clicks, engagement scores, and bounce status from existing events.
            </p>

            <div className="flex flex-wrap items-center gap-4">
              <Button
                onClick={backfillEngagement}
                disabled={backfilling}
              >
                {backfilling ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Recalculating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Recalculate Engagement
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={syncBounceTypes}
                disabled={syncingBounceTypes}
              >
                {syncingBounceTypes ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Sync Bounce Types
                  </>
                )}
              </Button>

              {backfillResult && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle className="h-4 w-4" />
                  <span>Updated {backfillResult.updated} of {backfillResult.total} contacts</span>
                </div>
              )}

              {bounceTypeSyncResult && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle className="h-4 w-4" />
                  <span>{bounceTypeSyncResult.hard} hard, {bounceTypeSyncResult.soft} soft bounces synced</span>
                </div>
              )}
            </div>

            <p className="text-xs text-gray-500 mt-4">
              Note: This is only needed for historical data. New engagement is tracked automatically via webhooks.
              "Sync Bounce Types" fetches accurate hard/soft classification from SendGrid's suppression lists.
            </p>
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
    default_reply_to_email: '',
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
        default_reply_to_email: formData.default_reply_to_email || null,
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

          <Input
            label="Default Reply-To Email (optional)"
            type="email"
            placeholder="replies@example.com"
            value={formData.default_reply_to_email}
            onChange={(e) =>
              setFormData({ ...formData, default_reply_to_email: e.target.value })
            }
          />
          <p className="-mt-3 text-xs text-gray-500">
            This email will be pre-filled as the reply-to address for new campaigns. Can be changed per campaign.
          </p>

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
    default_reply_to_email: client.default_reply_to_email || '',
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
          default_reply_to_email: formData.default_reply_to_email || null,
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

          <Input
            label="Default Reply-To Email (optional)"
            type="email"
            placeholder="replies@example.com"
            value={formData.default_reply_to_email}
            onChange={(e) =>
              setFormData({ ...formData, default_reply_to_email: e.target.value })
            }
          />
          <p className="-mt-3 text-xs text-gray-500">
            This email will be pre-filled as the reply-to address for new campaigns. Can be changed per campaign.
          </p>

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
