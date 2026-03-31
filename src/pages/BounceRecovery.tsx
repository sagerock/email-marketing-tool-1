import { useState, useEffect } from 'react'
import { useClient } from '../context/ClientContext'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { AlertTriangle, CheckCircle, Mail, RefreshCw, Search, Shield } from 'lucide-react'

import { apiFetch } from '../lib/api'

interface DomainSummary {
  domain: string
  count: number
}

interface BouncedContact {
  id: string
  email: string
  first_name?: string
  last_name?: string
  bounce_status: string
  bounced_at?: string
  tags?: string[]
}

interface Template {
  id: string
  name: string
  subject: string
}

export default function BounceRecovery() {
  const { selectedClient } = useClient()

  // Summary state
  const [totalBounces, setTotalBounces] = useState(0)
  const [domains, setDomains] = useState<DomainSummary[]>([])
  const [loadingSummary, setLoadingSummary] = useState(false)

  // Contacts state
  const [contacts, setContacts] = useState<BouncedContact[]>([])
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null)
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Recovery state
  const [recovering, setRecovering] = useState(false)
  const [recoveryResult, setRecoveryResult] = useState<string | null>(null)

  // Send state
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [batchSize, setBatchSize] = useState(100)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<string | null>(null)
  const [showSendPanel, setShowSendPanel] = useState(false)

  // Recently recovered contacts (for sending)
  const [recoveredIds, setRecoveredIds] = useState<string[]>([])

  useEffect(() => {
    if (selectedClient) {
      fetchSummary()
      fetchTemplates()
    }
  }, [selectedClient])

  const fetchSummary = async () => {
    if (!selectedClient) return
    setLoadingSummary(true)
    try {
      const res = await apiFetch(`/api/bounces/summary?clientId=${selectedClient.id}`)
      const data = await res.json()
      if (res.ok) {
        setTotalBounces(data.totalHardBounces)
        setDomains(data.domains)
      }
    } catch (err) {
      console.error('Error fetching bounce summary:', err)
    } finally {
      setLoadingSummary(false)
    }
  }

  const fetchContacts = async (domain?: string) => {
    if (!selectedClient) return
    setLoadingContacts(true)
    setSelectedIds(new Set())
    try {
      const params = new URLSearchParams({
        clientId: selectedClient.id,
        pageSize: '200',
      })
      if (domain) params.set('domain', domain)

      const res = await apiFetch(`/api/bounces/contacts?${params}`)
      const data = await res.json()
      if (res.ok) {
        setContacts(data.contacts)
      }
    } catch (err) {
      console.error('Error fetching bounced contacts:', err)
    } finally {
      setLoadingContacts(false)
    }
  }

  const fetchTemplates = async () => {
    if (!selectedClient) return
    try {
      const { supabase } = await import('../lib/supabase')
      const { data } = await supabase
        .from('templates')
        .select('id, name, subject')
        .eq('client_id', selectedClient.id)
        .order('name')
      setTemplates(data || [])
    } catch (err) {
      console.error('Error fetching templates:', err)
    }
  }

  const handleDomainClick = (domain: string) => {
    setSelectedDomain(domain)
    fetchContacts(domain)
    setRecoveryResult(null)
    setSendResult(null)
    setShowSendPanel(false)
  }

  const handleViewAll = () => {
    setSelectedDomain(null)
    fetchContacts()
    setRecoveryResult(null)
    setSendResult(null)
    setShowSendPanel(false)
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredContacts.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredContacts.map(c => c.id)))
    }
  }

  const handleRecover = async () => {
    if (selectedIds.size === 0) return

    const count = selectedIds.size
    if (!confirm(`Recover ${count} contact${count !== 1 ? 's' : ''}?\n\nThis will:\n1. Remove them from SendGrid's suppression list\n2. Reset their bounce status to "none"\n\nThey will be eligible to receive emails again.`)) {
      return
    }

    setRecovering(true)
    setRecoveryResult(null)
    try {
      const res = await apiFetch(`/api/bounces/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient!.id,
          contactIds: Array.from(selectedIds),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setRecoveryResult(`${data.recovered} contact${data.recovered !== 1 ? 's' : ''} recovered. ${data.suppressionRemoved} removed from SendGrid suppression.`)
        setRecoveredIds(Array.from(selectedIds))
        // Refresh data
        setSelectedIds(new Set())
        fetchSummary()
        if (selectedDomain) {
          fetchContacts(selectedDomain)
        } else {
          fetchContacts()
        }
      } else {
        setRecoveryResult(`Error: ${data.error}`)
      }
    } catch (err) {
      setRecoveryResult(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setRecovering(false)
    }
  }

  const handleSendRecovery = async () => {
    if (recoveredIds.length === 0 || !selectedTemplateId || !sendSubject) return

    if (!confirm(`Send recovery email to ${recoveredIds.length} recently recovered contact${recoveredIds.length !== 1 ? 's' : ''}?\n\nBatch size: ${batchSize}`)) {
      return
    }

    setSending(true)
    setSendResult(null)
    try {
      const res = await apiFetch(`/api/bounces/send-recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient!.id,
          contactIds: recoveredIds,
          templateId: selectedTemplateId,
          subject: sendSubject,
          batchSize,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setSendResult(`${data.sent} email${data.sent !== 1 ? 's' : ''} sent successfully. ${data.failed} failed.`)
        setRecoveredIds([])
        setShowSendPanel(false)
      } else {
        setSendResult(`Error: ${data.error}`)
      }
    } catch (err) {
      setSendResult(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setSending(false)
    }
  }

  const filteredContacts = searchFilter
    ? contacts.filter(c =>
        c.email.toLowerCase().includes(searchFilter.toLowerCase()) ||
        (c.first_name && c.first_name.toLowerCase().includes(searchFilter.toLowerCase())) ||
        (c.last_name && c.last_name.toLowerCase().includes(searchFilter.toLowerCase()))
      )
    : contacts

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Bounce Recovery</h1>
          <p className="text-gray-500 mt-1">
            View hard bounces by domain, remove from SendGrid suppression, and re-send in controlled batches
          </p>
        </div>
        <Button onClick={fetchSummary} variant="outline" disabled={loadingSummary}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loadingSummary ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Domain Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            Hard Bounces by Domain
          </CardTitle>
          <p className="text-sm text-gray-500">
            {totalBounces} total hard-bounced contacts across {domains.length} domains
          </p>
        </CardHeader>
        <CardContent>
          {loadingSummary ? (
            <p className="text-gray-500">Loading...</p>
          ) : domains.length === 0 ? (
            <p className="text-gray-500">No hard bounces found.</p>
          ) : (
            <div className="space-y-2">
              <button
                onClick={handleViewAll}
                className={`w-full flex items-center justify-between px-4 py-2 rounded-lg border transition-colors ${
                  selectedDomain === null && contacts.length > 0
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <span className="font-medium">All Domains</span>
                <Badge variant="danger">{totalBounces}</Badge>
              </button>
              {domains.map(d => (
                <button
                  key={d.domain}
                  onClick={() => handleDomainClick(d.domain)}
                  className={`w-full flex items-center justify-between px-4 py-2 rounded-lg border transition-colors ${
                    selectedDomain === d.domain
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <span className="font-medium">{d.domain}</span>
                  <Badge variant="danger">{d.count}</Badge>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Contact List */}
      {(contacts.length > 0 || loadingContacts) && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>
                  {selectedDomain ? `Hard Bounces: @${selectedDomain}` : 'All Hard Bounces'}
                </CardTitle>
                <p className="text-sm text-gray-500">{contacts.length} contacts</p>
              </div>
              <div className="flex items-center gap-2">
                {selectedIds.size > 0 && (
                  <Button onClick={handleRecover} disabled={recovering} variant="primary">
                    <Shield className="h-4 w-4 mr-2" />
                    {recovering ? 'Recovering...' : `Recover ${selectedIds.size} Contact${selectedIds.size !== 1 ? 's' : ''}`}
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Search */}
            <div className="mb-4 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Filter contacts..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="pl-10"
              />
            </div>

            {loadingContacts ? (
              <p className="text-gray-500">Loading contacts...</p>
            ) : (
              <>
                {/* Select All */}
                <div className="flex items-center gap-2 mb-3 px-1">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filteredContacts.length && filteredContacts.length > 0}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-600">
                    Select all ({filteredContacts.length})
                  </span>
                </div>

                {/* Contact rows */}
                <div className="max-h-96 overflow-y-auto border rounded-lg divide-y">
                  {filteredContacts.map(contact => (
                    <label
                      key={contact.id}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(contact.id)}
                        onChange={() => toggleSelect(contact.id)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{contact.email}</span>
                          {contact.first_name && (
                            <span className="text-xs text-gray-500">
                              ({contact.first_name} {contact.last_name || ''})
                            </span>
                          )}
                        </div>
                        {contact.bounced_at && (
                          <span className="text-xs text-gray-400">
                            Bounced: {new Date(contact.bounced_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}

            {/* Recovery Result */}
            {recoveryResult && (
              <div className={`mt-4 p-3 rounded-lg text-sm ${
                recoveryResult.startsWith('Error')
                  ? 'bg-red-50 text-red-700'
                  : 'bg-green-50 text-green-700'
              }`}>
                <div className="flex items-center gap-2">
                  {recoveryResult.startsWith('Error')
                    ? <AlertTriangle className="h-4 w-4" />
                    : <CheckCircle className="h-4 w-4" />
                  }
                  {recoveryResult}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Send Recovery Emails */}
      {recoveredIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-blue-500" />
              Send to Recovered Contacts
            </CardTitle>
            <p className="text-sm text-gray-500">
              {recoveredIds.length} recently recovered contact{recoveredIds.length !== 1 ? 's' : ''} ready to receive emails
            </p>
          </CardHeader>
          <CardContent>
            {!showSendPanel ? (
              <Button onClick={() => setShowSendPanel(true)} variant="outline">
                <Mail className="h-4 w-4 mr-2" />
                Send Recovery Email
              </Button>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Template</label>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => {
                      setSelectedTemplateId(e.target.value)
                      const tmpl = templates.find(t => t.id === e.target.value)
                      if (tmpl && !sendSubject) setSendSubject(tmpl.subject)
                    }}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Select a template...</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subject Line</label>
                  <Input
                    value={sendSubject}
                    onChange={(e) => setSendSubject(e.target.value)}
                    placeholder="Enter subject line..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Batch Size (max 200)
                  </label>
                  <Input
                    type="number"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Math.min(200, Math.max(1, parseInt(e.target.value) || 100)))}
                    min={1}
                    max={200}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Contacts will be sent in batches of this size to avoid overwhelming SendGrid
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleSendRecovery}
                    disabled={sending || !selectedTemplateId || !sendSubject}
                  >
                    {sending ? 'Sending...' : `Send to ${recoveredIds.length} Contact${recoveredIds.length !== 1 ? 's' : ''}`}
                  </Button>
                  <Button variant="outline" onClick={() => setShowSendPanel(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {sendResult && (
              <div className={`mt-4 p-3 rounded-lg text-sm ${
                sendResult.startsWith('Error')
                  ? 'bg-red-50 text-red-700'
                  : 'bg-green-50 text-green-700'
              }`}>
                <div className="flex items-center gap-2">
                  {sendResult.startsWith('Error')
                    ? <AlertTriangle className="h-4 w-4" />
                    : <CheckCircle className="h-4 w-4" />
                  }
                  {sendResult}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
