import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import type { Contact, ContactNote } from '../../types/index.js'
import { Eye, MousePointer, MessageSquare, Mail, Phone, Calendar } from 'lucide-react'

interface ActivityTimelineProps {
  contact: Contact
  notes: ContactNote[]
}

interface TimelineItem {
  id: string
  type: 'open' | 'click' | 'note' | 'email' | 'call' | 'meeting'
  date: string
  content: string
  url?: string | null
}

const iconConfig: Record<TimelineItem['type'], { icon: typeof Eye; color: string; bg: string; label: string }> = {
  open:    { icon: Eye,            color: 'text-blue-600',   bg: 'bg-blue-100',   label: 'Open' },
  click:   { icon: MousePointer,   color: 'text-green-600',  bg: 'bg-green-100',  label: 'Click' },
  note:    { icon: MessageSquare,   color: 'text-gray-600',   bg: 'bg-gray-100',   label: 'Note' },
  email:   { icon: Mail,           color: 'text-blue-600',   bg: 'bg-blue-100',   label: 'Email' },
  call:    { icon: Phone,          color: 'text-green-600',  bg: 'bg-green-100',  label: 'Call' },
  meeting: { icon: Calendar,       color: 'text-purple-600', bg: 'bg-purple-100', label: 'Meeting' },
}

const badgeColor: Record<TimelineItem['type'], string> = {
  open:    'bg-blue-100 text-blue-700',
  click:   'bg-green-100 text-green-700',
  note:    'bg-gray-100 text-gray-700',
  email:   'bg-blue-100 text-blue-700',
  call:    'bg-green-100 text-green-700',
  meeting: 'bg-purple-100 text-purple-700',
}

export default function ActivityTimeline({ contact, notes }: ActivityTimelineProps) {
  const [items, setItems] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAndMerge()
  }, [contact.id, contact.email, notes])

  const fetchAndMerge = async () => {
    setLoading(true)
    try {
      const { data: events, error } = await supabase
        .from('analytics_events')
        .select('event_type, timestamp, url, campaign_id, campaign:campaigns(name)')
        .eq('email', contact.email)
        .in('event_type', ['open', 'click'])
        .order('timestamp', { ascending: false })
        .limit(100)

      if (error) throw error

      const activityItems: TimelineItem[] = (events || []).map((evt: any, i: number) => ({
        id: `evt-${evt.campaign_id}-${evt.event_type}-${i}`,
        type: evt.event_type as 'open' | 'click',
        date: evt.timestamp,
        content: evt.campaign?.name || evt.campaign_id || 'Unknown campaign',
        url: evt.url,
      }))

      const noteItems: TimelineItem[] = notes.map((n) => ({
        id: `note-${n.id}`,
        type: n.note_type as TimelineItem['type'],
        date: n.created_at,
        content: n.content,
      }))

      const merged = [...activityItems, ...noteItems].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      )

      setItems(merged)
    } catch (err) {
      console.error('Error fetching activity timeline:', err)
      // Still show notes even if analytics fetch fails
      const noteItems: TimelineItem[] = notes.map((n) => ({
        id: `note-${n.id}`,
        type: n.note_type as TimelineItem['type'],
        date: n.created_at,
        content: n.content,
      }))
      setItems(noteItems)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
        <span className="ml-2 text-gray-600">Loading activity...</span>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Eye className="h-8 w-8 mx-auto text-gray-300 mb-2" />
        <p>No activity recorded yet.</p>
      </div>
    )
  }

  return (
    <div className="relative">
      {/* Vertical timeline line */}
      <div className="absolute left-5 top-0 bottom-0 w-px bg-gray-200" />

      <div className="space-y-4">
        {items.map((item) => {
          const config = iconConfig[item.type]
          const Icon = config.icon

          return (
            <div key={item.id} className="relative flex items-start gap-4 pl-0">
              {/* Icon dot */}
              <div className={`relative z-10 p-2 rounded-full shrink-0 ${config.bg}`}>
                <Icon className={`h-4 w-4 ${config.color}`} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pb-4">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${badgeColor[item.type]}`}>
                    {config.label}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(item.date).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-gray-900 mt-1 whitespace-pre-wrap">{item.content}</p>
                {item.url && (
                  <p className="text-xs text-gray-500 mt-1 truncate" title={item.url}>
                    {item.url}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
