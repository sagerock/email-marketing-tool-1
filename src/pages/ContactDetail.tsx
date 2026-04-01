import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Contact, ContactNote, NoteType } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import ContactHeader from '../components/contact/ContactHeader'
import ActivityTimeline from '../components/contact/ActivityTimeline'
import TasksSection from '../components/contact/TasksSection'
import CustomFieldsEditor from '../components/contact/CustomFieldsEditor'
import {
  Eye, MousePointer, Zap, Clock,
  MessageSquare, Mail, Phone, Calendar,
  Loader2, AlertCircle,
} from 'lucide-react'

type Tab = 'overview' | 'activity' | 'notes' | 'details'

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { selectedClient } = useClient()

  const [contact, setContact] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  // Notes state
  const [notes, setNotes] = useState<ContactNote[]>([])
  const [loadingNotes, setLoadingNotes] = useState(false)
  const [noteContent, setNoteContent] = useState('')
  const [noteType, setNoteType] = useState<NoteType>('note')
  const [submittingNote, setSubmittingNote] = useState(false)

  useEffect(() => {
    if (id && selectedClient) {
      fetchContact()
      fetchNotes()
    }
  }, [id, selectedClient])

  const fetchContact = async () => {
    if (!id || !selectedClient) return
    setLoading(true)
    setError(null)

    try {
      const { data, error: fetchError } = await supabase
        .from('contacts')
        .select('*')
        .eq('id', id)
        .eq('client_id', selectedClient.id)
        .single()

      if (fetchError) throw fetchError
      if (!data) {
        setError('Contact not found or does not belong to this client.')
        return
      }
      setContact(data)
    } catch (err: any) {
      console.error('Error fetching contact:', err)
      setError('Contact not found.')
    } finally {
      setLoading(false)
    }
  }

  const fetchNotes = async () => {
    if (!id || !selectedClient) return
    setLoadingNotes(true)

    try {
      const { data, error } = await supabase
        .from('contact_notes')
        .select('*')
        .eq('contact_id', id)
        .order('created_at', { ascending: false })

      if (error) throw error
      setNotes(data || [])
    } catch (err) {
      console.error('Error fetching notes:', err)
    } finally {
      setLoadingNotes(false)
    }
  }

  const handleAddNote = async () => {
    if (!contact || !noteContent.trim() || !selectedClient) return
    setSubmittingNote(true)

    try {
      const { error } = await supabase.from('contact_notes').insert({
        contact_id: contact.id,
        client_id: selectedClient.id,
        note_type: noteType,
        content: noteContent.trim(),
        created_by: 'web',
      })

      if (error) throw error
      setNoteContent('')
      setNoteType('note')
      fetchNotes()
    } catch (err) {
      console.error('Error adding note:', err)
      alert('Failed to add note')
    } finally {
      setSubmittingNote(false)
    }
  }

  const handleUpdateCustomFields = async (fields: Record<string, any>) => {
    if (!contact) return

    try {
      const { error } = await supabase
        .from('contacts')
        .update({ custom_fields: fields })
        .eq('id', contact.id)

      if (error) throw error
      setContact({ ...contact, custom_fields: fields })
    } catch (err) {
      console.error('Error updating custom fields:', err)
      alert('Failed to save custom fields')
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="ml-3 text-gray-600 text-lg">Loading contact...</span>
      </div>
    )
  }

  // Error / not found
  if (error || !contact) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-gray-500">
        <AlertCircle className="h-12 w-12 text-gray-300 mb-3" />
        <p className="text-lg font-medium">{error || 'Contact not found'}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/contacts')}>
          Back to Contacts
        </Button>
      </div>
    )
  }

  const cf = contact.custom_fields || {}

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'activity', label: 'Activity' },
    { key: 'notes', label: 'Notes' },
    { key: 'details', label: 'Details' },
  ]

  // CRM overview fields
  const overviewFields = [
    { label: 'Next Step', value: cf.next_step },
    { label: 'Potential Budget', value: cf.potential_budget },
    { label: 'Pricing Discussed', value: cf.pricing_discussed },
    { label: 'Product Interest', value: cf.product_interest },
  ]

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <ContactHeader contact={contact} onBack={() => navigate('/contacts')} />

      {/* Engagement Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Eye className="h-5 w-5 text-blue-500" />}
          label="Opens"
          value={contact.total_opens ?? 0}
        />
        <StatCard
          icon={<MousePointer className="h-5 w-5 text-green-500" />}
          label="Clicks"
          value={contact.total_clicks ?? 0}
        />
        <StatCard
          icon={<Zap className="h-5 w-5 text-amber-500" />}
          label="Score"
          value={contact.engagement_score ?? 0}
        />
        <StatCard
          icon={<Clock className="h-5 w-5 text-purple-500" />}
          label="Last Engaged"
          value={
            contact.last_engaged_at
              ? new Date(contact.last_engaged_at).toLocaleDateString()
              : 'Never'
          }
        />
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6 -mb-px">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
              {tab.key === 'notes' && notes.length > 0 && (
                <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
                  {notes.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'overview' && (
          <OverviewTab
            contact={contact}
            notes={notes}
            overviewFields={overviewFields}
            onSwitchToNotes={() => setActiveTab('notes')}
            clientId={selectedClient!.id}
          />
        )}

        {activeTab === 'activity' && (
          <ActivityTimeline contact={contact} notes={notes} />
        )}

        {activeTab === 'notes' && (
          <NotesTab
            notes={notes}
            loadingNotes={loadingNotes}
            noteContent={noteContent}
            noteType={noteType}
            submittingNote={submittingNote}
            onNoteContentChange={setNoteContent}
            onNoteTypeChange={setNoteType}
            onAddNote={handleAddNote}
          />
        )}

        {activeTab === 'details' && (
          <DetailsTab
            contact={contact}
            onUpdateCustomFields={handleUpdateCustomFields}
          />
        )}
      </div>
    </div>
  )
}

/* ─── Sub-components ─── */

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className="p-2 bg-gray-50 rounded-lg">{icon}</div>
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="text-lg font-semibold text-gray-900">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function OverviewTab({
  contact,
  notes,
  overviewFields,
  onSwitchToNotes,
  clientId,
}: {
  contact: Contact
  notes: ContactNote[]
  overviewFields: { label: string; value: any }[]
  onSwitchToNotes: () => void
  clientId: string
}) {
  const recentNotes = notes.slice(0, 3)
  const hasOverviewData = overviewFields.some((f) => f.value)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left column */}
      <div className="lg:col-span-2 space-y-6">
        {/* Key CRM Fields */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>CRM Info</CardTitle>
          </CardHeader>
          <CardContent>
            {hasOverviewData ? (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                {overviewFields.map((field) => (
                  <div key={field.label}>
                    <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {field.label}
                    </dt>
                    <dd className="mt-0.5 text-sm text-gray-900">
                      {field.value || <span className="text-gray-400 italic">Not set</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-gray-500">No CRM data available. Add fields in the Details tab.</p>
            )}
          </CardContent>
        </Card>

        {/* Recent Notes */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>Recent Notes</CardTitle>
              {notes.length > 3 && (
                <button
                  onClick={onSwitchToNotes}
                  className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
                >
                  View all notes &rarr;
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {recentNotes.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No notes yet.</p>
            ) : (
              <div className="space-y-3">
                {recentNotes.map((note) => (
                  <CompactNote key={note.id} note={note} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Right column */}
      <div>
        <TasksSection contactId={contact.id} clientId={clientId} />
      </div>
    </div>
  )
}

function CompactNote({ note }: { note: ContactNote }) {
  const iconMap: Record<NoteType, { icon: typeof MessageSquare; color: string; bg: string }> = {
    note:    { icon: MessageSquare, color: 'text-gray-600',   bg: 'bg-gray-100' },
    email:   { icon: Mail,          color: 'text-blue-600',   bg: 'bg-blue-100' },
    call:    { icon: Phone,         color: 'text-green-600',  bg: 'bg-green-100' },
    meeting: { icon: Calendar,      color: 'text-purple-600', bg: 'bg-purple-100' },
  }
  const config = iconMap[note.note_type] || iconMap.note
  const Icon = config.icon

  return (
    <div className="flex items-start gap-2">
      <div className={`p-1.5 rounded-full shrink-0 ${config.bg}`}>
        <Icon className={`h-3.5 w-3.5 ${config.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {new Date(note.created_at).toLocaleDateString()}
          </span>
          <span className="text-xs text-gray-400 capitalize">{note.note_type}</span>
        </div>
        <p className="text-sm text-gray-900 mt-0.5 line-clamp-2">{note.content}</p>
      </div>
    </div>
  )
}

function NotesTab({
  notes,
  loadingNotes,
  noteContent,
  noteType,
  submittingNote,
  onNoteContentChange,
  onNoteTypeChange,
  onAddNote,
}: {
  notes: ContactNote[]
  loadingNotes: boolean
  noteContent: string
  noteType: NoteType
  submittingNote: boolean
  onNoteContentChange: (v: string) => void
  onNoteTypeChange: (v: NoteType) => void
  onAddNote: () => void
}) {
  return (
    <div>
      {/* Add Note Form */}
      <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex gap-2 mb-3">
          {(['note', 'email', 'call', 'meeting'] as NoteType[]).map((type) => (
            <button
              key={type}
              onClick={() => onNoteTypeChange(type)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                noteType === type
                  ? 'bg-blue-100 text-blue-700 border border-blue-300'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-100'
              }`}
            >
              {type === 'note' && <MessageSquare className="h-3 w-3" />}
              {type === 'email' && <Mail className="h-3 w-3" />}
              {type === 'call' && <Phone className="h-3 w-3" />}
              {type === 'meeting' && <Calendar className="h-3 w-3" />}
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
        <textarea
          value={noteContent}
          onChange={(e) => onNoteContentChange(e.target.value)}
          placeholder="Add a note..."
          rows={3}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
        />
        <div className="flex justify-end mt-2">
          <Button size="sm" onClick={onAddNote} disabled={!noteContent.trim() || submittingNote}>
            {submittingNote ? 'Saving...' : 'Add Note'}
          </Button>
        </div>
      </div>

      {/* Notes List */}
      {loadingNotes ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
          <span className="ml-2 text-gray-600">Loading notes...</span>
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <MessageSquare className="h-8 w-8 mx-auto text-gray-300 mb-2" />
          <p>No notes yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <div
              key={note.id}
              className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50"
            >
              <div className={`p-2 rounded-full shrink-0 ${
                note.note_type === 'email' ? 'bg-blue-100' :
                note.note_type === 'call' ? 'bg-green-100' :
                note.note_type === 'meeting' ? 'bg-purple-100' :
                'bg-gray-100'
              }`}>
                {note.note_type === 'email' && <Mail className="h-4 w-4 text-blue-600" />}
                {note.note_type === 'call' && <Phone className="h-4 w-4 text-green-600" />}
                {note.note_type === 'meeting' && <Calendar className="h-4 w-4 text-purple-600" />}
                {note.note_type === 'note' && <MessageSquare className="h-4 w-4 text-gray-600" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    note.note_type === 'email' ? 'bg-blue-100 text-blue-700' :
                    note.note_type === 'call' ? 'bg-green-100 text-green-700' :
                    note.note_type === 'meeting' ? 'bg-purple-100 text-purple-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {note.note_type.charAt(0).toUpperCase() + note.note_type.slice(1)}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(note.created_at).toLocaleString()}
                  </span>
                  {note.created_by && (
                    <span className="text-xs text-gray-400">
                      by {note.created_by}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-900 mt-1 whitespace-pre-wrap">
                  {note.content}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DetailsTab({
  contact,
  onUpdateCustomFields,
}: {
  contact: Contact
  onUpdateCustomFields: (fields: Record<string, any>) => void
}) {
  const metadataItems = [
    { label: 'Created', value: new Date(contact.created_at).toLocaleString() },
    { label: 'Updated', value: new Date(contact.updated_at).toLocaleString() },
    { label: 'Source', value: contact.source_code || 'Unknown' },
    { label: 'Industry', value: contact.industry || 'Not set' },
    { label: 'Bounce Status', value: contact.bounce_status || 'none' },
  ]

  return (
    <div className="space-y-6">
      <CustomFieldsEditor contact={contact} onUpdate={onUpdateCustomFields} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
            {metadataItems.map((item) => (
              <div key={item.label}>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {item.label}
                </dt>
                <dd className="mt-0.5 text-sm text-gray-900">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}
