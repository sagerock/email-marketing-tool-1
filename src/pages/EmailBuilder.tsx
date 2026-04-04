import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClient } from '../context/ClientContext'
import { apiFetch } from '../lib/api'
import { supabase } from '../lib/supabase'
import Button from '../components/ui/Button'
import { ArrowLeft, Send, Monitor, Smartphone, Save, Paperclip, X, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  htmlContent?: string
  subject?: string
  previewText?: string
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
  const { selectedClient } = useClient()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')

  // Preview state
  const [currentHtml, setCurrentHtml] = useState('')
  const [currentSubject, setCurrentSubject] = useState('')
  const [currentPreviewText, setCurrentPreviewText] = useState('')
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop')

  // Template reference state
  const [templateIndex, setTemplateIndex] = useState<TemplateIndexItem[]>([])
  const [, setSentCampaigns] = useState<SentCampaignItem[]>([])
  const [referenceTemplateIds, setReferenceTemplateIds] = useState<string[]>([])
  const [showReferencePicker, setShowReferencePicker] = useState(false)
  const [referenceSearch, setReferenceSearch] = useState('')

  // Save state
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveSubject, setSaveSubject] = useState('')
  const [savePreviewText, setSavePreviewText] = useState('')
  const [saveFolderId, setSaveFolderId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [saving, setSaving] = useState(false)

  // CAN-SPAM warnings
  const [complianceWarnings, setComplianceWarnings] = useState<string[]>([])

  // Fetch template index and folders on mount
  useEffect(() => {
    if (!selectedClient) return
    fetchTemplateIndex()
    fetchFolders()
  }, [selectedClient])

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  // Check CAN-SPAM compliance when HTML updates
  useEffect(() => {
    if (!currentHtml) {
      setComplianceWarnings([])
      return
    }
    const htmlLower = currentHtml.toLowerCase()
    const warnings: string[] = []
    if (!htmlLower.includes('{{unsubscribe_url}}')) {
      warnings.push('Missing {{unsubscribe_url}}')
    }
    if (!htmlLower.includes('{{mailing_address}}')) {
      warnings.push('Missing {{mailing_address}}')
    }
    setComplianceWarnings(warnings)
  }, [currentHtml])

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
    // Strip the JSON block to get just the conversational part
    return text.replace(/```json\s*[\s\S]*?```/, '').trim()
  }

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming || !selectedClient) return

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsStreaming(true)
    setStreamingText('')

    // Build message history for API (last 10 messages)
    const allMessages = [...messages, userMessage]
    const apiMessages = allMessages.slice(-10).map(m => ({
      role: m.role,
      content: m.role === 'assistant'
        ? (m.htmlContent ? `${m.content}\n\n\`\`\`json\n${JSON.stringify({ subject: m.subject, preview_text: m.previewText, html_content: m.htmlContent })}\n\`\`\`` : m.content)
        : m.content,
    }))

    try {
      const response = await apiFetch('/api/email-builder/chat', {
        method: 'POST',
        body: JSON.stringify({
          clientId: selectedClient.id,
          messages: apiMessages,
          referenceTemplateIds: referenceTemplateIds.length > 0 ? referenceTemplateIds : undefined,
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
              } else if (data.type === 'error') {
                throw new Error(data.error)
              }
            } catch (e: any) {
              if (e.message === 'Generation failed') throw e
              // ignore parse errors for incomplete chunks
            }
          }
        }
      }

      // Process the complete response
      const jsonData = extractJsonFromText(accumulated)
      const conversationalText = getConversationalText(accumulated)

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: conversationalText || (jsonData ? 'Here\'s the updated email design.' : accumulated),
        htmlContent: jsonData?.html_content,
        subject: jsonData?.subject,
        previewText: jsonData?.preview_text,
      }

      setMessages(prev => [...prev, assistantMessage])

      if (jsonData?.html_content) {
        setCurrentHtml(jsonData.html_content)
        setCurrentSubject(jsonData.subject || '')
        setCurrentPreviewText(jsonData.preview_text || '')
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

  const handleSave = async () => {
    if (!saveName || !currentHtml || !selectedClient) return
    setSaving(true)
    try {
      const { error } = await supabase.from('templates').insert({
        name: saveName,
        subject: saveSubject,
        preview_text: savePreviewText,
        html_content: currentHtml,
        folder_id: saveFolderId,
        client_id: selectedClient.id,
      })
      if (error) throw error
      setShowSaveForm(false)
      navigate('/templates')
    } catch (err) {
      console.error('Failed to save template:', err)
      alert('Failed to save template')
    } finally {
      setSaving(false)
    }
  }

  const openSaveForm = () => {
    setSaveName(currentSubject || 'Untitled Email')
    setSaveSubject(currentSubject)
    setSavePreviewText(currentPreviewText)
    setSaveFolderId(null)
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

  if (!selectedClient) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please select a client first.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <button
          onClick={() => navigate('/templates')}
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Email Designs
        </button>
        <div className="flex items-center gap-2">
          {complianceWarnings.length > 0 && (
            <div className="flex items-center gap-1 text-amber-600 text-xs">
              <AlertTriangle className="h-3.5 w-3.5" />
              {complianceWarnings.join(', ')}
            </div>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={openSaveForm}
            disabled={!currentHtml}
          >
            <Save className="h-4 w-4 mr-1" />
            Save as Template
          </Button>
        </div>
      </div>

      {/* Save Form (inline, slides down) */}
      {showSaveForm && (
        <div className="px-4 py-3 bg-blue-50 border-b border-blue-200 flex-shrink-0">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Template Name *</label>
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
            <Button size="sm" onClick={handleSave} disabled={saving || !saveName}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
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
        <div className="w-[45%] flex flex-col border-r border-gray-200 bg-white">
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Welcome message */}
            {messages.length === 0 && !isStreaming && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                  <span className="text-purple-600 text-sm font-medium">AI</span>
                </div>
                <div className="flex-1 bg-gray-50 rounded-lg p-3 text-sm text-gray-700">
                  <p>Hi! I'm your email design assistant. I can help you create or refine HTML email designs that render perfectly across all email clients.</p>
                  <p className="mt-2">You can:</p>
                  <ul className="mt-1 ml-4 list-disc space-y-1">
                    <li>Describe what you want and I'll build it</li>
                    <li>Reference a previous email as a starting point</li>
                    <li>Iterate on the current design ("make the button bigger", "change the colors")</li>
                  </ul>
                  <p className="mt-2">What would you like to build?</p>
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
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {msg.htmlContent && (
                    <div className="mt-2 text-xs text-green-600 font-medium">
                      Preview updated
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
                    <div className="whitespace-pre-wrap">
                      {getConversationalText(streamingText) || streamingText.substring(0, 500)}
                      {streamingText.includes('```json') && (
                        <span className="text-xs text-purple-500 ml-1">generating HTML...</span>
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
                placeholder="Describe what you want to build or change..."
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                rows={2}
                disabled={isStreaming}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isStreaming}
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
            <p className="mt-1 text-xs text-gray-400">Enter to send, Shift+Enter for new line</p>
          </div>
        </div>

        {/* Preview Panel */}
        <div className="w-[55%] flex flex-col bg-gray-100">
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
          <div className="flex-1 overflow-auto p-4 flex justify-center">
            {currentHtml ? (
              <div
                className={cn(
                  'bg-white shadow-sm rounded-lg overflow-hidden transition-all duration-300',
                  previewMode === 'desktop' ? 'w-[620px]' : 'w-[395px]'
                )}
              >
                <iframe
                  srcDoc={currentHtml}
                  className="w-full border-0"
                  style={{ height: '800px' }}
                  title="Email preview"
                  sandbox="allow-same-origin"
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
    </div>
  )
}
