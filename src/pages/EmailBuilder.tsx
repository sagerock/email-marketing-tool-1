import { useState, useEffect, useRef, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useClient } from '../context/ClientContext'
import { apiFetch } from '../lib/api'
import { supabase } from '../lib/supabase'
import Button from '../components/ui/Button'
import { ArrowLeft, Send, Monitor, Smartphone, Save, Paperclip, X, AlertTriangle, Loader2, Image as ImageIcon, LayoutTemplate, MousePointerClick, Eye, CheckCircle2, PanelLeftClose, PanelLeftOpen, ChevronDown } from 'lucide-react'
import MediaPicker from '../components/media/MediaPicker'
import ChatMarkdown from '../components/ui/ChatMarkdown'
import SelectablePreview, { type PreviewSelection } from '../components/builder/SelectablePreview'
import ReadyToSendPanel from '../components/builder/ReadyToSendPanel'
import { checkEmail, collectLinkUrls, linkHealthIssues, sortIssues, type EmailIssue, type LinkResult } from '../lib/emailChecks'
import { cn } from '../lib/utils'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  htmlContent?: string
  subject?: string
  previewText?: string
  editCount?: number
  /** The AI's look at the rendered result of this change. */
  visual?: VisualCheck
}

interface VisualCheck {
  status: 'checking' | 'ok' | 'issues' | 'unavailable'
  summary?: string
  problems?: { problem: string; where: string }[]
}

interface DesignResult {
  mode: 'edits' | 'full' | 'failed'
  edit_count?: number
  reason?: string
  note?: string
  selection?: { start: number; end: number }
  design?: { html_content: string; subject?: string; preview_text?: string }
}

interface TemplateIndexItem {
  id: string
  name: string
  subject: string
  preview_text?: string
  created_at: string
}

interface SentCampaignItem {
  name: string
  sent_at: string
  template_id: string
  subject: string
}

interface Folder {
  id: string
  name: string
}

