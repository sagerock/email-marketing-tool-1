import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Contact } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { Plus, Search, Upload, X } from 'lucide-react'

export default function Contacts() {
  const { selectedClient } = useClient()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch contacts when client changes
  useEffect(() => {
    fetchContacts()
  }, [selectedClient])

  const fetchContacts = async () => {
    if (!selectedClient) {
      setContacts([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('created_at', { ascending: false })

      if (error) throw error
      setContacts(data || [])
    } catch (error) {
      console.error('Error fetching contacts:', error)
    } finally {
      setLoading(false)
    }
  }

  // Get unique tags from all contacts
  const allTags = Array.from(
    new Set(contacts.flatMap((contact) => contact.tags || []))
  ).sort()

  // Filter contacts
  const filteredContacts = contacts.filter((contact) => {
    const matchesSearch =
      searchTerm === '' ||
      contact.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      contact.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      contact.last_name?.toLowerCase().includes(searchTerm.toLowerCase())

    const matchesTags =
      selectedTags.length === 0 ||
      selectedTags.every((tag) => contact.tags?.includes(tag))

    return matchesSearch && matchesTags
  })

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

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
          <Button variant="outline" onClick={() => {}}>
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
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by email or name..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>

            {allTags.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Filter by tags:</p>
                <div className="flex flex-wrap gap-2">
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
          </div>
        </CardContent>
      </Card>

      {/* Contacts List */}
      <Card>
        <CardHeader>
          <CardTitle>
            {filteredContacts.length} Contact{filteredContacts.length !== 1 ? 's' : ''}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-12 text-gray-500">Loading contacts...</div>
          ) : filteredContacts.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {searchTerm || selectedTags.length > 0
                ? 'No contacts match your filters'
                : 'No contacts yet. Add your first contact to get started.'}
            </div>
          ) : (
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
                      Tags
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Status
                    </th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                      Added
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
                      onUpdate={fetchContacts}
                      onEdit={setEditingContact}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
            fetchContacts()
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
            fetchContacts()
          }}
        />
      )}
    </div>
  )
}

// Contact Row Component
function ContactRow({
  contact,
  onUpdate,
  onEdit,
}: {
  contact: Contact
  onUpdate: () => void
  onEdit: (contact: Contact) => void
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

  return (
    <tr className="hover:bg-gray-50">
      <td className="py-3 px-4 text-sm text-gray-900">{contact.email}</td>
      <td className="py-3 px-4 text-sm text-gray-900">
        {contact.first_name || contact.last_name
          ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
          : '-'}
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
      <td className="py-3 px-4">
        {contact.unsubscribed ? (
          <Badge variant="danger">Unsubscribed</Badge>
        ) : (
          <Badge variant="success">Subscribed</Badge>
        )}
      </td>
      <td className="py-3 px-4 text-sm text-gray-600">
        {new Date(contact.created_at).toLocaleDateString()}
      </td>
      <td className="py-3 px-4 text-right">
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onEdit(contact)}>
            Edit
          </Button>
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
  })
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error } = await supabase.from('contacts').insert({
        email: formData.email,
        first_name: formData.first_name || null,
        last_name: formData.last_name || null,
        tags: selectedTags,
        client_id: clientId,
      })

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error adding contact:', error)
      alert('Failed to add contact. Email might already exist.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddNewTag = () => {
    if (newTag.trim() && !selectedTags.includes(newTag.trim())) {
      setSelectedTags([...selectedTags, newTag.trim()])
      setNewTag('')
    }
  }

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter((t) => t !== tag))
    } else {
      setSelectedTags([...selectedTags, tag])
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
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

          {/* Tag Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tags
            </label>

            {/* Existing Tags */}
            {allTags.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-2">Select from existing tags:</p>
                <div className="flex flex-wrap gap-2">
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

            {/* Add New Tag */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Or add a new tag:</p>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter new tag"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddNewTag()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddNewTag}
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
          tags: selectedTags,
        })
        .eq('id', contact.id)

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error updating contact:', error)
      alert('Failed to update contact.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddNewTag = () => {
    if (newTag.trim() && !selectedTags.includes(newTag.trim())) {
      setSelectedTags([...selectedTags, newTag.trim()])
      setNewTag('')
    }
  }

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

          {/* Tag Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tags
            </label>

            {/* Existing Tags */}
            {allTags.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-2">Select from existing tags:</p>
                <div className="flex flex-wrap gap-2">
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

            {/* Add New Tag */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Or add a new tag:</p>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter new tag"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddNewTag()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddNewTag}
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
