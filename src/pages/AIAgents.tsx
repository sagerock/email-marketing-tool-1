import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { AIFollowupConfig, AIFollowupDraft, AIFollowupContact } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import {
  Bot,
  Check,
  X,
  RefreshCw,
  Edit,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Power,
  PowerOff,
  Users,
  AlertTriangle,
  Sparkles,
  Settings2,
  Inbox,
  GitBranch,
  Mail,
  Send,
  Eye,
  MousePointerClick,
  Search,
} from 'lucide-react'

import { apiFetch } from '../lib/api'

type Tab = 'queue' | 'pipeline' | 'sent' | 'agents'

export default function AIAgents() {
  const { selectedClient } = useClient()
  const [activeTab, setActiveTab] = useState<Tab>('queue')
  const [configs, setConfigs] = useState<AIFollowupConfig[]>([])
  const [drafts, setDrafts] = useState<AIFollowupDraft[]>([])
  const [pipelineContacts, setPipelineContacts] = useState<AIFollowupContact[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedDraft, setExpandedDraft] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<string | null>(null)
  const [editSubject, setEditSubject] = useState('')
  const [editContent, setEditContent] = useState('')
  const [showCreateAgent, setShowCreateAgent] = useState(false)
  const [editingConfig, setEditingConfig] = useState<AIFollowupConfig | null>(null)
  const [filterConfigId, setFilterConfigId] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Sent emails state
  const [sentEmails, setSentEmails] = useState<any[]>([])
  const [expandedSent, setExpandedSent] = useState<string | null>(null)
  const [sentEventDetails, setSentEventDetails] = useState<Record<string, any[]>>({})
  const [searchTerm, setSearchTerm] = useState('')

  // New agent form state
  const [newAgent, setNewAgent] = useState({
    name: '',
    trigger_type: 'tag' as 'tag' | 'webhook',
    trigger_tag: '',
    from_email: '',
    from_name: '',
    reply_to: '',
    bcc_email: '',
    max_followups: 3,
    followup_delays: '1, 3, 7',
    system_prompt: '',
    log_to_salesforce: false,
  })

  const fetchConfigs = useCallback(async () => {
    if (!selectedClient) return
    try {
      const res = await apiFetch(`/api/ai-followup/configs?clientId=${selectedClient.id}`)
      const data = await res.json()
      if (Array.isArray(data)) setConfigs(data)
    } catch (error) {
      console.error('Error fetching configs:', error)
    }
  }, [selectedClient])

  const fetchDrafts = useCallback(async () => {
    if (!selectedClient) return
    try {
      let url = `/api/ai-followup/drafts?clientId=${selectedClient.id}`
      if (activeTab === 'queue') url += '&status=pending'
      if (filterConfigId) url += `&configId=${filterConfigId}`
      const res = await apiFetch(url)
      const data = await res.json()
      if (Array.isArray(data)) setDrafts(data)
    } catch (error) {
      console.error('Error fetching drafts:', error)
    }
  }, [selectedClient, activeTab, filterConfigId])

  const fetchPipeline = useCallback(async () => {
    if (!selectedClient) return
    try {
      let url = `/api/ai-followup/contacts?clientId=${selectedClient.id}`
      if (filterConfigId) url += `&configId=${filterConfigId}`
      if (filterStatus) url += `&status=${filterStatus}`
      const res = await apiFetch(url)
      const data = await res.json()
      if (Array.isArray(data)) setPipelineContacts(data)
    } catch (error) {
      console.error('Error fetching pipeline:', error)
    }
  }, [selectedClient, filterConfigId, filterStatus])

  const fetchSentEmails = useCallback(async () => {
    if (!selectedClient) return
    try {
      let url = `/api/ai-followup/sent-emails?clientId=${selectedClient.id}`
      if (filterConfigId) url += `&configId=${filterConfigId}`
      if (searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`
      const res = await apiFetch(url)
      const data = await res.json()
      if (Array.isArray(data)) setSentEmails(data)
    } catch (error) {
      console.error('Error fetching sent emails:', error)
    }
  }, [selectedClient, filterConfigId, searchTerm])

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchConfigs(), fetchDrafts(), fetchPipeline()]).finally(() => setLoading(false))
  }, [selectedClient])

  useEffect(() => {
    if (activeTab === 'queue') fetchDrafts()
    if (activeTab === 'pipeline') fetchPipeline()
    if (activeTab === 'sent') fetchSentEmails()
  }, [activeTab, filterConfigId, filterStatus])

  const pendingCount = drafts.filter(d => d.status === 'pending').length

  // ---- Actions ----

  const handleApprove = async (draftId: string) => {
    if (!confirm('Send this email now?')) return
    setActionLoading(draftId)
    try {
      const res = await apiFetch(`/api/ai-followup/drafts/${draftId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      await fetchDrafts()
    } catch (error: any) {
      alert(`Failed to approve: ${error.message}`)
    } finally {
      setActionLoading(null)
    }
  }

  const handleReject = async (draftId: string, regenerate = false) => {
    const reason = regenerate ? '' : prompt('Rejection reason (optional):') || ''
    setActionLoading(draftId)
    try {
      const res = await apiFetch(`/api/ai-followup/drafts/${draftId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectionReason: reason, regenerate }),
      })
      if (!res.ok) throw new Error('Failed to reject')
      await fetchDrafts()
    } catch (error: any) {
      alert(`Failed to reject: ${error.message}`)
    } finally {
      setActionLoading(null)
    }
  }

  const handleSaveEdit = async (draftId: string) => {
    setActionLoading(draftId)
    try {
      const res = await apiFetch(`/api/ai-followup/drafts/${draftId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: editSubject, plain_text: editContent, html_content: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${editContent.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>')}</div>` }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setEditingDraft(null)
      await fetchDrafts()
    } catch (error: any) {
      alert(`Failed to save: ${error.message}`)
    } finally {
      setActionLoading(null)
    }
  }

  const handleCreateAgent = async () => {
    if (!selectedClient) return
    const delays = newAgent.followup_delays.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
    if (delays.length === 0) {
      alert('Please enter at least one follow-up delay (in days)')
      return
    }
    try {
      const res = await apiFetch(`/api/ai-followup/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient.id,
          name: newAgent.name,
          trigger_type: newAgent.trigger_type,
          trigger_tag: newAgent.trigger_type === 'tag' ? newAgent.trigger_tag : null,
          from_email: newAgent.from_email,
          from_name: newAgent.from_name,
          reply_to: newAgent.reply_to || null,
          bcc_email: newAgent.bcc_email || null,
          max_followups: newAgent.max_followups,
          followup_delays: delays,
          system_prompt: newAgent.system_prompt || null,
          log_to_salesforce: newAgent.log_to_salesforce,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setShowCreateAgent(false)
      setNewAgent({ name: '', trigger_type: 'tag', trigger_tag: '', from_email: '', from_name: '', reply_to: '', bcc_email: '', max_followups: 3, followup_delays: '1, 3, 7', system_prompt: '', log_to_salesforce: false })
      await fetchConfigs()
    } catch (error: any) {
      alert(`Failed to create agent: ${error.message}`)
    }
  }

  const handleUpdateConfig = async (configId: string, updates: Partial<AIFollowupConfig>) => {
    try {
      const res = await apiFetch(`/api/ai-followup/configs/${configId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) throw new Error('Failed to update')
      await fetchConfigs()
    } catch (error: any) {
      alert(`Failed to update: ${error.message}`)
    }
  }

  const handleDeleteConfig = async (configId: string) => {
    if (!confirm('Delete this AI agent? All drafts and enrollment data will be removed.')) return
    try {
      const res = await apiFetch(`/api/ai-followup/configs/${configId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      setEditingConfig(null)
      await fetchConfigs()
    } catch (error: any) {
      alert(`Failed to delete: ${error.message}`)
    }
  }

  const handleTestGenerate = async (configId: string) => {
    const email = prompt('Enter a contact email to generate a test draft for:')
    if (!email) return
    // Look up the contact first
    try {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id')
        .eq('client_id', selectedClient?.id)
        .eq('email', email.toLowerCase().trim())
        .limit(1)

      if (!contacts || contacts.length === 0) {
        alert('Contact not found with that email')
        return
      }

      setActionLoading(configId)
      const res = await apiFetch(`/api/ai-followup/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contacts[0].id, configId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      alert('Test draft generated! Check the Approval Queue tab.')
      setActiveTab('queue')
      await fetchDrafts()
    } catch (error: any) {
      alert(`Failed to generate: ${error.message}`)
    } finally {
      setActionLoading(null)
    }
  }

  // ---- Render helpers ----

  const statusBadge = (status: string) => {
    const map: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
      pending: 'warning',
      in_progress: 'info',
      completed: 'success',
      opted_out: 'danger',
      sent: 'success',
      approved: 'success',
      rejected: 'danger',
      failed: 'danger',
    }
    return <Badge variant={map[status] || 'default'}>{status.replace('_', ' ')}</Badge>
  }

  const formatDate = (d?: string) => {
    if (!d) return '—'
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  if (!selectedClient) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <p>Select a client to manage AI Agents</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-lg">
            <Bot className="h-6 w-6 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">AI Agents</h1>
            <p className="text-sm text-gray-500">AI-powered email follow-up with human approval</p>
          </div>
        </div>
        {pendingCount > 0 && activeTab !== 'queue' && (
          <button
            onClick={() => setActiveTab('queue')}
            className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors"
          >
            <Inbox className="h-4 w-4" />
            {pendingCount} draft{pendingCount !== 1 ? 's' : ''} awaiting review
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6">
          {([
            { id: 'queue' as Tab, label: 'Approval Queue', icon: Inbox, count: pendingCount },
            { id: 'pipeline' as Tab, label: 'Pipeline', icon: GitBranch },
            { id: 'sent' as Tab, label: 'Sent Emails', icon: Send },
            { id: 'agents' as Tab, label: 'Agents', icon: Settings2 },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 py-3 px-1 border-b-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
              {tab.count ? (
                <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-amber-100 text-amber-700">
                  {tab.count}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </div>

      {/* Filter bar */}
      {(activeTab === 'queue' || activeTab === 'pipeline' || activeTab === 'sent') && configs.length > 0 && (
        <div className="flex items-center gap-3">
          <select
            value={filterConfigId}
            onChange={e => setFilterConfigId(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All Agents</option>
            {configs.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {activeTab === 'pipeline' && (
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="opted_out">Opted Out</option>
            </select>
          )}
          {activeTab === 'sent' && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search contacts or subjects..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') fetchSentEmails() }}
                className="pl-8 pr-3 py-1.5 text-sm rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-64"
              />
            </div>
          )}
          <button
            onClick={() => {
              if (activeTab === 'queue') fetchDrafts()
              if (activeTab === 'pipeline') fetchPipeline()
              if (activeTab === 'sent') fetchSentEmails()
            }}
            className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading...
        </div>
      ) : (
        <>
          {/* ===== APPROVAL QUEUE TAB ===== */}
          {activeTab === 'queue' && (
            <div className="space-y-3">
              {drafts.length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center text-gray-500">
                    <Inbox className="h-10 w-10 mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">No drafts awaiting review</p>
                    <p className="text-sm mt-1">Drafts will appear here when the AI generates follow-up emails</p>
                  </CardContent>
                </Card>
              ) : (
                drafts.map(draft => {
                  const isExpanded = expandedDraft === draft.id
                  const isEditing = editingDraft === draft.id
                  const isLoading = actionLoading === draft.id

                  return (
                    <Card key={draft.id} className={`transition-shadow ${isExpanded ? 'ring-2 ring-indigo-200' : 'hover:shadow-md'}`}>
                      <CardContent className="p-0">
                        {/* Draft header row */}
                        <div
                          className="flex items-center gap-4 px-5 py-4 cursor-pointer"
                          onClick={() => { setExpandedDraft(isExpanded ? null : draft.id); setEditingDraft(null) }}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                                {(draft as any).config?.name || 'Agent'}
                              </span>
                              <span className="text-xs text-gray-400">Step {draft.step_number}</span>
                              {statusBadge(draft.status)}
                            </div>
                            <p className="font-medium text-gray-900 truncate">{draft.subject || '(no subject)'}</p>
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                              <span>{(draft as any).contact?.first_name} {(draft as any).contact?.last_name}</span>
                              <span className="text-gray-300">|</span>
                              <span>{(draft as any).contact?.email}</span>
                              {(draft as any).contact?.company && (
                                <>
                                  <span className="text-gray-300">|</span>
                                  <span>{(draft as any).contact?.company}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="text-xs text-gray-400 whitespace-nowrap">
                            {formatDate(draft.created_at)}
                          </div>
                          {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                        </div>

                        {/* Expanded content */}
                        {isExpanded && (
                          <div className="border-t border-gray-100">
                            {/* Form submission context */}
                            {draft.ai_prompt_context?.form_submission && (
                              <div className="px-5 py-3 bg-amber-50 border-b border-amber-100">
                                <div className="text-xs font-medium text-amber-700 mb-1 uppercase tracking-wide">
                                  Form Submission — {draft.ai_prompt_context.form_submission.form_name || 'Web Form'}
                                </div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                  {Object.entries(draft.ai_prompt_context.form_submission.fields || {}).map(([key, value]) => (
                                    <div key={key} className="text-xs text-amber-900">
                                      <span className="font-medium">{key}:</span> {String(value)}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {/* Email preview */}
                            <div className="px-5 py-4 bg-gray-50">
                              <div className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Email Preview</div>
                              {isEditing ? (
                                <div className="space-y-3">
                                  <Input
                                    value={editSubject}
                                    onChange={e => setEditSubject(e.target.value)}
                                    placeholder="Subject line"
                                  />
                                  <textarea
                                    value={editContent}
                                    onChange={e => setEditContent(e.target.value)}
                                    rows={8}
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                  />
                                  <div className="flex gap-2">
                                    <Button size="sm" onClick={() => handleSaveEdit(draft.id)} disabled={isLoading}>
                                      {isLoading ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : null}
                                      Save Changes
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => setEditingDraft(null)}>Cancel</Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="bg-white rounded-lg border border-gray-200 p-5 max-w-2xl">
                                  <div className="text-sm text-gray-500 mb-1">
                                    <strong>From:</strong> {(draft as any).config?.from_name} &lt;{(draft as any).config?.from_email}&gt;
                                  </div>
                                  <div className="text-sm text-gray-500 mb-1">
                                    <strong>To:</strong> {(draft as any).contact?.email}
                                  </div>
                                  <div className="text-sm text-gray-500 mb-3">
                                    <strong>Subject:</strong> {draft.subject}
                                  </div>
                                  <hr className="mb-3" />
                                  <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                                    {draft.plain_text}
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Action buttons */}
                            {draft.status === 'pending' && !isEditing && (
                              <div className="flex items-center gap-2 px-5 py-3 bg-white border-t border-gray-100">
                                <Button
                                  size="sm"
                                  onClick={() => handleApprove(draft.id)}
                                  disabled={isLoading}
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                >
                                  {isLoading ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                                  Approve & Send
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setEditingDraft(draft.id)
                                    setEditSubject(draft.subject || '')
                                    setEditContent(draft.plain_text || '')
                                  }}
                                >
                                  <Edit className="h-3 w-3 mr-1" /> Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleReject(draft.id, true)}
                                  disabled={isLoading}
                                >
                                  <RefreshCw className="h-3 w-3 mr-1" /> Regenerate
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => handleReject(draft.id, false)}
                                  disabled={isLoading}
                                >
                                  <X className="h-3 w-3 mr-1" /> Reject
                                </Button>
                              </div>
                            )}

                            {/* Sent/rejected info */}
                            {draft.status === 'sent' && (
                              <div className="flex items-center gap-2 px-5 py-3 bg-emerald-50 text-emerald-700 text-sm border-t border-gray-100">
                                <Check className="h-4 w-4" />
                                Sent {formatDate(draft.sent_at)}
                                {draft.salesforce_task_id && (
                                  <span className="ml-2 text-xs text-emerald-600">SF Task: {draft.salesforce_task_id}</span>
                                )}
                              </div>
                            )}
                            {draft.status === 'rejected' && (
                              <div className="flex items-center gap-2 px-5 py-3 bg-red-50 text-red-700 text-sm border-t border-gray-100">
                                <X className="h-4 w-4" />
                                Rejected {formatDate(draft.reviewed_at)}
                                {draft.rejection_reason && <span>— {draft.rejection_reason}</span>}
                              </div>
                            )}
                            {draft.status === 'failed' && (
                              <div className="flex items-center gap-2 px-5 py-3 bg-red-50 text-red-700 text-sm border-t border-gray-100">
                                <AlertTriangle className="h-4 w-4" />
                                Failed: {draft.error_message}
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })
              )}
            </div>
          )}

          {/* ===== PIPELINE TAB ===== */}
          {activeTab === 'pipeline' && (
            <Card>
              <CardContent className="p-0">
                {pipelineContacts.length === 0 ? (
                  <div className="py-12 text-center text-gray-500">
                    <Users className="h-10 w-10 mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">No contacts in the pipeline</p>
                    <p className="text-sm mt-1">Contacts are enrolled automatically when they receive a trigger tag</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-50">
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Contact</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Agent</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Step</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Enrolled</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Last Email</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Next Follow-up</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pipelineContacts.map(fc => (
                          <tr key={fc.id} className="border-b border-gray-100 hover:bg-gray-50">
                            <td className="px-4 py-3">
                              <div className="font-medium text-gray-900">
                                {(fc as any).contact?.first_name} {(fc as any).contact?.last_name}
                              </div>
                              <div className="text-xs text-gray-500">{(fc as any).contact?.email}</div>
                            </td>
                            <td className="px-4 py-3 text-gray-600">{(fc as any).config?.name || '—'}</td>
                            <td className="px-4 py-3">{statusBadge(fc.status)}</td>
                            <td className="px-4 py-3 text-gray-600">{fc.current_step}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(fc.enrolled_at)}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(fc.last_email_sent_at)}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">
                              {fc.status === 'in_progress' ? formatDate(fc.next_followup_at) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ===== SENT EMAILS TAB ===== */}
          {activeTab === 'sent' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sent AI Emails</CardTitle>
              </CardHeader>
              <CardContent>
                {sentEmails.length === 0 ? (
                  <div className="py-12 text-center text-gray-500">
                    <Mail className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No sent emails yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sentEmails.map(draft => (
                      <div key={draft.id} className="border rounded-lg overflow-hidden">
                        {/* Summary row */}
                        <button
                          onClick={async () => {
                            const newId = expandedSent === draft.id ? null : draft.id
                            setExpandedSent(newId)
                            if (newId && !sentEventDetails[draft.id]) {
                              try {
                                const res = await apiFetch(`/api/ai-followup/drafts/${draft.id}/analytics`)
                                const data = await res.json()
                                setSentEventDetails(prev => ({ ...prev, [draft.id]: data }))
                              } catch (err) { console.error(err) }
                            }
                          }}
                          className="w-full px-4 py-3 flex items-center gap-4 hover:bg-gray-50 transition-colors text-left"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-medium text-sm text-gray-900 truncate">
                                {draft.contact?.first_name} {draft.contact?.last_name}
                              </span>
                              {draft.contact?.company && (
                                <span className="text-xs text-gray-400">{draft.contact.company}</span>
                              )}
                            </div>
                            <div className="text-sm text-gray-600 truncate">{draft.subject}</div>
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                              <span>{draft.config?.name}</span>
                              <span>Step {draft.step_number}</span>
                              <span>{new Date(draft.sent_at).toLocaleDateString()}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-xs shrink-0">
                            <span className="flex items-center gap-1 text-gray-500" title="Opens">
                              <Eye className="h-3.5 w-3.5" />
                              {draft.analytics?.open || 0}
                            </span>
                            <span className="flex items-center gap-1 text-gray-500" title="Clicks">
                              <MousePointerClick className="h-3.5 w-3.5" />
                              {draft.analytics?.click || 0}
                            </span>
                            {draft.analytics?.bounce && (
                              <Badge variant="danger" className="text-xs">Bounced</Badge>
                            )}
                          </div>
                          {expandedSent === draft.id ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                        </button>

                        {/* Expanded detail */}
                        {expandedSent === draft.id && (
                          <div className="border-t bg-gray-50 p-4 space-y-4">
                            {/* Email preview */}
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Email Preview</h4>
                              <div className="bg-white border rounded-lg p-4">
                                <div className="text-xs text-gray-400 mb-1">
                                  From: {draft.config?.from_name} &lt;{draft.config?.from_email}&gt;
                                </div>
                                <div className="text-xs text-gray-400 mb-3">
                                  To: {draft.contact?.email}
                                </div>
                                <div className="text-sm font-medium mb-2">{draft.subject}</div>
                                <div
                                  className="prose prose-sm max-w-none text-gray-700"
                                  dangerouslySetInnerHTML={{ __html: draft.html_content || draft.plain_text?.replace(/\n/g, '<br>') || '' }}
                                />
                              </div>
                            </div>

                            {/* Form context */}
                            {draft.ai_prompt_context?.form_submission && (
                              <div>
                                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Form Submission</h4>
                                <div className="bg-white border rounded-lg p-3 text-sm">
                                  {Object.entries(draft.ai_prompt_context.form_submission).map(([key, val]) => (
                                    <div key={key} className="flex gap-2 py-0.5">
                                      <span className="text-gray-400 shrink-0">{key}:</span>
                                      <span className="text-gray-700">{String(val)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Event timeline */}
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Delivery & Engagement</h4>
                              {!sentEventDetails[draft.id] ? (
                                <div className="text-xs text-gray-400">Loading events...</div>
                              ) : sentEventDetails[draft.id].length === 0 ? (
                                <div className="text-xs text-gray-400">No events recorded yet</div>
                              ) : (
                                <div className="bg-white border rounded-lg divide-y">
                                  {sentEventDetails[draft.id].map((evt: any) => (
                                    <div key={evt.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                                      <Badge
                                        variant={
                                          evt.event_type === 'delivered' ? 'default' :
                                          evt.event_type === 'open' ? 'info' :
                                          evt.event_type === 'click' ? 'success' :
                                          'danger'
                                        }
                                        className="text-xs w-20 justify-center"
                                      >
                                        {evt.event_type}
                                      </Badge>
                                      <span className="text-gray-500 text-xs">
                                        {new Date(evt.timestamp).toLocaleString()}
                                      </span>
                                      {evt.url && (
                                        <span className="text-xs text-blue-500 truncate max-w-xs" title={evt.url}>
                                          {evt.url}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ===== AGENTS CONFIG TAB ===== */}
          {activeTab === 'agents' && (
            <div className="space-y-4">
              <div className="flex justify-end">
                <Button onClick={() => { setShowCreateAgent(true); setEditingConfig(null) }}>
                  <Plus className="h-4 w-4 mr-1" /> New AI Agent
                </Button>
              </div>

              {/* Create / Edit Agent Modal */}
              {(showCreateAgent || editingConfig) && (
                <Card className="ring-2 ring-indigo-200">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {editingConfig ? `Edit: ${editingConfig.name}` : 'Create AI Agent'}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <AgentForm
                      values={editingConfig ? {
                        name: editingConfig.name,
                        trigger_type: editingConfig.trigger_type || 'tag',
                        trigger_tag: editingConfig.trigger_tag || '',
                        webhook_key: editingConfig.webhook_key || '',
                        from_email: editingConfig.from_email,
                        from_name: editingConfig.from_name,
                        reply_to: editingConfig.reply_to || '',
                        bcc_email: editingConfig.bcc_email || '',
                        max_followups: editingConfig.max_followups,
                        followup_delays: editingConfig.followup_delays.join(', '),
                        system_prompt: editingConfig.system_prompt || '',
                        log_to_salesforce: editingConfig.log_to_salesforce,
                      } : newAgent}
                      onChange={editingConfig ? undefined : setNewAgent}
                      onSave={async (vals) => {
                        if (editingConfig) {
                          const delays = vals.followup_delays.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n))
                          await handleUpdateConfig(editingConfig.id, {
                            name: vals.name,
                            trigger_type: vals.trigger_type,
                            trigger_tag: vals.trigger_type === 'tag' ? vals.trigger_tag : null,
                            from_email: vals.from_email,
                            from_name: vals.from_name,
                            reply_to: vals.reply_to || undefined,
                            bcc_email: vals.bcc_email || undefined,
                            max_followups: vals.max_followups,
                            followup_delays: delays,
                            system_prompt: vals.system_prompt || undefined,
                            log_to_salesforce: vals.log_to_salesforce,
                          } as any)
                          setEditingConfig(null)
                        } else {
                          await handleCreateAgent()
                        }
                      }}
                      onCancel={() => { setShowCreateAgent(false); setEditingConfig(null) }}
                      isEdit={!!editingConfig}
                      hasSalesforce={!!selectedClient?.salesforce_instance_url}
                    />
                  </CardContent>
                </Card>
              )}

              {/* Agent list */}
              {configs.length === 0 && !showCreateAgent ? (
                <Card>
                  <CardContent className="py-12 text-center text-gray-500">
                    <Bot className="h-10 w-10 mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">No AI agents configured</p>
                    <p className="text-sm mt-1">Create an agent to start generating AI-powered follow-up emails</p>
                  </CardContent>
                </Card>
              ) : (
                configs.map(config => (
                  <Card key={config.id} className={editingConfig?.id === config.id ? 'hidden' : ''}>
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <div className={`p-2 rounded-lg ${config.enabled ? 'bg-emerald-100' : 'bg-gray-100'}`}>
                            <Bot className={`h-5 w-5 ${config.enabled ? 'text-emerald-600' : 'text-gray-400'}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-gray-900">{config.name}</h3>
                              <Badge variant={config.enabled ? 'success' : 'default'}>
                                {config.enabled ? 'Active' : 'Disabled'}
                              </Badge>
                            </div>
                            <div className="mt-1 text-sm text-gray-500 space-y-0.5">
                              <p>
                                <span className="font-medium">Trigger:</span>{' '}
                                {config.trigger_type === 'webhook' ? (
                                  <span className="inline-flex items-center gap-1">
                                    webhook
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        const url = `${window.location.origin}/api/webhook/gravity-forms/${config.webhook_key}`
                                        navigator.clipboard.writeText(url)
                                        alert('Webhook URL copied to clipboard!')
                                      }}
                                      className="text-indigo-500 hover:text-indigo-700 text-xs underline"
                                      title="Copy webhook URL"
                                    >
                                      copy URL
                                    </button>
                                  </span>
                                ) : (
                                  <>tag "{config.trigger_tag}"</>
                                )}
                              </p>
                              <p>
                                <span className="font-medium">From:</span> {config.from_name} &lt;{config.from_email}&gt;
                              </p>
                              <p>
                                {config.bcc_email && (
                                <><span className="font-medium">BCC:</span> {config.bcc_email}<br/></>
                              )}
                              <span className="font-medium">Schedule:</span> {config.max_followups} follow-ups at day{config.followup_delays.length > 1 ? 's' : ''} {config.followup_delays.join(', ')}
                              </p>
                              {config.log_to_salesforce && (
                                <p className="text-indigo-600">
                                  <span className="font-medium">Salesforce:</span> logging enabled
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleTestGenerate(config.id)}
                            className="p-2 text-gray-400 hover:text-indigo-600 transition-colors"
                            title="Generate test draft"
                          >
                            {actionLoading === config.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                          </button>
                          <button
                            onClick={() => handleUpdateConfig(config.id, { enabled: !config.enabled } as any)}
                            className={`p-2 transition-colors ${config.enabled ? 'text-emerald-500 hover:text-red-500' : 'text-gray-400 hover:text-emerald-500'}`}
                            title={config.enabled ? 'Disable agent' : 'Enable agent'}
                          >
                            {config.enabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                          </button>
                          <button
                            onClick={() => {
                              setEditingConfig(config)
                              setShowCreateAgent(false)
                            }}
                            className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
                            title="Edit agent"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteConfig(config.id)}
                            className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                            title="Delete agent"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---- Agent Config Form Component ----

function AgentForm({
  values: initialValues,
  onChange,
  onSave,
  onCancel,
  isEdit,
  hasSalesforce,
}: {
  values: any
  onChange?: (vals: any) => void
  onSave: (vals: any) => Promise<void>
  onCancel: () => void
  isEdit: boolean
  hasSalesforce: boolean
}) {
  const [vals, setVals] = useState(initialValues)
  const [saving, setSaving] = useState(false)

  const update = (key: string, value: any) => {
    const next = { ...vals, [key]: value }
    setVals(next)
    if (onChange) onChange(next)
  }

  const handleSubmit = async () => {
    if (!vals.name || !vals.from_email || !vals.from_name || (vals.trigger_type !== 'webhook' && !vals.trigger_tag)) {
      alert('Please fill in all required fields')
      return
    }
    setSaving(true)
    try {
      await onSave(vals)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Agent Name *</label>
        <Input value={vals.name} onChange={e => update('name', e.target.value)} placeholder="e.g. Free Sample Follow-Up" />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Trigger Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="trigger_type"
              value="tag"
              checked={vals.trigger_type !== 'webhook'}
              onChange={() => update('trigger_type', 'tag')}
              className="text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-gray-700">Tag-based</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="trigger_type"
              value="webhook"
              checked={vals.trigger_type === 'webhook'}
              onChange={() => update('trigger_type', 'webhook')}
              className="text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-gray-700">Webhook / Form Submission</span>
          </label>
        </div>
      </div>
      {vals.trigger_type !== 'webhook' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Trigger Tag *</label>
          <Input value={vals.trigger_tag} onChange={e => update('trigger_tag', e.target.value)} placeholder="e.g. Sample Request" />
          <p className="text-xs text-gray-400 mt-1">Contacts with this tag will be auto-enrolled</p>
        </div>
      ) : (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
          <label className="block text-sm font-medium text-indigo-800 mb-2">Webhook URL</label>
          {vals.webhook_key ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-white border border-indigo-200 rounded px-3 py-2 text-xs text-gray-700 break-all">
                {`${window.location.origin}/api/webhook/gravity-forms/${vals.webhook_key}`}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/api/webhook/gravity-forms/${vals.webhook_key}`)
                  alert('Copied!')
                }}
                className="px-3 py-2 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700 shrink-0"
              >
                Copy
              </button>
            </div>
          ) : (
            <p className="text-sm text-indigo-600">Webhook URL will be generated after saving.</p>
          )}
          <p className="text-xs text-indigo-500 mt-2">
            Configure this URL in Gravity Forms → Settings → Webhooks. Map form fields as JSON body keys. The <code className="bg-white px-1 rounded">email</code> field is required.
          </p>
        </div>
      )}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From Email *</label>
          <Input value={vals.from_email} onChange={e => update('from_email', e.target.value)} placeholder="samples@company.com" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From Name *</label>
          <Input value={vals.from_name} onChange={e => update('from_name', e.target.value)} placeholder="Sample Team" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Reply-To</label>
          <Input value={vals.reply_to} onChange={e => update('reply_to', e.target.value)} placeholder="Optional" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">BCC (copy of every sent email)</label>
        <Input value={vals.bcc_email} onChange={e => update('bcc_email', e.target.value)} placeholder="Optional — e.g. team@company.com" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Max Follow-ups</label>
          <Input type="number" min={1} max={10} value={vals.max_followups} onChange={e => update('max_followups', parseInt(e.target.value) || 3)} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Follow-up Delays (days, comma-separated)</label>
          <Input value={vals.followup_delays} onChange={e => update('followup_delays', e.target.value)} placeholder="1, 3, 7" />
          <p className="text-xs text-gray-400 mt-1">Days to wait between each follow-up</p>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">System Prompt</label>
        <textarea
          value={vals.system_prompt}
          onChange={e => update('system_prompt', e.target.value)}
          rows={6}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="Instructions for the AI agent. Define the tone, constraints, and what it should/shouldn't say..."
        />
        <p className="text-xs text-gray-400 mt-1">Leave blank for a default follow-up prompt. Include STRICT RULES for guardrails (e.g. "DO NOT provide technical advice").</p>
      </div>
      {hasSalesforce && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={vals.log_to_salesforce}
            onChange={e => update('log_to_salesforce', e.target.checked)}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-gray-700">Log sent emails as Tasks in Salesforce</span>
        </label>
      )}
      <div className="flex gap-2 pt-2">
        <Button onClick={handleSubmit} disabled={saving}>
          {saving ? <RefreshCw className="h-4 w-4 animate-spin mr-1" /> : null}
          {isEdit ? 'Save Changes' : 'Create Agent'}
        </Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
