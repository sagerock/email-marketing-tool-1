import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Plus, Save, Send, Sparkles, Trash2, Image as ImageIcon } from 'lucide-react'
import { useClient } from '../context/ClientContext'
import { apiFetch } from '../lib/api'
import Button from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import ChatMarkdown from '../components/ui/ChatMarkdown'
import MediaPicker from '../components/media/MediaPicker'
import { cn } from '../lib/utils'

interface BrandColor { name?: string; hex: string }
interface BrandLook { logo_url?: string; colors?: BrandColor[]; fonts?: string; website?: string }
interface InterviewMessage { role: 'user' | 'assistant'; content: string }
interface Draft { brand_story: string; brand_look: BrandLook | null }

const PROMPTS = [
  'Who you are, and where',
  'Who you’re writing to, and what they care about',
  'How your emails should feel, and how they never should',
  'Words and phrases you love, or avoid',
]

export default function BrandStory() {
  const { selectedClient } = useClient()
  const clientId = selectedClient?.id || ''

  const [story, setStory] = useState('')
  const [look, setLook] = useState<BrandLook>({})
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  const [interview, setInterview] = useState<InterviewMessage[]>([])
  const [interviewInput, setInterviewInput] = useState('')
  const [interviewing, setInterviewing] = useState(false)
  const [interviewError, setInterviewError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const interviewEndRef = useRef<HTMLDivElement>(null)

  const snapshot = JSON.stringify({ story: story.trim(), look })
  const dirty = !loading && snapshot !== savedSnapshot

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    setInterview([])
    setDraft(null)
    setSaveMessage('')
    apiFetch(`/api/brand-story?clientId=${clientId}`)
      .then(async r => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error || 'Could not load the brand story')
        if (cancelled) return
        const loadedLook: BrandLook = data.brand_look || {}
        setStory(data.brand_story || '')
        setLook(loadedLook)
        setSavedSnapshot(JSON.stringify({ story: (data.brand_story || '').trim(), look: loadedLook }))
        setUpdatedAt(data.brand_story_updated_at)
      })
      .catch(err => { if (!cancelled) setLoadError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [clientId])

  useEffect(() => {
    interviewEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [interview, interviewing])

  const save = async () => {
    setSaving(true)
    setSaveMessage('')
    try {
      const r = await apiFetch('/api/brand-story', {
        method: 'PUT',
        body: JSON.stringify({ clientId, brand_story: story, brand_look: look }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Save failed')
      const savedLook: BrandLook = data.brand_look || {}
      setStory(data.brand_story || '')
      setLook(savedLook)
      setSavedSnapshot(JSON.stringify({ story: (data.brand_story || '').trim(), look: savedLook }))
      setUpdatedAt(data.brand_story_updated_at)
      setSaveMessage('Saved. The email builder will use this from now on.')
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const sendInterview = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || interviewing) return
    const next: InterviewMessage[] = [...interview, { role: 'user', content: trimmed }]
    setInterview(next)
    setInterviewInput('')
    setInterviewing(true)
    setInterviewError('')
    try {
      const r = await apiFetch('/api/brand-story/interview', {
        method: 'POST',
        body: JSON.stringify({ clientId, messages: next }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'The interview hit a snag')
      setInterview([...next, { role: 'assistant', content: data.reply || 'Here’s a draft.' }])
      if (data.draft) setDraft(data.draft)
    } catch (err) {
      setInterviewError(err instanceof Error ? err.message : 'The interview hit a snag')
    } finally {
      setInterviewing(false)
    }
  }

  const applyDraft = () => {
    if (!draft) return
    if (story.trim() && !confirm('Replace the story in the box with this draft? Nothing is saved until you click Save.')) return
    setStory(draft.brand_story)
    if (draft.brand_look) {
      // Keep the chosen logo; take the interview's colors, fonts, and website where it has them.
      setLook(prev => ({ ...prev, ...draft.brand_look, logo_url: prev.logo_url }))
    }
    setDraft(null)
  }

  const colors = look.colors || []
  const setColor = (i: number, patch: Partial<BrandColor>) =>
    setLook(prev => ({ ...prev, colors: (prev.colors || []).map((c, n) => (n === i ? { ...c, ...patch } : c)) }))

  if (!selectedClient) {
    return <div className="p-6 text-gray-500">Select a client to tell its story.</div>
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Brand Story</h1>
          <p className="text-sm text-gray-600 max-w-2xl">
            Tell the story of {selectedClient.name}. The <Link to="/email-builder" className="text-blue-700 hover:underline">email builder</Link> reads
            this before every email, so it knows who you are and how your emails should feel.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saveMessage && <span className={cn('text-sm', saveMessage.startsWith('Saved') ? 'text-green-700' : 'text-red-600')}>{saveMessage}</span>}
          {dirty && !saveMessage && <span className="text-sm text-amber-700">Unsaved changes</span>}
          <Button onClick={save} disabled={saving || loading || !dirty}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save
          </Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card>
            <CardHeader><CardTitle>Your story</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm text-gray-600">
                <p>Write it the way you’d tell a new teacher or a visiting family. A few things worth covering:</p>
                <ul className="mt-1 ml-5 list-disc">
                  {PROMPTS.map(p => <li key={p}>{p}</li>)}
                </ul>
                <p className="mt-1">Not sure where to start? Try <span className="font-medium">Interview me</span> on the right.</p>
              </div>
              <textarea
                value={story}
                onChange={e => { setStory(e.target.value); setSaveMessage('') }}
                disabled={loading}
                rows={16}
                placeholder={loading ? 'Loading…' : `${selectedClient.name} is…`}
                className="w-full rounded-md border border-gray-300 p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500">
                {story.length.toLocaleString()} / 20,000 characters
                {updatedAt && ` · Last saved ${new Date(updatedAt).toLocaleString()}`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>The look <span className="text-sm font-normal text-gray-500">(optional)</span></CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Logo</p>
                <div className="flex items-center gap-3">
                  {look.logo_url
                    ? <img src={look.logo_url} alt="Logo" className="h-16 max-w-[200px] object-contain rounded border border-gray-200 bg-white p-1" />
                    : <div className="h-16 w-32 rounded border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400">No logo</div>}
                  <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    <ImageIcon className="h-4 w-4 mr-1" /> {look.logo_url ? 'Change' : 'Choose from Media'}
                  </Button>
                  {look.logo_url && (
                    <Button variant="ghost" size="sm" onClick={() => { setLook(prev => ({ ...prev, logo_url: undefined })); setSaveMessage('') }}>Remove</Button>
                  )}
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Colors</p>
                <div className="space-y-2">
                  {colors.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#000000'}
                        onChange={e => { setColor(i, { hex: e.target.value.toUpperCase() }); setSaveMessage('') }}
                        className="h-9 w-10 cursor-pointer rounded border border-gray-300 bg-white p-0.5"
                        aria-label="Pick color"
                      />
                      <input
                        value={c.hex}
                        onChange={e => { setColor(i, { hex: e.target.value }); setSaveMessage('') }}
                        className="h-9 w-28 rounded-md border border-gray-300 px-2 font-mono text-sm"
                        aria-label="Hex code"
                      />
                      <input
                        value={c.name || ''}
                        onChange={e => { setColor(i, { name: e.target.value }); setSaveMessage('') }}
                        placeholder="What it’s for, e.g. Forest green, buttons"
                        className="h-9 flex-1 rounded-md border border-gray-300 px-2 text-sm"
                      />
                      <button
                        onClick={() => { setLook(prev => ({ ...prev, colors: (prev.colors || []).filter((_, n) => n !== i) })); setSaveMessage('') }}
                        className="text-gray-400 hover:text-red-600"
                        aria-label="Remove color"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  {colors.length < 8 && (
                    <Button variant="outline" size="sm" onClick={() => setLook(prev => ({ ...prev, colors: [...(prev.colors || []), { hex: '#2D5016' }] }))}>
                      <Plus className="h-4 w-4 mr-1" /> Add a color
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Fonts</span>
                  <input
                    value={look.fonts || ''}
                    onChange={e => { setLook(prev => ({ ...prev, fonts: e.target.value })); setSaveMessage('') }}
                    placeholder="e.g. Georgia headings, Arial body"
                    className="mt-1 h-9 w-full rounded-md border border-gray-300 px-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Website</span>
                  <input
                    value={look.website || ''}
                    onChange={e => { setLook(prev => ({ ...prev, website: e.target.value })); setSaveMessage('') }}
                    placeholder="https://"
                    className="mt-1 h-9 w-full rounded-md border border-gray-300 px-2 text-sm"
                  />
                </label>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-2 flex flex-col lg:max-h-[calc(100vh-10rem)] lg:sticky lg:top-6">
          <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-purple-600" /> Interview me</CardTitle></CardHeader>
          <CardContent className="flex flex-1 flex-col min-h-0 gap-3">
            <div className="flex-1 min-h-[16rem] overflow-y-auto space-y-3">
              {interview.length === 0 && (
                <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
                  <p>I’ll ask a few questions about {selectedClient.name}, then write a first draft of your story for you to edit.</p>
                  <Button className="mt-3" size="sm" onClick={() => sendInterview(story.trim() ? 'Help me improve the story I have.' : 'Interview me, please.')} disabled={loading || interviewing}>
                    <Sparkles className="h-4 w-4 mr-1" /> {story.trim() ? 'Help me improve it' : 'Start the interview'}
                  </Button>
                </div>
              )}
              {interview.map((m, i) => (
                <div key={i} className={cn('rounded-lg p-3 text-sm', m.role === 'assistant' ? 'bg-gray-50 text-gray-700' : 'bg-blue-50 text-blue-900 ml-8')}>
                  {m.role === 'assistant' ? <ChatMarkdown content={m.content} /> : <div className="whitespace-pre-wrap">{m.content}</div>}
                </div>
              ))}
              {interviewing && (
                <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Thinking…</div>
              )}
              {draft && (
                <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm">
                  <p className="font-medium text-purple-900">Draft story ready</p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-gray-700">{draft.brand_story}</p>
                  {draft.brand_look?.colors?.length ? (
                    <div className="mt-2 flex gap-1">
                      {draft.brand_look.colors.map(c => <span key={c.hex} title={`${c.name || ''} ${c.hex}`} className="h-5 w-5 rounded border border-white shadow-sm" style={{ backgroundColor: c.hex }} />)}
                    </div>
                  ) : null}
                  <Button className="mt-2" size="sm" onClick={applyDraft}>Use this draft</Button>
                  <p className="mt-1 text-xs text-gray-500">Puts it in the story box to edit. Nothing saves until you click Save.</p>
                </div>
              )}
              {interviewError && <p className="text-sm text-red-600">{interviewError}</p>}
              <div ref={interviewEndRef} />
            </div>
            {interview.length > 0 && (
              <div className="flex gap-2">
                <textarea
                  value={interviewInput}
                  onChange={e => setInterviewInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInterview(interviewInput) } }}
                  rows={2}
                  placeholder="Answer here… (Enter to send)"
                  className="flex-1 resize-none rounded-md border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <Button onClick={() => sendInterview(interviewInput)} disabled={interviewing || !interviewInput.trim()} aria-label="Send">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        clientId={clientId}
        onSelect={url => { setLook(prev => ({ ...prev, logo_url: url })); setSaveMessage('') }}
      />
    </div>
  )
}
