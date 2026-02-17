import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Contact, Tag } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { Plus, Search, Upload, X, UserX, UserCheck, FileText, AlertCircle, CheckCircle2, Users, Eye, MousePointer, Tag as TagIcon, Loader2, Download } from 'lucide-react'

export default function Contacts() {
  const { selectedClient } = useClient()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [totalCount, setTotalCount] = useState<number>(0)
  const [availableTags, setAvailableTags] = useState<Tag[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)
  const [showContacts, setShowContacts] = useState(false)
  const [filteredTagCount, setFilteredTagCount] = useState<number | null>(null)
  const countRequestVersion = useRef(0)
  const [selectedSubscriber, setSelectedSubscriber] = useState<Contact | null>(null)
  const [subscriberActivity, setSubscriberActivity] = useState<{
    event_type: string
    timestamp: string
    url: string | null
    campaign_name: string
    campaign_id: string
  }[]>([])
  const [loadingSubscriberActivity, setLoadingSubscriberActivity] = useState(false)
  const [showBulkTagInput, setShowBulkTagInput] = useState(false)
  const [bulkTagName, setBulkTagName] = useState('')
  const [bulkTagLoading, setBulkTagLoading] = useState(false)
  const [exportingCSV, setExportingCSV] = useState(false)

  // Fetch total count and tags when client changes
  useEffect(() => {
    if (selectedClient) {
      fetchTotalCount()
      fetchTags()
    } else {
      setTotalCount(0)
      setAvailableTags([])
      setContacts([])
      setLoading(false)
    }
  }, [selectedClient])

  // Reset contacts list and fetch count when tags change
  useEffect(() => {
    setContacts([])
    setShowContacts(false)
    setShowBulkTagInput(false)
    setBulkTagName('')
    if (selectedTags.length > 0 && selectedClient) {
      fetchFilteredTagCount(selectedTags)
    } else {
      setFilteredTagCount(null)
    }
  }, [selectedTags, selectedClient])

  const fetchTotalCount = async () => {
    if (!selectedClient) return

    try {
      const { count, error } = await supabase
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', selectedClient.id)

      if (error) throw error
      setTotalCount(count || 0)
    } catch (error) {
      console.error('Error fetching count:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchTags = async () => {
    if (!selectedClient) return

    try {
      const { data, error } = await supabase
        .from('tags')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('name', { ascending: true })

      if (error) throw error
      setAvailableTags(data || [])
    } catch (error) {
      console.error('Error fetching tags:', error)
    }
  }

  const fetchFilteredTagCount = async (tags: string[]) => {
    if (!selectedClient || tags.length === 0) {
      setFilteredTagCount(null)
      return
    }

    // Increment version and capture it for this request
    countRequestVersion.current += 1
    const thisRequestVersion = countRequestVersion.current

    try {
      const { count, error } = await supabase
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', selectedClient.id)
        .filter('tags', 'ov', `{${tags.map(t => `"${t}"`).join(',')}}`)

      if (error) throw error

      // Only update if this is still the latest request
      if (thisRequestVersion === countRequestVersion.current) {
        setFilteredTagCount(count || 0)
      }
    } catch (error) {
      console.error('Error fetching filtered count:', error)
    }
  }

  const fetchFilteredContacts = async () => {
    if (!selectedClient || selectedTags.length === 0) {
      setContacts([])
      return
    }

    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('client_id', selectedClient.id)
        .filter('tags', 'ov', `{${selectedTags.map(t => `"${t}"`).join(',')}}`)
        .order('created_at', { ascending: false })

      if (error) throw error
      setContacts(data || [])
    } catch (error) {
      console.error('Error fetching contacts:', error)
    } finally {
      setLoading(false)
    }
  }

  const searchContacts = async () => {
    if (!selectedClient || !searchTerm.trim()) {
      return
    }

    setLoading(true)
    setShowContacts(true)
    try {
      const terms = searchTerm.trim().toLowerCase().split(/\s+/)

      // Build OR conditions for each term across all searchable fields
      const orConditions = terms.map(term =>
        `email.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%,company.ilike.%${term}%`
      ).join(',')

      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('client_id', selectedClient.id)
        .or(orConditions)
        .order('created_at', { ascending: false })
        .limit(100)

      if (error) throw error

      // Filter client-side to ensure ALL terms match (not just any)
      const filtered = data?.filter(contact => {
        const searchableText = [
          contact.email,
          contact.first_name,
          contact.last_name,
          contact.company
        ].filter(Boolean).join(' ').toLowerCase()

        return terms.every(term => searchableText.includes(term))
      }) || []

      setContacts(filtered)
    } catch (error) {
      console.error('Error searching contacts:', error)
    } finally {
      setLoading(false)
    }
  }

  // Fetch subscriber activity (opens and clicks with campaign info)
  const fetchSubscriberActivity = async (contact: Contact) => {
    setSelectedSubscriber(contact)
    setLoadingSubscriberActivity(true)
    setSubscriberActivity([])

    try {
      const { data, error } = await supabase
        .from('analytics_events')
        .select('event_type, timestamp, url, campaign_id, campaign:campaigns(name)')
        .eq('email', contact.email)
        .in('event_type', ['open', 'click'])
        .order('timestamp', { ascending: false })
        .limit(100)

      if (error) throw error

      setSubscriberActivity(
        (data || []).map((event: any) => ({
          event_type: event.event_type,
          timestamp: event.timestamp,
          url: event.url,
          campaign_name: event.campaign?.name || 'Unknown Campaign',
          campaign_id: event.campaign_id,
        }))
      )
    } catch (error) {
      console.error('Error fetching subscriber activity:', error)
    } finally {
      setLoadingSubscriberActivity(false)
    }
  }

  // For backwards compatibility with modals that expect allTags as string[]
  const allTags = availableTags.map(t => t.name)

  // Use actual filtered count from database query, or total count when no tags selected
  const filteredCount = selectedTags.length > 0
    ? filteredTagCount
    : totalCount

  // When searching, contacts are already filtered server-side
  const filteredContacts = contacts

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  const refreshData = () => {
    fetchTotalCount()
    fetchTags()
    if (showContacts) {
      fetchFilteredContacts()
    }
  }

  const applyBulkTag = async () => {
    if (!selectedClient || !bulkTagName.trim() || selectedTags.length === 0) return

    setBulkTagLoading(true)
    try {
      // Fetch all emails matching the current tag filter
      const { data: matchingContacts, error: fetchError } = await supabase
        .from('contacts')
        .select('email')
        .eq('client_id', selectedClient.id)
        .filter('tags', 'ov', `{${selectedTags.map(t => `"${t}"`).join(',')}}`)

      if (fetchError) throw fetchError
      if (!matchingContacts || matchingContacts.length === 0) return

      const emails = matchingContacts.map(c => c.email)

      // Append the tag to all matching contacts
      const { error: rpcError } = await supabase.rpc('append_tag_to_contacts', {
        p_client_id: selectedClient.id,
        p_tag_name: bulkTagName.trim(),
        p_emails: emails,
      })

      if (rpcError) throw rpcError

      // Count contacts with the new tag and upsert to tags table
      // Use .filter() with explicit array quoting to handle commas in tag names
      const tagName = bulkTagName.trim()
      const { count, error: countError } = await supabase
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', selectedClient.id)
        .filter('tags', 'cs', `{"${tagName}"}`)

      // Only update tag count if we got a valid count — never overwrite with 0/null
      if (!countError && count !== null) {
        await supabase
          .from('tags')
          .upsert(
            { name: bulkTagName.trim(), client_id: selectedClient.id, contact_count: count },
            { onConflict: 'name,client_id' }
          )
      }

      // Reset and refresh
      setShowBulkTagInput(false)
      setBulkTagName('')
      refreshData()
    } catch (error) {
      console.error('Error applying bulk tag:', error)
      alert('Failed to apply tag. Please try again.')
    } finally {
      setBulkTagLoading(false)
    }
  }

  const exportContactsCSV = async () => {
    if (!selectedClient || selectedTags.length === 0) return

    setExportingCSV(true)
    try {
      // Use already-loaded contacts if available, otherwise fetch them
      let exportData = showContacts && contacts.length > 0 ? contacts : null

      if (!exportData) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .eq('client_id', selectedClient.id)
          .filter('tags', 'ov', `{${selectedTags.map(t => `"${t}"`).join(',')}}`)
          .order('created_at', { ascending: false })

        if (error) throw error
        exportData = data || []
      }

      if (exportData.length === 0) return

      const escapeCSV = (value: string) => {
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`
        }
        return value
      }

      const headers = ['Email', 'First Name', 'Last Name', 'Company', 'Tags', 'Status', 'Engagement Score', 'Total Opens', 'Total Clicks']
      const rows = exportData.map(c => [
        escapeCSV(c.email || ''),
        escapeCSV(c.first_name || ''),
        escapeCSV(c.last_name || ''),
        escapeCSV(c.company || ''),
        escapeCSV((c.tags || []).join('; ')),
        c.unsubscribed ? 'Unsubscribed' : c.bounce_status === 'hard' ? 'Hard Bounce' : c.bounce_status === 'soft' ? 'Soft Bounce' : 'Subscribed',
        String(c.engagement_score || 0),
        String(c.total_opens || 0),
        String(c.total_clicks || 0),
      ])

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const tagSlug = selectedTags.map(t => t.replace(/[^a-zA-Z0-9]/g, '-')).join('_')
      const date = new Date().toISOString().split('T')[0]
      a.download = `contacts-${tagSlug}-${date}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Error exporting contacts:', error)
      alert('Failed to export contacts. Please try again.')
    } finally {
      setExportingCSV(false)
    }
  }

  const bulkTagSuggestions = bulkTagName.trim()
    ? allTags.filter(tag =>
        tag.toLowerCase().includes(bulkTagName.toLowerCase())
      ).slice(0, 5)
    : []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Contacts</h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage your email contacts and organize them with tags
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setShowImportModal(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import CSV
          </Button>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Contact
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="relative flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search by email, name, or company..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      searchContacts()
                    }
                  }}
                  className="pl-10"
                />
              </div>
              <Button onClick={searchContacts} disabled={!searchTerm.trim()}>
                Search
              </Button>
            </div>

            {availableTags.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-gray-700">Filter by tags:</p>
                  {selectedTags.length > 0 && (
                    <button
                      onClick={() => setSelectedTags([])}
                      className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
                    >
                      <X className="h-3 w-3" />
                      Clear filters
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
                  {availableTags.map((tag) => (
                    <Badge
                      key={tag.id}
                      variant={selectedTags.includes(tag.name) ? 'info' : 'default'}
                      className="cursor-pointer hover:opacity-80"
                      onClick={() => toggleTag(tag.name)}
                    >
                      {tag.name} ({tag.contact_count.toLocaleString()})
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Contacts List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>
              {showContacts && contacts.length > 0
                ? `${filteredContacts.length.toLocaleString()} Contact${filteredContacts.length !== 1 ? 's' : ''}`
                : selectedTags.length > 0
                  ? `${filteredCount !== null ? filteredCount.toLocaleString() : '...'} Contact${filteredCount !== 1 ? 's' : ''}`
                  : `${totalCount.toLocaleString()} Contact${totalCount !== 1 ? 's' : ''}`
              }
            </CardTitle>
            {selectedTags.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={exportContactsCSV}
                disabled={exportingCSV || filteredCount === 0}
              >
                {exportingCSV ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-12 text-gray-500">Loading...</div>
          ) : showContacts && filteredContacts.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Email
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Name
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Company
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Tags
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">
                      Opens
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">
                      Clicks
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">
                      Score
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Status
                    </th>
                    <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredContacts.map((contact) => (
                    <ContactRow
                      key={contact.id}
                      contact={contact}
                      onUpdate={refreshData}
                      onEdit={setEditingContact}
                      onViewActivity={fetchSubscriberActivity}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : showContacts && filteredContacts.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              No contacts found
            </div>
          ) : selectedTags.length === 0 ? (
            <div className="text-center py-12">
              <Users className="h-16 w-16 mx-auto text-gray-300 mb-4" />
              <p className="text-gray-600 text-lg font-medium mb-2">
                {totalCount.toLocaleString()} contacts total
              </p>
              <p className="text-gray-500">
                Search or select a tag to view contacts
              </p>
            </div>
          ) : !showContacts ? (
            <div className="text-center py-12">
              <Users className="h-16 w-16 mx-auto text-gray-300 mb-4" />
              <p className="text-gray-600 text-lg font-medium mb-2">
                {filteredCount !== null ? filteredCount.toLocaleString() : '...'} contacts with selected tag{selectedTags.length !== 1 ? 's' : ''}
              </p>
              <p className="text-gray-500 mb-4">
                {selectedTags.join(', ')}
              </p>
              <div className="flex gap-3 justify-center">
                <Button onClick={() => { setShowContacts(true); fetchFilteredContacts(); }}>
                  View Contacts
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowBulkTagInput(true)}
                  disabled={showBulkTagInput}
                >
                  <TagIcon className="h-4 w-4 mr-2" />
                  Add Tag
                </Button>
                <Button
                  variant="outline"
                  onClick={exportContactsCSV}
                  disabled={exportingCSV || filteredCount === 0}
                >
                  {exportingCSV ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                  Export CSV
                </Button>
              </div>
              {showBulkTagInput && (
                <div className="mt-4 flex items-center gap-2 justify-center">
                  <div className="relative">
                    <Input
                      placeholder="Enter tag name..."
                      value={bulkTagName}
                      onChange={(e) => setBulkTagName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          applyBulkTag()
                        }
                        if (e.key === 'Escape') {
                          setShowBulkTagInput(false)
                          setBulkTagName('')
                        }
                      }}
                      className="w-64"
                      autoFocus
                      disabled={bulkTagLoading}
                    />
                    {bulkTagSuggestions.length > 0 && !bulkTagLoading && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg">
                        {bulkTagSuggestions.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 first:rounded-t-md last:rounded-b-md"
                            onClick={() => { setBulkTagName(tag) }}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={applyBulkTag}
                    disabled={!bulkTagName.trim() || bulkTagLoading}
                    size="sm"
                  >
                    {bulkTagLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setShowBulkTagInput(false); setBulkTagName('') }}
                    disabled={bulkTagLoading}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Add Contact Modal */}
      {showAddModal && selectedClient && (
        <AddContactModal
          clientId={selectedClient.id}
          allTags={allTags}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            refreshData()
          }}
        />
      )}

      {/* Edit Contact Modal */}
      {editingContact && (
        <EditContactModal
          contact={editingContact}
          allTags={allTags}
          onClose={() => setEditingContact(null)}
          onSuccess={() => {
            setEditingContact(null)
            refreshData()
          }}
        />
      )}

      {/* Import CSV Modal */}
      {showImportModal && selectedClient && (
        <ImportCSVModal
          clientId={selectedClient.id}
          onClose={() => setShowImportModal(false)}
          onSuccess={() => {
            setShowImportModal(false)
            refreshData()
          }}
        />
      )}

      {/* Subscriber Activity Modal */}
      {selectedSubscriber && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Subscriber Activity</h2>
                <p className="text-sm text-gray-600">{selectedSubscriber.email}</p>
                {(selectedSubscriber.first_name || selectedSubscriber.last_name) && (
                  <p className="text-sm text-gray-500">
                    {`${selectedSubscriber.first_name || ''} ${selectedSubscriber.last_name || ''}`.trim()}
                  </p>
                )}
              </div>
              <button
                onClick={() => setSelectedSubscriber(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Engagement Summary */}
            <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 shrink-0">
              <div className="flex gap-6">
                <div>
                  <p className="text-xs text-gray-500 uppercase">Opens</p>
                  <p className="text-lg font-semibold text-gray-900">{selectedSubscriber.total_opens || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase">Clicks</p>
                  <p className="text-lg font-semibold text-gray-900">{selectedSubscriber.total_clicks || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase">Score</p>
                  <p className="text-lg font-semibold text-blue-600">{selectedSubscriber.engagement_score || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase">Last Engaged</p>
                  <p className="text-sm font-medium text-gray-900">
                    {selectedSubscriber.last_engaged_at
                      ? new Date(selectedSubscriber.last_engaged_at).toLocaleDateString()
                      : '-'}
                  </p>
                </div>
              </div>
            </div>

            {/* Activity List */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {loadingSubscriberActivity ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                  <span className="ml-2 text-gray-600">Loading activity...</span>
                </div>
              ) : subscriberActivity.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p>No activity recorded for this subscriber.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {subscriberActivity.map((event, index) => (
                    <div
                      key={`${event.campaign_id}-${event.timestamp}-${index}`}
                      className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50"
                    >
                      <div className={`p-2 rounded-full shrink-0 ${
                        event.event_type === 'click' ? 'bg-green-100' : 'bg-blue-100'
                      }`}>
                        {event.event_type === 'click' ? (
                          <MousePointer className="h-4 w-4 text-green-600" />
                        ) : (
                          <Eye className="h-4 w-4 text-blue-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                            event.event_type === 'click'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}>
                            {event.event_type === 'click' ? 'Click' : 'Open'}
                          </span>
                          <span className="text-xs text-gray-500">
                            {new Date(event.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-gray-900 mt-1">
                          {event.campaign_name}
                        </p>
                        {event.url && (
                          <p className="text-xs text-gray-500 mt-1 truncate" title={event.url}>
                            {event.url}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg shrink-0">
              <Button variant="outline" onClick={() => setSelectedSubscriber(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Contact Row Component
function ContactRow({
  contact,
  onUpdate,
  onEdit,
  onViewActivity,
}: {
  contact: Contact
  onUpdate: () => void
  onEdit: (contact: Contact) => void
  onViewActivity: (contact: Contact) => void
}) {
  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this contact?')) return

    try {
      const { error } = await supabase.from('contacts').delete().eq('id', contact.id)
      if (error) throw error
      onUpdate()
    } catch (error) {
      console.error('Error deleting contact:', error)
      alert('Failed to delete contact')
    }
  }

  const handleUnsubscribe = async () => {
    const contactName = contact.first_name
      ? `${contact.first_name} ${contact.last_name || ''}`.trim()
      : contact.email

    if (
      !confirm(
        `Are you sure you want to unsubscribe ${contactName}?\n\nThey will no longer receive any campaigns until they are manually resubscribed.`
      )
    ) {
      return
    }

    try {
      const { error } = await supabase
        .from('contacts')
        .update({
          unsubscribed: true,
          unsubscribed_at: new Date().toISOString(),
        })
        .eq('id', contact.id)

      if (error) throw error
      onUpdate()
    } catch (error) {
      console.error('Error unsubscribing contact:', error)
      alert('Failed to unsubscribe contact')
    }
  }

  const handleResubscribe = async () => {
    const contactName = contact.first_name
      ? `${contact.first_name} ${contact.last_name || ''}`.trim()
      : contact.email

    if (
      !confirm(
        `Are you sure you want to resubscribe ${contactName}?\n\nThey will start receiving campaigns again.`
      )
    ) {
      return
    }

    try {
      const { error } = await supabase
        .from('contacts')
        .update({
          unsubscribed: false,
          unsubscribed_at: null,
        })
        .eq('id', contact.id)

      if (error) throw error
      onUpdate()
    } catch (error) {
      console.error('Error resubscribing contact:', error)
      alert('Failed to resubscribe contact')
    }
  }

  return (
    <tr className="hover:bg-gray-50">
      <td className="py-3 px-4 text-sm">
        <button
          onClick={() => onViewActivity(contact)}
          className="text-blue-600 hover:text-blue-800 hover:underline text-left"
        >
          {contact.email}
        </button>
      </td>
      <td className="py-3 px-4 text-sm text-gray-900">
        {contact.first_name || contact.last_name
          ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
          : '-'}
      </td>
      <td className="py-3 px-4 text-sm text-gray-900">
        {contact.company || '-'}
      </td>
      <td className="py-3 px-4">
        <div className="flex flex-wrap gap-1">
          {contact.tags && contact.tags.length > 0 ? (
            contact.tags.map((tag) => (
              <Badge key={tag} variant="default">
                {tag}
              </Badge>
            ))
          ) : (
            <span className="text-sm text-gray-400">No tags</span>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-sm text-gray-600 text-right">
        {contact.total_opens || 0}
      </td>
      <td className="py-3 px-4 text-sm text-gray-600 text-right">
        {contact.total_clicks || 0}
      </td>
      <td className="py-3 px-4 text-sm text-right">
        <span className={`font-medium ${
          (contact.engagement_score || 0) > 10 ? 'text-green-600' :
          (contact.engagement_score || 0) > 0 ? 'text-blue-600' : 'text-gray-400'
        }`}>
          {contact.engagement_score || 0}
        </span>
      </td>
      <td className="py-3 px-4">
        <div className="flex flex-col gap-1">
          {contact.bounce_status === 'hard' ? (
            <>
              <Badge variant="danger">Hard Bounce</Badge>
              {contact.bounced_at && (
                <span className="text-xs text-gray-500">
                  {new Date(contact.bounced_at).toLocaleDateString()}
                </span>
              )}
            </>
          ) : contact.bounce_status === 'soft' ? (
            <>
              <Badge variant="warning">Soft Bounce</Badge>
              {contact.bounced_at && (
                <span className="text-xs text-gray-500">
                  {new Date(contact.bounced_at).toLocaleDateString()}
                </span>
              )}
            </>
          ) : contact.unsubscribed ? (
            <>
              <Badge variant="danger">Unsubscribed</Badge>
              {contact.unsubscribed_at && (
                <span className="text-xs text-gray-500">
                  {new Date(contact.unsubscribed_at).toLocaleDateString()}
                </span>
              )}
            </>
          ) : (
            <Badge variant="success">Subscribed</Badge>
          )}
        </div>
      </td>
      <td className="py-3 px-4 text-right">
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onEdit(contact)}>
            Edit
          </Button>
          {contact.unsubscribed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleResubscribe}
              className="text-green-600 hover:text-green-700 hover:border-green-600"
            >
              <UserCheck className="h-4 w-4 mr-1" />
              Resubscribe
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleUnsubscribe}
              className="text-orange-600 hover:text-orange-700 hover:border-orange-600"
            >
              <UserX className="h-4 w-4 mr-1" />
              Unsubscribe
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  )
}

// Add Contact Modal Component
function AddContactModal({
  onClose,
  onSuccess,
  clientId,
  allTags,
}: {
  onClose: () => void
  onSuccess: () => void
  clientId: string
  allTags: string[]
}) {
  const [formData, setFormData] = useState({
    email: '',
    first_name: '',
    last_name: '',
    company: '',
  })
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      // Insert the contact
      const { error } = await supabase.from('contacts').insert({
        email: formData.email,
        first_name: formData.first_name || null,
        last_name: formData.last_name || null,
        company: formData.company || null,
        tags: selectedTags,
        client_id: clientId,
      })

      if (error) throw error

      // Add any new tags to the tags table
      const newTags = selectedTags.filter(tag => !allTags.includes(tag))
      if (newTags.length > 0) {
        await supabase.from('tags').upsert(
          newTags.map(tag => ({
            name: tag,
            client_id: clientId,
            contact_count: 1,
          })),
          { onConflict: 'name,client_id' }
        )
      }

      onSuccess()
    } catch (error) {
      console.error('Error adding contact:', error)
      alert('Failed to add contact. Email might already exist.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddNewTag = (tagToAdd?: string) => {
    const tag = (tagToAdd || newTag).trim()
    if (tag && !selectedTags.includes(tag)) {
      setSelectedTags([...selectedTags, tag])
      setNewTag('')
    }
  }

  // Filter tags for autocomplete
  const tagSuggestions = newTag.trim()
    ? allTags.filter(tag =>
        tag.toLowerCase().includes(newTag.toLowerCase()) &&
        !selectedTags.includes(tag)
      ).slice(0, 5)
    : []

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter((t) => t !== tag))
    } else {
      setSelectedTags([...selectedTags, tag])
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Add New Contact</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email *"
            type="email"
            required
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          />
          <Input
            label="First Name"
            value={formData.first_name}
            onChange={(e) =>
              setFormData({ ...formData, first_name: e.target.value })
            }
          />
          <Input
            label="Last Name"
            value={formData.last_name}
            onChange={(e) =>
              setFormData({ ...formData, last_name: e.target.value })
            }
          />
          <Input
            label="Company"
            value={formData.company}
            onChange={(e) =>
              setFormData({ ...formData, company: e.target.value })
            }
          />

          {/* Tag Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tags
            </label>

            {/* Existing Tags */}
            {allTags.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-2">Select from existing tags:</p>
                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                  {allTags.map((tag) => (
                    <Badge
                      key={tag}
                      variant={selectedTags.includes(tag) ? 'info' : 'default'}
                      className="cursor-pointer hover:opacity-80"
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Add New Tag with Autocomplete */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Type to search or add a new tag:</p>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Input
                    placeholder="Enter tag name..."
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleAddNewTag()
                      }
                    }}
                  />
                  {tagSuggestions.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg">
                      {tagSuggestions.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 first:rounded-t-md last:rounded-b-md"
                          onClick={() => handleAddNewTag(tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleAddNewTag()}
                  disabled={!newTag.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Selected Tags */}
            {selectedTags.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-2">Selected tags:</p>
                <div className="flex flex-wrap gap-2">
                  {selectedTags.map((tag) => (
                    <Badge key={tag} variant="info" className="cursor-pointer" onClick={() => toggleTag(tag)}>
                      {tag} <X className="h-3 w-3 ml-1 inline" />
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Contact'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Edit Contact Modal Component
function EditContactModal({
  contact,
  allTags,
  onClose,
  onSuccess,
}: {
  contact: Contact
  allTags: string[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [formData, setFormData] = useState({
    email: contact.email,
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    company: contact.company || '',
  })
  const [selectedTags, setSelectedTags] = useState<string[]>(contact.tags || [])
  const [newTag, setNewTag] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error } = await supabase
        .from('contacts')
        .update({
          email: formData.email,
          first_name: formData.first_name || null,
          last_name: formData.last_name || null,
          company: formData.company || null,
          tags: selectedTags,
        })
        .eq('id', contact.id)

      if (error) throw error

      // Add any new tags to the tags table
      const newTags = selectedTags.filter(tag => !allTags.includes(tag))
      if (newTags.length > 0 && contact.client_id) {
        await supabase.from('tags').upsert(
          newTags.map(tag => ({
            name: tag,
            client_id: contact.client_id,
            contact_count: 1,
          })),
          { onConflict: 'name,client_id' }
        )
      }

      onSuccess()
    } catch (error) {
      console.error('Error updating contact:', error)
      alert('Failed to update contact.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddNewTag = (tagToAdd?: string) => {
    const tag = (tagToAdd || newTag).trim()
    if (tag && !selectedTags.includes(tag)) {
      setSelectedTags([...selectedTags, tag])
      setNewTag('')
    }
  }

  // Filter tags for autocomplete
  const tagSuggestions = newTag.trim()
    ? allTags.filter(tag =>
        tag.toLowerCase().includes(newTag.toLowerCase()) &&
        !selectedTags.includes(tag)
      ).slice(0, 5)
    : []

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter((t) => t !== tag))
    } else {
      setSelectedTags([...selectedTags, tag])
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Edit Contact</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email *"
            type="email"
            required
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          />
          <Input
            label="First Name"
            value={formData.first_name}
            onChange={(e) =>
              setFormData({ ...formData, first_name: e.target.value })
            }
          />
          <Input
            label="Last Name"
            value={formData.last_name}
            onChange={(e) =>
              setFormData({ ...formData, last_name: e.target.value })
            }
          />
          <Input
            label="Company"
            value={formData.company}
            onChange={(e) =>
              setFormData({ ...formData, company: e.target.value })
            }
          />

          {/* Tag Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tags
            </label>

            {/* Existing Tags */}
            {allTags.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-2">Select from existing tags:</p>
                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                  {allTags.map((tag) => (
                    <Badge
                      key={tag}
                      variant={selectedTags.includes(tag) ? 'info' : 'default'}
                      className="cursor-pointer hover:opacity-80"
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Add New Tag with Autocomplete */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Type to search or add a new tag:</p>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Input
                    placeholder="Enter tag name..."
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleAddNewTag()
                      }
                    }}
                  />
                  {tagSuggestions.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg">
                      {tagSuggestions.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 first:rounded-t-md last:rounded-b-md"
                          onClick={() => handleAddNewTag(tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleAddNewTag()}
                  disabled={!newTag.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Selected Tags */}
            {selectedTags.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-2">Selected tags:</p>
                <div className="flex flex-wrap gap-2">
                  {selectedTags.map((tag) => (
                    <Badge key={tag} variant="info" className="cursor-pointer" onClick={() => toggleTag(tag)}>
                      {tag} <X className="h-3 w-3 ml-1 inline" />
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Updating...' : 'Update Contact'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Import CSV Modal Component
function ImportCSVModal({
  clientId,
  onClose,
  onSuccess,
}: {
  clientId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{
    total: number
    imported: number
    skipped: number
    errors: string[]
  } | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile && selectedFile.type === 'text/csv') {
      setFile(selectedFile)
      setProgress(null)
    } else {
      alert('Please select a valid CSV file')
    }
  }

  const parseCSV = (text: string): any[] => {
    const lines = text.split('\n').filter((line) => line.trim())
    if (lines.length === 0) return []

    // Parse CSV properly handling quoted values
    const parseCSVLine = (line: string): string[] => {
      const values: string[] = []
      let current = ''
      let inQuotes = false

      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        const nextChar = line[i + 1]

        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            // Escaped quote
            current += '"'
            i++ // Skip next quote
          } else {
            // Toggle quote mode
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          // End of value
          values.push(current.trim())
          current = ''
        } else {
          current += char
        }
      }

      // Add last value
      values.push(current.trim())
      return values
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
    const rows = []

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i])
      const row: any = {}

      headers.forEach((header, index) => {
        row[header] = values[index] || ''
      })

      rows.push(row)
    }

    return rows
  }

  const handleImport = async () => {
    if (!file) return

    setImporting(true)
    setProgress({ total: 0, imported: 0, skipped: 0, errors: [] })

    try {
      const text = await file.text()
      const rows = parseCSV(text)

      setProgress((prev) => ({ ...prev!, total: rows.length }))

      let imported = 0
      let skipped = 0
      const errors: string[] = []

      for (const row of rows) {
        // Map CSV columns to database fields (flexible column names)
        const email = row.email || row['e-mail'] || row['email address']
        const firstName = row['first name'] || row.firstname || row.first_name || ''
        const lastName = row['last name'] || row.lastname || row.last_name || ''
        const unsubscribed =
          row.unsubscribed === 'true' ||
          row.unsubscribed === '1' ||
          row.unsubscribed === 'yes' ||
          row.subscribed === 'false' ||
          row.subscribed === '0' ||
          row.subscribed === 'no'

        // Parse tags (comma-separated or semicolon-separated)
        let tags: string[] = []
        if (row.tags) {
          tags = row.tags
            .split(/[,;]/)
            .map((t: string) => t.trim())
            .filter((t: string) => t.length > 0)
        }

        // Validate email
        if (!email || !email.includes('@')) {
          skipped++
          errors.push(`Row ${rows.indexOf(row) + 2}: Invalid or missing email`)
          continue
        }

        try {
          // Insert contact
          const { error } = await supabase.from('contacts').insert({
            email: email.toLowerCase(),
            first_name: firstName || null,
            last_name: lastName || null,
            tags: tags.length > 0 ? tags : [],
            unsubscribed: unsubscribed,
            unsubscribed_at: unsubscribed ? new Date().toISOString() : null,
            client_id: clientId,
          })

          if (error) {
            // Check if it's a duplicate email
            if (error.message.includes('unique') || error.message.includes('duplicate')) {
              skipped++
              errors.push(`Row ${rows.indexOf(row) + 2}: ${email} already exists`)
            } else {
              skipped++
              errors.push(`Row ${rows.indexOf(row) + 2}: ${error.message}`)
            }
          } else {
            imported++
          }
        } catch (err) {
          skipped++
          errors.push(`Row ${rows.indexOf(row) + 2}: ${err}`)
        }

        // Update progress
        setProgress({
          total: rows.length,
          imported,
          skipped,
          errors,
        })
      }

      // Show completion message
      if (imported > 0) {
        setTimeout(() => {
          onSuccess()
        }, 2000)
      }
    } catch (error) {
      console.error('Error importing CSV:', error)
      alert('Failed to import CSV. Please check the file format.')
    } finally {
      setImporting(false)
    }
  }

  const downloadSampleCSV = () => {
    const sample = `email,first name,last name,subscribed,tags
john@example.com,John,Doe,yes,"VIP Customer;Gold Member"
jane@example.com,Jane,Smith,yes,"New Customer"
bob@example.com,Bob,Jones,no,"prospect;cold lead"`

    const blob = new Blob([sample], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'sample-contacts.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Import Contacts from CSV</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!progress ? (
          <>
            {/* Instructions */}
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start gap-3">
                <FileText className="h-5 w-5 text-blue-600 mt-0.5" />
                <div className="text-sm text-blue-900">
                  <p className="font-medium mb-2">CSV Format:</p>
                  <ul className="list-disc list-inside space-y-1 text-blue-800">
                    <li>
                      <strong>email</strong> (required) - Contact's email address
                    </li>
                    <li>
                      <strong>first name</strong> (optional) - First name
                    </li>
                    <li>
                      <strong>last name</strong> (optional) - Last name
                    </li>
                    <li>
                      <strong>subscribed</strong> (optional) - yes/no or true/false
                    </li>
                    <li>
                      <strong>tags</strong> (optional) - Semicolon separated tags (use quotes for
                      tags with commas)
                    </li>
                  </ul>
                  <p className="mt-3 text-blue-700">
                    Duplicate emails will be skipped automatically.
                  </p>
                </div>
              </div>
            </div>

            {/* Download Sample */}
            <div className="mb-6">
              <Button
                type="button"
                variant="outline"
                onClick={downloadSampleCSV}
                className="w-full"
              >
                <FileText className="h-4 w-4 mr-2" />
                Download Sample CSV
              </Button>
            </div>

            {/* File Upload */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select CSV File
              </label>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 focus:outline-none"
              />
              {file && (
                <p className="mt-2 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4 inline mr-1" />
                  {file.name} selected
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleImport} disabled={!file || importing}>
                {importing ? 'Importing...' : 'Import Contacts'}
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Progress Display */}
            <div className="space-y-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{progress.total}</p>
                    <p className="text-sm text-gray-600">Total Rows</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-green-600">{progress.imported}</p>
                    <p className="text-sm text-gray-600">Imported</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-orange-600">{progress.skipped}</p>
                    <p className="text-sm text-gray-600">Skipped</p>
                  </div>
                </div>
              </div>

              {/* Errors */}
              {progress.errors.length > 0 && (
                <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg max-h-60 overflow-y-auto">
                  <div className="flex items-start gap-2 mb-2">
                    <AlertCircle className="h-5 w-5 text-orange-600 mt-0.5" />
                    <p className="font-medium text-orange-900">
                      Issues Found ({progress.errors.length})
                    </p>
                  </div>
                  <ul className="text-sm text-orange-800 space-y-1">
                    {progress.errors.slice(0, 10).map((error, i) => (
                      <li key={i} className="font-mono">
                        {error}
                      </li>
                    ))}
                    {progress.errors.length > 10 && (
                      <li className="text-orange-600 italic">
                        ... and {progress.errors.length - 10} more
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Completion Message */}
              {!importing && progress.imported > 0 && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <p className="font-medium text-green-900">
                      Successfully imported {progress.imported} contact
                      {progress.imported !== 1 ? 's' : ''}!
                    </p>
                  </div>
                </div>
              )}

              {/* Close Button */}
              <div className="flex justify-end">
                <Button onClick={onClose} disabled={importing}>
                  {importing ? 'Importing...' : 'Close'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