export default function EmailBuilder() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const editTemplateId = searchParams.get('templateId')
  const { selectedClient, setSelectedClient, clients, loading: clientsLoading } = useClient()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [streamStatus, setStreamStatus] = useState('')

  // Preview state
  const [currentHtml, setCurrentHtml] = useState('')
  const [currentSubject, setCurrentSubject] = useState('')
  const [currentPreviewText, setCurrentPreviewText] = useState('')
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop')
  // Hides the chat so the preview gets the whole width (the chat stays mounted).
  const [chatHidden, setChatHidden] = useState(false)
  // The part of the email clicked in the preview; edits are kept inside it.
  const [selection, setSelection] = useState<PreviewSelection | null>(null)
  // Link health comes from the server (it fetches each link); results are
  // kept per URL so an edit only checks links it hasn't seen.
  const [linkResults, setLinkResults] = useState<Record<string, LinkResult>>({})
  const [checkingLinks, setCheckingLinks] = useState(false)
  const linkResultsRef = useRef(linkResults)
  useEffect(() => { linkResultsRef.current = linkResults }, [linkResults])
  const issues = useMemo(
    () => (currentHtml
      ? sortIssues([...checkEmail(currentHtml, currentSubject, currentPreviewText), ...linkHealthIssues(currentHtml, linkResults)])
      : []),
    [currentHtml, currentSubject, currentPreviewText, linkResults]
  )
  // CAN-SPAM problems also show in the header, where they're hard to miss.
  const complianceWarnings = issues.filter(i => i.id === 'no-unsub' || i.id === 'no-address').map(i => i.title)

  // Template reference state
  const [templateIndex, setTemplateIndex] = useState<TemplateIndexItem[]>([])
  const [starters, setStarters] = useState<TemplateIndexItem[]>([])
  const [, setSentCampaigns] = useState<SentCampaignItem[]>([])
  const [referenceTemplateIds, setReferenceTemplateIds] = useState<string[]>([])
  const [showReferencePicker, setShowReferencePicker] = useState(false)
  const [referenceSearch, setReferenceSearch] = useState('')

  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saveAsCopy, setSaveAsCopy] = useState(false)
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  const saveMenuRef = useRef<HTMLDivElement>(null)
  const justSavedId = useRef<{ id: string; clientId: string } | null>(null)
  const snapshot = JSON.stringify([currentHtml, currentSubject, currentPreviewText])
  const hasUnsavedChanges = Boolean(currentHtml) && snapshot !== savedSnapshot
  const previewImages = useMemo(() => {
    if (!currentHtml) return []
    const doc = new DOMParser().parseFromString(currentHtml, 'text/html')
    return Array.from(doc.querySelectorAll('img')).map((img, i) => ({
      name: img.getAttribute('alt') || img.getAttribute('src')?.split('/').pop()?.split('?')[0] || `Image ${i + 1}`,
      needsSource: !/^(https:\/\/|data:image\/)/i.test(img.getAttribute('src') || ''),
    }))
  }, [currentHtml])

  useEffect(() => {
    if (!saveMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!saveMenuRef.current?.contains(event.target as Node)) setSaveMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [saveMenuOpen])

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsavedChanges])

  // Save state
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveSubject, setSaveSubject] = useState('')
  const [savePreviewText, setSavePreviewText] = useState('')
  const [saveFolderId, setSaveFolderId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [saving, setSaving] = useState(false)


  // Edit mode state
  const [editTemplateName, setEditTemplateName] = useState<string | null>(null)
  const [templateLoading, setTemplateLoading] = useState(Boolean(editTemplateId))
  const [templateLoadError, setTemplateLoadError] = useState('')
  const [templateLoadAttempt, setTemplateLoadAttempt] = useState(0)

  // Media picker state
  const [pickerOpen, setPickerOpen] = useState(false)

  // Whether this client has a Brand Story; null until known
  const [hasBrandStory, setHasBrandStory] = useState<boolean | null>(null)

  useEffect(() => {
    if (!selectedClient) return
    let cancelled = false
    setHasBrandStory(null)
    apiFetch(`/api/brand-story?clientId=${selectedClient.id}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled && data) setHasBrandStory(Boolean(data.brand_story?.trim())) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedClient])

  // Fetch template index and folders on mount
  useEffect(() => {
    if (!selectedClient) return
    fetchTemplateIndex()
    fetchFolders()
    fetchStarters()
  }, [selectedClient])

  // Load existing template when editTemplateId is in URL
  useEffect(() => {
    if (!editTemplateId || clientsLoading || (editTemplateId === justSavedId.current?.id && selectedClient?.id === justSavedId.current?.clientId)) return
    let cancelled = false
    setTemplateLoading(true)
    setTemplateLoadError('')
    setCurrentHtml('')
    setSelection(null)
    setEditTemplateName(null)
    const load = async () => {
      try {
        // RLS limits this lookup to templates the signed-in user can access.
        // Resolve the owning client from the draft, not a stale client picker.
        const { data, error } = await supabase.from('templates')
          .select('id, client_id, name, subject, preview_text, html_content')
          .eq('id', editTemplateId)
          .single()
        if (cancelled) return
        if (error || !data) throw new Error('We couldn’t open this draft. Check your connection and try again. If it still won’t open, the draft may have been removed or your account may not have access.')
        const owner = clients.find(client => client.id === data.client_id)
        if (!owner) throw new Error('Your account doesn’t have access to this draft’s client. Sign in with the account you use for that client.')
        if (!data.html_content) throw new Error('This draft has no email content yet.')
        if (selectedClient?.id !== owner.id) setSelectedClient(owner)
        setSavedSnapshot(JSON.stringify([data.html_content, data.subject || '', data.preview_text || '']))
        setCurrentHtml(data.html_content)
        setSelection(null)
        setCurrentSubject(data.subject || '')
        setCurrentPreviewText(data.preview_text || '')
        setEditTemplateName(data.name)
        setMessages([{
          id: 'edit-init', role: 'assistant',
          content: `I've loaded your "${data.name}" template. What would you like to change?`,
          htmlContent: data.html_content, subject: data.subject || '', previewText: data.preview_text || '',
        }])
      } catch (error) {
        if (!cancelled) setTemplateLoadError(error instanceof Error ? error.message : 'We couldn’t open this draft. Please try again.')
      } finally {
        if (!cancelled) setTemplateLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [editTemplateId, selectedClient?.id, clients, clientsLoading, setSelectedClient, templateLoadAttempt])

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  const fetchTemplateIndex = async () => {
    try {
      const response = await apiFetch(`/api/email-builder/templates?clientId=${selectedClient!.id}`)
      if (response.ok) {
        const data = await response.json()
        setTemplateIndex(data.templates || [])
        setSentCampaigns(data.sentCampaigns || [])
      }
    } catch (err) {
      console.error('Failed to fetch template index:', err)
    }
  }

  const fetchFolders = async () => {
    try {
      const { data } = await supabase
        .from('template_folders')
        .select('id, name')
        .eq('client_id', selectedClient!.id)
        .order('name')
      setFolders(data || [])
    } catch (err) {
      console.error('Failed to fetch folders:', err)
    }
  }

  // Starter layouts: proven, Outlook-hardened templates a user can build from.
  const fetchStarters = async () => {
    try {
      const { data } = await supabase
        .from('templates')
        .select('id, name, subject, preview_text, created_at')
        .eq('client_id', selectedClient!.id)
        .eq('is_starter', true)
        .order('name')
      setStarters(data || [])
    } catch (err) {
      console.error('Failed to fetch starters:', err)
    }
  }

  // Load a starter's HTML into the canvas as a NEW draft (does not edit the
  // starter itself) and reference it so the AI preserves its structure.
  const startFromStarter = async (starter: TemplateIndexItem) => {
    try {
      const { data, error } = await supabase
        .from('templates')
        .select('id, name, subject, preview_text, html_content')
        .eq('id', starter.id)
        .eq('client_id', selectedClient!.id)
        .single()
      if (error || !data) return
      setCurrentHtml(data.html_content || '')
      setSelection(null)
      setCurrentSubject(data.subject || '')
      setCurrentPreviewText(data.preview_text || '')
      if (!referenceTemplateIds.includes(data.id)) {
        setReferenceTemplateIds(prev => [...prev, data.id].slice(0, 2))
      }
      setMessages([{
        id: 'starter-init',
        role: 'assistant',
        content: `Started from the "${data.name}" layout — an Outlook-safe base. Tell me what to change (swap the copy, update the product, adjust sections) and I'll keep the structure intact.`,
        htmlContent: data.html_content || undefined, subject: data.subject || '', previewText: data.preview_text || '',
      }])
    } catch (err) {
      console.error('Failed to start from starter:', err)
    }
  }

  const extractJsonFromText = (text: string) => {
    // Look for ```json ... ``` blocks
    const match = text.match(/```json\s*([\s\S]*?)```/)
    if (!match) return null
    try {
      return JSON.parse(match[1])
    } catch {
      return null
    }
  }

  const getConversationalText = (text: string) => {
    // Strip the design block (full JSON or targeted edits) to get just the
    // conversational part. A block still streaming has no closing fence yet,
    // and edits sometimes arrive in a ```html fence or with no fence at all.
    return text.split(/```(?:json|edits)|<<<<<<< FIND/)[0].replace(/```[a-z]*\s*$/, '').trim()
  }

  // `opts` lets the ready-to-send panel send a fix with its own selection,
  // without waiting for state updates to land.
  const handleSend = async (opts?: { text?: string; selection?: PreviewSelection | null }) => {
    const trimmed = (opts?.text ?? input).trim()
    const activeSelection = opts && 'selection' in opts ? opts.selection ?? null : selection
    if (!trimmed || isStreaming || saving || !selectedClient) return

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsStreaming(true)
    setStreamingText('')

    // Build message history for API (last 10 messages). Earlier designs are
    // left out: the current one is sent once as currentEmail, and the AI
    // returns targeted edits against it.
    const allMessages = [...messages, userMessage]
    const apiMessages = allMessages.slice(-10).map(m => ({
      role: m.role,
      content: m.role === 'assistant' && m.htmlContent
        ? `${m.content}\n\n[email design output omitted]`
        : m.content,
    }))

    try {
      const response = await apiFetch('/api/email-builder/chat', {
        method: 'POST',
        body: JSON.stringify({
          clientId: selectedClient.id,
          messages: apiMessages,
          referenceTemplateIds: referenceTemplateIds.length > 0 ? referenceTemplateIds : undefined,
          currentEmail: currentHtml
            ? { html_content: currentHtml, subject: currentSubject, preview_text: currentPreviewText }
            : undefined,
          selection: currentHtml && activeSelection ? activeSelection : undefined,
        }),
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || 'Chat request failed')
      }

      // Clear references after sending
      setReferenceTemplateIds([])

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Streaming not supported')

      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''
      let result: DesignResult | null = null
      let streamError = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.type === 'text') {
                accumulated += data.text
                setStreamingText(accumulated)
              } else if (data.type === 'status') {
                setStreamStatus(data.text)
              } else if (data.type === 'result') {
                result = data as DesignResult
              } else if (data.type === 'error') {
                streamError = data.error || 'Generation failed'
              }
            } catch {
              // ignore parse errors for incomplete chunks
            }
          }
        }
      }

      if (streamError) throw new Error(streamError)

      // Process the complete response. The server resolves targeted edits
      // against the current design; older servers only stream a JSON block.
      const design = result?.design || extractJsonFromText(accumulated)
      const conversationalText = result?.note ?? getConversationalText(accumulated)
      const failed = result?.mode === 'failed'

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: failed
          ? `${conversationalText ? conversationalText + '\n\n' : ''}I couldn’t apply that change cleanly, so the preview is unchanged. Could you try rephrasing it?`
          : conversationalText || (design ? 'Here\'s the updated email design.' : accumulated),
        htmlContent: design?.html_content,
        subject: design?.subject,
        previewText: design?.preview_text,
        editCount: result?.mode === 'edits' ? result.edit_count : undefined,
      }

      setMessages(prev => [...prev, assistantMessage])

      if (design?.html_content) {
        setCurrentHtml(design.html_content)
        setCurrentSubject(design.subject || '')
        setCurrentPreviewText(design.preview_text || '')
        // Keep the same part selected (the server returns its new span) so
        // follow-ups like "a bit more" still apply to it.
        setSelection(prev => (prev && result?.selection ? { ...prev, ...result.selection } : null))
        void runVisualCheck(assistantMessage.id, design.html_content, trimmed, conversationalText)
      }
    } catch (err: any) {
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Something went wrong: ${err.message}. Please try again.`,
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsStreaming(false)
      setStreamingText('')
      setStreamStatus('')
    }
  }

  useEffect(() => {
    if (!currentHtml || !selectedClient) return
    const urls = collectLinkUrls(currentHtml).filter(u => !(u in linkResultsRef.current))
    if (!urls.length) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setCheckingLinks(true)
      try {
        const r = await apiFetch('/api/email-builder/check-links', {
          method: 'POST',
          body: JSON.stringify({ clientId: selectedClient.id, urls }),
        })
        if (r.ok && !cancelled) {
          const data = await r.json()
          setLinkResults(prev => ({ ...prev, ...data.results }))
        }
      } catch {
        // Link health is advisory; the other checks still run.
      } finally {
        if (!cancelled) setCheckingLinks(false)
      }
    }, 1200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [currentHtml, selectedClient])

  // After a change lands, the server renders the email and the AI looks at it.
  const runVisualCheck = async (messageId: string, html: string, request: string, note: string) => {
    const update = (visual: VisualCheck) =>
      setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, visual } : m)))
    update({ status: 'checking' })
    try {
      const r = await apiFetch('/api/email-builder/visual-check', {
        method: 'POST',
        body: JSON.stringify({ clientId: selectedClient?.id, html, request, note }),
      })
      if (!r.ok) throw new Error('unavailable')
      const v = await r.json()
      if (typeof v.looks_right !== 'boolean') throw new Error('unexpected reply')
      update(v.looks_right
        ? { status: 'ok', summary: v.summary }
        : { status: 'issues', summary: v.summary, problems: v.problems })
    } catch {
      update({ status: 'unavailable' })
    }
  }

  const showIssue = (issue: EmailIssue) => {
    if (issue.span) setSelection({ ...issue.span, label: issue.title })
  }

  // A fix prompt goes straight to the AI, scoped to the issue's element when it
  // has one; a fix draft (e.g. "Change this link to: ") waits for the user.
  const fixIssue = (issue: EmailIssue) => {
    const sel = issue.span ? { ...issue.span, label: issue.title } : null
    setSelection(sel)
    if (issue.fixPrompt) {
      handleSend({ text: issue.fixPrompt, selection: sel })
    } else if (issue.fixDraft) {
      setInput(issue.fixDraft)
      requestAnimationFrame(() => {
        const box = inputRef.current
        if (!box) return
        box.focus()
        box.setSelectionRange(box.value.length, box.value.length)
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const addReference = (templateId: string) => {
    if (!referenceTemplateIds.includes(templateId)) {
      setReferenceTemplateIds(prev => [...prev, templateId].slice(0, 2))
    }
    setShowReferencePicker(false)
    setReferenceSearch('')
  }

  const removeReference = (templateId: string) => {
    setReferenceTemplateIds(prev => prev.filter(id => id !== templateId))
  }

  const handleSave = async ({ name = saveName, subject = saveSubject, previewText = savePreviewText, asCopy = saveAsCopy } = {}) => {
    if (!name.trim() || !currentHtml || !selectedClient || isStreaming) return
    setSaving(true)
    setSaveError('')
    try {
      const values = { name: name.trim(), subject, preview_text: previewText,
        html_content: currentHtml, updated_at: new Date().toISOString() }
      const query = editTemplateId && !asCopy
        ? supabase.from('templates').update(values).eq('id', editTemplateId).eq('client_id', selectedClient.id)
        : supabase.from('templates').insert({
            ...values, folder_id: saveFolderId, client_id: selectedClient.id,
            // A new version remembers its source so Polaris revises the newest one.
            source_template_id: editTemplateId && asCopy ? editTemplateId : null,
          })
      const { data, error } = await query.select('id').single()
      if (error || !data) throw error || new Error('No saved draft returned')
      setCurrentSubject(subject)
      setCurrentPreviewText(previewText)
      setSavedSnapshot(JSON.stringify([currentHtml, subject, previewText]))
      setEditTemplateName(name.trim())
      justSavedId.current = { id: data.id, clientId: selectedClient.id }
      setSearchParams({ templateId: data.id }, { replace: true })
      setShowSaveForm(false)
    } catch (err) {
      console.error('Failed to save template:', err)
      setSaveError('Your changes haven’t been saved. Please try again; your preview is still here.')
    } finally {
      setSaving(false)
    }
  }

  // An existing design saves in one click; a brand-new one needs a name first.
  const quickSave = () => {
    if (editTemplateId && editTemplateName) {
      setShowSaveForm(false)
      handleSave({ name: editTemplateName, subject: currentSubject, previewText: currentPreviewText, asCopy: false })
    } else {
      openSaveForm()
    }
  }

  const openSaveForm = (asCopy = false) => {
    setSaveMenuOpen(false)
    setSaveAsCopy(asCopy)
    setSaveName((editTemplateName || currentSubject || 'Untitled Email') + (asCopy ? ' — new version' : ''))
    setSaveSubject(currentSubject)
    setSavePreviewText(currentPreviewText)
    setSaveFolderId(null)
    setSaveError('')
    setShowSaveForm(true)
  }

  const filteredTemplates = templateIndex.filter(t =>
    t.name.toLowerCase().includes(referenceSearch.toLowerCase()) ||
    t.subject.toLowerCase().includes(referenceSearch.toLowerCase())
  )

  const referencedTemplateNames = referenceTemplateIds.map(id => {
    const t = templateIndex.find(t => t.id === id)
    return t ? t.name : id
  })

  if (editTemplateId && (templateLoading || clientsLoading || templateLoadError)) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center" role="status">
        {templateLoadError ? (
          <>
            <AlertTriangle className="h-8 w-8 text-amber-600 mb-3" />
            <h1 className="text-lg font-semibold text-gray-900 mb-2">Unable to open draft</h1>
            <p className="text-gray-600 max-w-lg mb-4">{templateLoadError}</p>
            <div className="flex gap-3">
              <Button onClick={() => setTemplateLoadAttempt(attempt => attempt + 1)}>Try again</Button>
              <Button variant="secondary" onClick={() => navigate('/templates')}>Back to Email Designs</Button>
            </div>
          </>
        ) : (
          <><Loader2 className="h-7 w-7 animate-spin text-blue-600 mb-3" /><p>Opening your draft…</p></>
        )}
      </div>
    )
  }

  if (!selectedClient) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please select a client first.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[650px]">
      {/* Top Bar */}
      <div className="flex flex-wrap gap-3 items-center justify-between px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/templates')}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Email Designs
          </button>
          {editTemplateName && (
            <span className="text-sm text-gray-500">
              Editing: <span className="font-medium text-gray-800">{editTemplateName}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span role="status" className={cn('text-xs font-medium', hasUnsavedChanges ? 'text-amber-700' : 'text-green-700')}>
            {saving ? 'Saving…' : isStreaming ? 'Updating preview…' : !currentHtml ? 'No draft yet' : hasUnsavedChanges ? 'Unsaved changes' : 'Draft saved'}
          </span>
          {complianceWarnings.length > 0 && (
            <div className="flex items-center gap-1 text-amber-600 text-xs">
              <AlertTriangle className="h-3.5 w-3.5" />
              {complianceWarnings.join(', ')}
            </div>
          )}
          <div ref={saveMenuRef} className="relative flex">
            <Button
              variant="primary"
              size="sm"
              onClick={quickSave}
              disabled={!currentHtml || isStreaming || saving || (Boolean(editTemplateId) && !hasUnsavedChanges)}
              className={editTemplateId ? 'rounded-r-none' : undefined}
            >
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
              Save
            </Button>
            {editTemplateId && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setSaveMenuOpen(o => !o)}
                disabled={!currentHtml || isStreaming || saving}
                className="rounded-l-none border-l border-blue-400 px-2"
                aria-label="More save options"
                aria-expanded={saveMenuOpen}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            )}
            {saveMenuOpen && (
              <div role="menu" className="absolute right-0 top-full mt-1 z-20 w-64 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
                <button type="button" role="menuitem" onClick={() => openSaveForm(true)} className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50">
                  <span className="font-medium text-gray-900">Save as a new version…</span>
                  <span className="block text-xs text-gray-500">Keeps this one as it is</span>
                </button>
                <button type="button" role="menuitem" onClick={() => openSaveForm()} className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50">
                  <span className="font-medium text-gray-900">Rename or edit subject…</span>
                  <span className="block text-xs text-gray-500">Name, subject and preview text</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {saveError && <p role="alert" className="px-4 py-3 text-sm text-red-800 bg-red-50">{saveError}</p>}
      {/* Save Form (inline, slides down) */}
      {showSaveForm && (
        <div className="px-4 py-3 bg-blue-50 border-b border-blue-200 flex-shrink-0">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Draft name *</label>
              <input
                type="text"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Subject</label>
              <input
                type="text"
                value={saveSubject}
                onChange={e => setSaveSubject(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Preview Text</label>
              <input
                type="text"
                value={savePreviewText}
                onChange={e => setSavePreviewText(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              />
            </div>
            {(!editTemplateId || saveAsCopy) && (
              <div className="w-40">
                <label className="block text-xs font-medium text-gray-700 mb-1">Folder</label>
                <select
                  value={saveFolderId || ''}
                  onChange={e => setSaveFolderId(e.target.value || null)}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                >
                  <option value="">Unfiled</option>
                  {folders.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            )}
            <Button size="sm" onClick={() => handleSave()} disabled={saving || isStreaming || !saveName.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saveAsCopy ? 'Save new version' : 'Save'}
            </Button>
            <button onClick={() => setShowSaveForm(false)} className="text-gray-400 hover:text-gray-600 pb-1">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content: Chat + Preview */}
      <div className="flex flex-1 min-h-0">
        {/* Chat Panel */}
        <div className={cn('w-[38%] min-w-[340px] max-w-[520px] flex-shrink-0 flex flex-col border-r border-gray-200 bg-white', chatHidden && 'hidden')}>
          <details className="px-4 py-3 border-b border-gray-200 text-sm">
            <summary className="cursor-pointer font-medium text-gray-800">In this preview · {previewImages.length} image{previewImages.length === 1 ? '' : 's'}</summary>
            <div className="mt-2 max-h-40 overflow-auto space-y-1 text-xs text-gray-600">
              <p>{currentHtml ? 'Email design loaded' : 'No email design yet'}</p>
              {previewImages.map((img, i) => <p key={i} className={img.needsSource ? 'text-amber-700' : ''}>{img.name} · {img.needsSource ? 'Needs an image link' : 'Image linked'}</p>)}
              <button onClick={() => setPickerOpen(true)} className="text-blue-700 hover:underline">Open image library</button>
              <p>Files sent by email are collected in that email thread. Images included in a saved draft appear here.</p>
            </div>
          </details>
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Welcome message */}
            {messages.length === 0 && !isStreaming && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                  <span className="text-purple-600 text-sm font-medium">AI</span>
                </div>
                <div className="flex-1 bg-gray-50 rounded-lg p-3 text-sm text-gray-700">
                  <p>Hi! I'm your email design assistant. I can help you create or refine HTML email designs that work across email clients.</p>
                  <p className="mt-2">You can:</p>
                  <ul className="mt-1 ml-4 list-disc space-y-1">
                    <li>Describe what you want and I'll build it</li>
                    <li>Reference a previous email as a starting point</li>
                    <li>Iterate on the current design ("make the button bigger", "change the colors")</li>
                  </ul>
                  <p className="mt-2">What would you like to build?</p>
                  {hasBrandStory === false && (
                    <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                      Tip: <Link to="/brand-story" className="font-medium underline">tell me {selectedClient?.name}’s story</Link> first, and every email will start out sounding like you.
                    </p>
                  )}
                  {hasBrandStory && (
                    <p className="mt-2 text-xs text-gray-500">Using {selectedClient?.name}’s <Link to="/brand-story" className="underline">Brand Story</Link>.</p>
                  )}
                  {starters.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <p className="text-xs font-medium text-gray-500 mb-2">Start from a layout</p>
                      <div className="flex flex-wrap gap-2">
                        {starters.map(s => (
                          <button
                            key={s.id}
                            onClick={() => startFromStarter(s)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 bg-purple-50 border border-purple-200 rounded-full text-xs text-purple-700 hover:bg-purple-100 transition-colors"
                            title={s.subject || s.name}
                          >
                            <LayoutTemplate className="h-3 w-3" />
                            {s.name.length > 32 ? s.name.substring(0, 32) + '…' : s.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Chat messages */}
            {messages.map(msg => (
              <div key={msg.id} className={cn('flex gap-3', msg.role === 'user' && 'flex-row-reverse')}>
                <div className={cn(
                  'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
                  msg.role === 'assistant' ? 'bg-purple-100' : 'bg-blue-100'
                )}>
                  <span className={cn(
                    'text-sm font-medium',
                    msg.role === 'assistant' ? 'text-purple-600' : 'text-blue-600'
                  )}>
                    {msg.role === 'assistant' ? 'AI' : 'You'}
                  </span>
                </div>
                <div className={cn(
                  'flex-1 rounded-lg p-3 text-sm max-w-[85%]',
                  msg.role === 'assistant' ? 'bg-gray-50 text-gray-700' : 'bg-blue-50 text-blue-900'
                )}>
                  {msg.role === 'assistant'
                    ? <ChatMarkdown content={msg.content} />
                    : <div className="whitespace-pre-wrap">{msg.content}</div>}
                  {msg.htmlContent && (
                    <div className="mt-2 text-xs text-green-600 font-medium">
                      {msg.editCount ? <span className="mr-2 text-gray-500">Quick edit · {msg.editCount} change{msg.editCount === 1 ? '' : 's'}</span> : null}
                      {msg.htmlContent === currentHtml ? 'Current preview' : <button disabled={isStreaming || saving} onClick={() => {
                        setCurrentHtml(msg.htmlContent!)
                        setSelection(null)
                        setCurrentSubject(msg.subject || '')
                        setCurrentPreviewText(msg.previewText || '')
                        setMessages(prev => [...prev, { ...msg, visual: undefined, id: crypto.randomUUID(), content: 'Restored this earlier preview. Save it to keep these changes.' }])
                      }} className="text-blue-700 underline disabled:opacity-50">Restore this preview</button>}
                    </div>
                  )}
                  {msg.visual?.status === 'checking' && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-gray-400">
                      <Loader2 className="h-3 w-3 animate-spin" /> Checking how it looks…
                    </p>
                  )}
                  {msg.visual?.status === 'ok' && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-green-700" title={msg.visual.summary}>
                      <CheckCircle2 className="h-3 w-3" /> Looked at the result: it looks right
                    </p>
                  )}
                  {msg.visual?.status === 'issues' && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                      <p className="flex items-center gap-1 font-medium"><Eye className="h-3 w-3" /> Looking at the result, I noticed:</p>
                      <ul className="mt-1 ml-4 list-disc space-y-0.5">
                        {msg.visual.problems?.map((p, i) => <li key={i}><span className="font-medium">{p.where}:</span> {p.problem}</li>)}
                      </ul>
                      <button
                        disabled={isStreaming || saving}
                        onClick={() => handleSend({
                          text: `Fix these visual problems: ${msg.visual!.problems!.map(p => `${p.where}: ${p.problem}`).join('; ')}`,
                          selection: null,
                        })}
                        className="mt-1.5 rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                      >
                        Fix these
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Streaming indicator */}
            {isStreaming && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                  <span className="text-purple-600 text-sm font-medium">AI</span>
                </div>
                <div className="flex-1 bg-gray-50 rounded-lg p-3 text-sm text-gray-700">
                  {streamingText ? (
                    <div>
                      <ChatMarkdown content={getConversationalText(streamingText)} />
                      {streamStatus ? (
                        <span className="mt-1 block text-xs text-purple-500">{streamStatus}</span>
                      ) : /```edits|<<<<<<< FIND/.test(streamingText) ? (
                        <span className="mt-1 block text-xs text-purple-500">applying changes...</span>
                      ) : streamingText.includes('```json') && (
                        <span className="mt-1 block text-xs text-purple-500">generating HTML...</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-gray-400">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Thinking...
                    </div>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Reference chips */}
          {referenceTemplateIds.length > 0 && (
            <div className="px-4 pt-2 flex gap-2 flex-wrap">
              {referencedTemplateNames.map((name, i) => (
                <span key={referenceTemplateIds[i]} className="inline-flex items-center gap-1 px-2 py-1 bg-purple-50 border border-purple-200 rounded-full text-xs text-purple-700">
                  <Paperclip className="h-3 w-3" />
                  {name.length > 30 ? name.substring(0, 30) + '...' : name}
                  <button onClick={() => removeReference(referenceTemplateIds[i])} className="hover:text-purple-900">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Input Area */}
          <div className="p-4 border-t border-gray-200 flex-shrink-0">
            {/* Reference picker */}
            {showReferencePicker && (
              <div className="mb-3 border border-gray-200 rounded-lg shadow-lg bg-white max-h-60 overflow-y-auto">
                <div className="p-2 border-b border-gray-100">
                  <input
                    type="text"
                    placeholder="Search templates..."
                    value={referenceSearch}
                    onChange={e => setReferenceSearch(e.target.value)}
                    className="w-full px-2 py-1 text-sm border border-gray-200 rounded"
                    autoFocus
                  />
                </div>
                {filteredTemplates.length === 0 ? (
                  <div className="p-3 text-sm text-gray-400 text-center">No templates found</div>
                ) : (
                  filteredTemplates.map(t => (
                    <button
                      key={t.id}
                      onClick={() => addReference(t.id)}
                      className="w-full px-3 py-2 text-left hover:bg-gray-50 border-b border-gray-50 last:border-0"
                    >
                      <div className="text-sm font-medium text-gray-800 truncate">{t.name}</div>
                      <div className="text-xs text-gray-500 truncate">{t.subject}</div>
                    </button>
                  ))
                )}
              </div>
            )}

            {selection && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-purple-200 bg-purple-50 px-2 py-1 text-xs text-purple-800">
                <MousePointerClick className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Editing: <span className="font-medium">{selection.label}</span></span>
                <button onClick={() => setSelection(null)} className="ml-auto text-purple-500 hover:text-purple-800" aria-label="Clear selection" title="Edit the whole email instead">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setShowReferencePicker(!showReferencePicker)}
                className={cn(
                  'flex-shrink-0 p-2 rounded-md border transition-colors',
                  showReferencePicker
                    ? 'border-purple-300 bg-purple-50 text-purple-600'
                    : 'border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300'
                )}
                title="Reference a previous email"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label="Newsletter instructions"
                placeholder={selection ? 'What should change in this part?' : 'Describe what you want to build or change...'}
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                rows={2}
                disabled={isStreaming || saving}
              />
              <button
                aria-label="Send instructions"
                onClick={() => handleSend()}
                disabled={!input.trim() || isStreaming || saving}
                className={cn(
                  'flex-shrink-0 p-2 rounded-md transition-colors',
                  input.trim() && !isStreaming
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                )}
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-400">Enter to send, Shift+Enter for new line{currentHtml && !selection ? ' · Click part of the preview to edit just that part' : ''}</p>
          </div>
        </div>

        {/* Preview Panel */}
        <div className="flex-1 min-w-0 flex flex-col bg-gray-100">
          {/* Preview Header */}
          <div className="px-4 py-3 bg-white border-b border-gray-200 flex items-center justify-between flex-shrink-0">
            <div className="min-w-0 flex-1">
              {currentSubject ? (
                <>
                  <div className="text-sm font-medium text-gray-900 truncate">
                    Subject: {currentSubject}
                  </div>
                  {currentPreviewText && (
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      Preview: {currentPreviewText}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-gray-400">Email preview will appear here</div>
              )}
            </div>
            <div className="flex items-center gap-1 ml-4 flex-shrink-0">
              {currentHtml && (
                <ReadyToSendPanel issues={issues} busy={isStreaming || saving} checkingLinks={checkingLinks} onShow={showIssue} onFix={fixIssue} />
              )}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="px-2 py-1 hover:bg-gray-100 rounded flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                title="Insert image (copies URL to clipboard)"
              >
                <ImageIcon className="w-4 h-4" />
                Images
              </button>
              <div className="w-px h-5 bg-gray-200 mx-1" />
              <button
                type="button"
                onClick={() => setChatHidden(h => !h)}
                className="px-2 py-1 hover:bg-gray-100 rounded flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                title={chatHidden ? 'Show the chat' : 'Hide the chat to give the preview more room'}
              >
                {chatHidden ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
                {chatHidden ? 'Show chat' : 'Hide chat'}
              </button>
              <button
                onClick={() => setPreviewMode('desktop')}
                className={cn(
                  'p-1.5 rounded transition-colors',
                  previewMode === 'desktop'
                    ? 'bg-gray-200 text-gray-800'
                    : 'text-gray-400 hover:text-gray-600'
                )}
                title="Desktop preview"
              >
                <Monitor className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPreviewMode('mobile')}
                className={cn(
                  'p-1.5 rounded transition-colors',
                  previewMode === 'mobile'
                    ? 'bg-gray-200 text-gray-800'
                    : 'text-gray-400 hover:text-gray-600'
                )}
                title="Mobile preview"
              >
                <Smartphone className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Preview Content */}
          <div className="flex-1 overflow-auto p-4">
            {currentHtml ? (
              <div
                className={cn(
                  'mx-auto bg-white shadow-sm rounded-lg overflow-hidden transition-all duration-300',
                  previewMode === 'desktop' ? 'w-[620px]' : 'w-[395px]'
                )}
              >
                <SelectablePreview
                  html={currentHtml}
                  selection={selection}
                  onSelect={setSelection}
                  layoutKey={previewMode}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-gray-400 h-full">
                <Monitor className="h-16 w-16 mb-4 opacity-30" />
                <p className="text-sm">Start a conversation to generate an email</p>
                <p className="text-xs mt-1">Your email preview will appear here</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedClient && (
        <MediaPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          clientId={selectedClient.id}
          onSelect={url => { setInput(previous => `${previous}${previous ? '\n' : ''}Use this image: ${url}`); inputRef.current?.focus() }}
        />
      )}
    </div>
  )
}
