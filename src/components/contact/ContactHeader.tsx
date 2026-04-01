import type { Contact } from '../../types/index.js'
import Badge from '../ui/Badge'
import { ArrowLeft, Mail, Phone, Building2 } from 'lucide-react'

interface ContactHeaderProps {
  contact: Contact
  onBack: () => void
}

export default function ContactHeader({ contact, onBack }: ContactHeaderProps) {
  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown'
  const role = contact.custom_fields?.role as string | undefined
  const phone = contact.custom_fields?.phone as string | undefined

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-4">
        <button
          onClick={onBack}
          className="mt-1 p-2 rounded-md hover:bg-gray-100 transition-colors text-gray-500 hover:text-gray-700"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-gray-900">{fullName}</h1>

          {role && (
            <p className="text-sm text-gray-500">{role}</p>
          )}

          {contact.company && (
            <div className="flex items-center gap-1.5 text-sm text-gray-700">
              <Building2 className="h-4 w-4 text-gray-400" />
              <span>{contact.company}</span>
            </div>
          )}

          <div className="flex items-center gap-4 pt-1">
            <a
              href={`mailto:${contact.email}`}
              className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 hover:underline"
            >
              <Mail className="h-4 w-4" />
              {contact.email}
            </a>

            {phone && (
              <span className="flex items-center gap-1.5 text-sm text-gray-700">
                <Phone className="h-4 w-4 text-gray-400" />
                {phone}
              </span>
            )}
          </div>

          {contact.tags && contact.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {contact.tags.map((tag) => (
                <Badge key={tag} variant="default">{tag}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {contact.record_type === 'lead' ? (
          <Badge variant="warning">Lead</Badge>
        ) : contact.record_type === 'contact' ? (
          <Badge variant="success">Contact</Badge>
        ) : null}

        {contact.unsubscribed && (
          <Badge variant="danger">Unsubscribed</Badge>
        )}
      </div>
    </div>
  )
}
