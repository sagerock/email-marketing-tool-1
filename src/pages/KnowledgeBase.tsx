import { useState, useEffect } from 'react'
import { useClient } from '../context/ClientContext'
import { apiFetch } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import {
  Plus,
  Save,
  Trash2,
  BookOpen,
  Eye,
  EyeOff,
  ArrowLeft,
  CheckCircle,
} from 'lucide-react'

interface KnowledgeBaseItem {
  id: string
  client_id: string
  name: string
  description: string | null
  content: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export default function KnowledgeBase() {
  const { selectedClient } = useClient()
  const [items, setItems] = useState<KnowledgeBaseItem[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<KnowledgeBaseItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [isActive, setIsActive] = useState(false)

  useEffect(() => {
    fetchItems()
  }, [selectedClient])

  const fetchItems = async () => {
    if (!selectedClient) {
      setItems([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const res = await apiFetch(`/api/knowledge-bases?clientId=${selectedClient.id}`)
      const data = await res.json()
      setItems(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error('Error fetching knowledge bases:', error)
    } finally {
      setLoading(false)
    }
  }

  const startCreate = () => {
    setName('')
    setDescription('')
    setContent('')
    setIsActive(items.length === 0) // Auto-activate if first one
    setCreating(true)
    setEditing(null)
  }

  const startEdit = (item: KnowledgeBaseItem) => {
    setName(item.name)
    setDescription(item.description || '')
    setContent(item.content)
    setIsActive(item.is_active)
    setEditing(item)
    setCreating(false)
  }

  const cancelEdit = () => {
    setEditing(null)
    setCreating(false)
    setShowPreview(false)
  }

  const handleSave = async () => {
    if (!selectedClient || !name.trim()) return

    setSaving(true)
    setSaveMessage('')
    try {
      if (creating) {
        const res = await apiFetch('/api/knowledge-bases', {
          method: 'POST',
          body: JSON.stringify({
            clientId: selectedClient.id,
            name: name.trim(),
            description: description.trim() || null,
            content,
            is_active: isActive,
          }),
        })
        if (!res.ok) throw new Error('Failed to create')
      } else if (editing) {
        const res = await apiFetch(`/api/knowledge-bases/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            clientId: selectedClient.id,
            name: name.trim(),
            description: description.trim() || null,
            content,
            is_active: isActive,
          }),
        })
        if (!res.ok) throw new Error('Failed to update')
      }

      setSaveMessage('Saved!')
      setTimeout(() => setSaveMessage(''), 2000)
      await fetchItems()

      if (creating) {
        setCreating(false)
        // Stay in the list view after creating
      }
      // If editing, stay in the editor with updated data
      if (editing) {
        const res = await apiFetch(`/api/knowledge-bases?clientId=${selectedClient.id}`)
        const data = await res.json()
        const updated = (data as KnowledgeBaseItem[]).find((d: KnowledgeBaseItem) => d.id === editing.id)
        if (updated) startEdit(updated)
      }
    } catch (error) {
      console.error('Error saving knowledge base:', error)
      setSaveMessage('Error saving')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this knowledge base? This cannot be undone.')) return

    try {
      await apiFetch(`/api/knowledge-bases/${id}`, { method: 'DELETE' })
      await fetchItems()
      if (editing?.id === id) cancelEdit()
    } catch (error) {
      console.error('Error deleting knowledge base:', error)
    }
  }

  const toggleActive = async (item: KnowledgeBaseItem) => {
    if (!selectedClient) return

    try {
      await apiFetch(`/api/knowledge-bases/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          clientId: selectedClient.id,
          is_active: !item.is_active,
        }),
      })
      await fetchItems()
    } catch (error) {
      console.error('Error toggling active:', error)
    }
  }

  // Simple markdown to HTML for preview
  const renderMarkdown = (md: string) => {
    return md
      .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-6 mb-2">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-6 mb-3">$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4">$1. $2</li>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" class="text-blue-600 underline">$1</a>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>')
  }

  if (!selectedClient) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Select a client to manage knowledge bases.</p>
      </div>
    )
  }

  // Editor view
  if (editing || creating) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={cancelEdit}
            className="text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-2xl font-bold text-gray-900">
            {creating ? 'New Knowledge Base' : `Edit: ${editing?.name}`}
          </h1>
          {saveMessage && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <CheckCircle className="w-4 h-4" />
              {saveMessage}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Editor */}
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <Input
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    placeholder="e.g., AI for Business"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <Input
                    value={description}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
                    placeholder="Brief description of what this knowledge base covers"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="is-active"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <label htmlFor="is-active" className="text-sm text-gray-700">
                    Active — AI email bot will use this knowledge base
                  </label>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Content (Markdown)</CardTitle>
                  <button
                    onClick={() => setShowPreview(!showPreview)}
                    className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                  >
                    {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    {showPreview ? 'Hide Preview' : 'Show Preview'}
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={24}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  placeholder="Write your knowledge base content in Markdown format...

# About Your Business
...

## Products & Services
...

## FAQ
..."
                />
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button onClick={handleSave} disabled={saving || !name.trim()}>
                <Save className="w-4 h-4 mr-2" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button variant="outline" onClick={cancelEdit}>
                Cancel
              </Button>
            </div>
          </div>

          {/* Right: Preview */}
          {showPreview && (
            <div>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Preview</CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Knowledge Base</h1>
          <p className="text-sm text-gray-500 mt-1">
            Content your AI email bot uses to answer questions and generate personalized emails.
          </p>
        </div>
        <Button onClick={startCreate}>
          <Plus className="w-4 h-4 mr-2" />
          New Knowledge Base
        </Button>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No knowledge bases yet</h3>
            <p className="text-gray-500 mb-4">
              Create a knowledge base to give your AI email bot the information it needs to help your contacts.
            </p>
            <Button onClick={startCreate}>
              <Plus className="w-4 h-4 mr-2" />
              Create Your First Knowledge Base
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id} className="hover:shadow-md transition-shadow">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => startEdit(item)}>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-gray-900">{item.name}</h3>
                      {item.is_active ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-sm text-gray-500 mt-1">{item.description}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-1">
                      {item.content.length.toLocaleString()} characters
                      {' \u00b7 '}
                      Updated {new Date(item.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleActive(item)}
                    >
                      {item.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(item)}
                    >
                      Edit
                    </Button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="text-gray-400 hover:text-red-500 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
