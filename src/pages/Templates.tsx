import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Template } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import { Plus, FileText, X } from 'lucide-react'

export default function Templates() {
  const { selectedClient } = useClient()
  const [templates, setTemplates] = useState<Template[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchTemplates()
  }, [selectedClient])

  const fetchTemplates = async () => {
    if (!selectedClient) {
      setTemplates([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('created_at', { ascending: false })

      if (error) throw error
      setTemplates(data || [])
    } catch (error) {
      console.error('Error fetching templates:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Email Designs</h1>
          <p className="mt-1 text-sm text-gray-600">
            Store and manage your email designs from Stripo or other editors
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Email Design
        </Button>
      </div>

      {/* Email Designs Grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading email designs...</div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-gray-500">
              <FileText className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>No email designs yet. Add your first design from Stripo.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {templates.map((template) => (
            <Card
              key={template.id}
              className="cursor-pointer hover:shadow-md transition-shadow overflow-hidden"
              onClick={() => setSelectedTemplate(template)}
            >
              {/* Email Preview Thumbnail */}
              <div className="relative h-48 bg-gray-100 border-b border-gray-200 overflow-hidden">
                <iframe
                  srcDoc={template.html_content}
                  className="w-full h-full pointer-events-none scale-[0.33] origin-top-left"
                  style={{ width: '300%', height: '300%' }}
                  title={`Preview of ${template.name}`}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-transparent pointer-events-none" />
              </div>

              <CardHeader>
                <CardTitle className="text-base truncate">{template.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div>
                    <p className="text-xs font-medium text-gray-500">Subject</p>
                    <p className="text-sm text-gray-900 truncate">
                      {template.subject}
                    </p>
                  </div>
                  {template.preview_text && (
                    <div>
                      <p className="text-xs font-medium text-gray-500">Preview Text</p>
                      <p className="text-sm text-gray-600 line-clamp-2">
                        {template.preview_text}
                      </p>
                    </div>
                  )}
                  <div className="pt-2 flex justify-between items-center text-xs text-gray-400">
                    <span>
                      {new Date(template.created_at).toLocaleDateString()}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(template.id)
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Template Modal */}
      {showAddModal && selectedClient && (
        <AddTemplateModal
          clientId={selectedClient.id}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            fetchTemplates()
          }}
        />
      )}

      {/* Preview Template Modal */}
      {selectedTemplate && (
        <TemplatePreviewModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
        />
      )}
    </div>
  )

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this template?')) return

    try {
      const { error } = await supabase.from('templates').delete().eq('id', id)
      if (error) throw error
      fetchTemplates()
    } catch (error) {
      console.error('Error deleting template:', error)
      alert('Failed to delete template')
    }
  }
}

function AddTemplateModal({
  onClose,
  onSuccess,
  clientId,
}: {
  onClose: () => void
  onSuccess: () => void
  clientId: string
}) {
  const [formData, setFormData] = useState({
    name: '',
    subject: '',
    preview_text: '',
    html_content: '',
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error} = await supabase.from('templates').insert({
        ...formData,
        client_id: clientId,
      })
      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error adding template:', error)
      alert('Failed to add template')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Add New Email Design</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Design Name *"
            required
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />
          <Input
            label="Email Subject *"
            required
            value={formData.subject}
            onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
          />
          <Input
            label="Preview Text"
            placeholder="Optional preview text shown in email clients"
            value={formData.preview_text}
            onChange={(e) =>
              setFormData({ ...formData, preview_text: e.target.value })
            }
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              HTML Content * (from Stripo)
            </label>
            <textarea
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm min-h-[200px] font-mono"
              placeholder="Paste your HTML content from Stripo here..."
              value={formData.html_content}
              onChange={(e) =>
                setFormData({ ...formData, html_content: e.target.value })
              }
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Email Design'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function TemplatePreviewModal({
  template,
  onClose,
}: {
  template: Template
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">{template.name}</h2>
            <p className="text-sm text-gray-600 mt-1">Subject: {template.subject}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <iframe
            srcDoc={template.html_content}
            className="w-full h-[600px]"
            title="Template Preview"
          />
        </div>

        <div className="flex justify-end pt-4">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
