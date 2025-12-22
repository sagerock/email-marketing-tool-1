import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Template, Folder } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import { Plus, FileText, X, Pencil, Folder as FolderIcon, FolderOpen, FolderPlus, MoreVertical, ArrowRight } from 'lucide-react'
import { cn } from '../lib/utils'

export default function Templates() {
  const { selectedClient } = useClient()
  const [templates, setTemplates] = useState<Template[]>([])
  const [allTemplates, setAllTemplates] = useState<Template[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)

  // Folder state
  const [folders, setFolders] = useState<Folder[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [showUnfiled, setShowUnfiled] = useState(false)
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false)
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null)
  const [movingTemplate, setMovingTemplate] = useState<Template | null>(null)

  useEffect(() => {
    fetchFolders()
    fetchAllTemplates()
  }, [selectedClient])

  useEffect(() => {
    fetchTemplates()
  }, [selectedClient, selectedFolderId, showUnfiled])

  const fetchFolders = async () => {
    if (!selectedClient) {
      setFolders([])
      return
    }

    try {
      const { data, error } = await supabase
        .from('template_folders')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('name', { ascending: true })

      if (error) throw error
      setFolders(data || [])
    } catch (error) {
      console.error('Error fetching folders:', error)
    }
  }

  const fetchAllTemplates = async () => {
    if (!selectedClient) {
      setAllTemplates([])
      return
    }

    try {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('client_id', selectedClient.id)

      if (error) throw error
      setAllTemplates(data || [])
    } catch (error) {
      console.error('Error fetching all templates:', error)
    }
  }

  const fetchTemplates = async () => {
    if (!selectedClient) {
      setTemplates([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      let query = supabase
        .from('templates')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('created_at', { ascending: false })

      // Filter by folder
      if (selectedFolderId) {
        query = query.eq('folder_id', selectedFolderId)
      } else if (showUnfiled) {
        query = query.is('folder_id', null)
      }
      // else: show all templates (no folder filter)

      const { data, error } = await query

      if (error) throw error
      setTemplates(data || [])
    } catch (error) {
      console.error('Error fetching templates:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteFolder = async (folderId: string) => {
    const folder = folders.find(f => f.id === folderId)
    if (!folder) return

    const templatesInFolder = allTemplates.filter(t => t.folder_id === folderId).length

    const message = templatesInFolder > 0
      ? `Are you sure you want to delete "${folder.name}"?\n\n${templatesInFolder} design(s) will be moved to "Unfiled".`
      : `Are you sure you want to delete "${folder.name}"?`

    if (!confirm(message)) return

    try {
      const { error } = await supabase
        .from('template_folders')
        .delete()
        .eq('id', folderId)

      if (error) throw error

      // If we were viewing this folder, switch to All
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null)
      }

      fetchFolders()
      fetchAllTemplates()
      fetchTemplates()
    } catch (error) {
      console.error('Error deleting folder:', error)
      alert('Failed to delete folder')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return

    try {
      const { error } = await supabase.from('templates').delete().eq('id', id)
      if (error) throw error
      fetchTemplates()
      fetchAllTemplates()
    } catch (error) {
      console.error('Error deleting template:', error)
      alert('Failed to delete template')
    }
  }

  // Calculate counts
  const totalTemplateCount = allTemplates.length
  const unfiledCount = allTemplates.filter(t => !t.folder_id).length
  const folderCounts = folders.reduce((acc, folder) => {
    acc[folder.id] = allTemplates.filter(t => t.folder_id === folder.id).length
    return acc
  }, {} as Record<string, number>)

  const isAllSelected = !selectedFolderId && !showUnfiled

  return (
    <div className="flex gap-6 h-[calc(100vh-theme(spacing.12))]">
      {/* Left Sidebar - Folders */}
      <div className="w-64 flex-shrink-0">
        <Card className="h-full flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Folders</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCreateFolderModal(true)}
                title="Create folder"
              >
                <FolderPlus className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto pt-0">
            <nav className="space-y-1">
              {/* All Designs */}
              <button
                onClick={() => {
                  setSelectedFolderId(null)
                  setShowUnfiled(false)
                }}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left',
                  isAllSelected
                    ? 'bg-blue-50 text-blue-600'
                    : 'text-gray-700 hover:bg-gray-100'
                )}
              >
                <FileText className="h-4 w-4" />
                <span className="flex-1">All Designs</span>
                <span className="text-xs text-gray-400">{totalTemplateCount}</span>
              </button>

              {/* Folder List */}
              {folders.map((folder) => (
                <div key={folder.id} className="group relative">
                  <button
                    onClick={() => {
                      setSelectedFolderId(folder.id)
                      setShowUnfiled(false)
                    }}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left',
                      selectedFolderId === folder.id
                        ? 'bg-blue-50 text-blue-600'
                        : 'text-gray-700 hover:bg-gray-100'
                    )}
                  >
                    {selectedFolderId === folder.id ? (
                      <FolderOpen className="h-4 w-4" />
                    ) : (
                      <FolderIcon className="h-4 w-4" />
                    )}
                    <span className="flex-1 truncate">{folder.name}</span>
                    <span className="text-xs text-gray-400">{folderCounts[folder.id] || 0}</span>
                  </button>

                  {/* Folder Actions Menu */}
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <FolderActionsMenu
                      onEdit={() => setEditingFolder(folder)}
                      onDelete={() => handleDeleteFolder(folder.id)}
                    />
                  </div>
                </div>
              ))}

              {/* Unfiled */}
              {unfiledCount > 0 && (
                <button
                  onClick={() => {
                    setSelectedFolderId(null)
                    setShowUnfiled(true)
                  }}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left',
                    showUnfiled
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-gray-700 hover:bg-gray-100'
                  )}
                >
                  <FileText className="h-4 w-4 text-gray-400" />
                  <span className="flex-1">Unfiled</span>
                  <span className="text-xs text-gray-400">{unfiledCount}</span>
                </button>
              )}
            </nav>
          </CardContent>
        </Card>
      </div>

      {/* Right Content - Template Grid */}
      <div className="flex-1 overflow-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              {selectedFolderId
                ? folders.find(f => f.id === selectedFolderId)?.name || 'Email Designs'
                : showUnfiled
                  ? 'Unfiled Designs'
                  : 'All Email Designs'}
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              {selectedFolderId || showUnfiled
                ? `${templates.length} design${templates.length !== 1 ? 's' : ''}`
                : 'Store and manage your email designs from Stripo or other editors'}
            </p>
          </div>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Email Design
          </Button>
        </div>

        {/* Merge Tags Info - only show on "All" view */}
        {!selectedFolderId && !showUnfiled && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Personalization Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 mb-3">
                Use these merge tags in your email designs to personalize content for each recipient:
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-md">
                  <code className="text-sm font-mono text-blue-600 bg-white px-2 py-1 rounded border">
                    {'{{first_name}}'}
                  </code>
                  <span className="text-sm text-gray-700">Recipient's first name</span>
                </div>
                <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-md">
                  <code className="text-sm font-mono text-blue-600 bg-white px-2 py-1 rounded border">
                    {'{{last_name}}'}
                  </code>
                  <span className="text-sm text-gray-700">Recipient's last name</span>
                </div>
                <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-md">
                  <code className="text-sm font-mono text-blue-600 bg-white px-2 py-1 rounded border">
                    {'{{email}}'}
                  </code>
                  <span className="text-sm text-gray-700">Recipient's email address</span>
                </div>
                <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-md">
                  <code className="text-sm font-mono text-blue-600 bg-white px-2 py-1 rounded border">
                    {'{{unsubscribe_url}}'}
                  </code>
                  <span className="text-sm text-gray-700">Unsubscribe link (required)</span>
                </div>
                <div className="flex items-start gap-2 p-3 bg-gray-50 rounded-md col-span-full">
                  <code className="text-sm font-mono text-blue-600 bg-white px-2 py-1 rounded border">
                    {'{{mailing_address}}'}
                  </code>
                  <span className="text-sm text-gray-700">Your company's mailing address (required by CAN-SPAM)</span>
                </div>
              </div>
              <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                <p className="text-sm text-blue-800">
                  <strong>Example:</strong> "Hi {'{{first_name}}'}, thanks for subscribing!
                  <a href="{'{{unsubscribe_url}}'}" className="underline">Click here to unsubscribe</a>."
                </p>
              </div>
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
                <p className="text-sm text-amber-800">
                  <strong>Important:</strong> Always include both {'{{unsubscribe_url}}'} and {'{{mailing_address}}'} in your emails to comply with CAN-SPAM and GDPR regulations.
                </p>
                <p className="text-xs text-amber-700 mt-2">
                  Set your mailing address in Settings → Edit Client
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Email Designs Grid */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading email designs...</div>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-gray-500">
                <FileText className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                <p>
                  {selectedFolderId
                    ? 'No designs in this folder yet.'
                    : showUnfiled
                      ? 'No unfiled designs.'
                      : 'No email designs yet. Add your first design from Stripo.'}
                </p>
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
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMovingTemplate(template)
                          }}
                        >
                          <ArrowRight className="h-3 w-3 mr-1" />
                          Move
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingTemplate(template)
                          }}
                        >
                          <Pencil className="h-3 w-3 mr-1" />
                          Edit
                        </Button>
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
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add Template Modal */}
      {showAddModal && selectedClient && (
        <AddTemplateModal
          clientId={selectedClient.id}
          folders={folders}
          defaultFolderId={selectedFolderId}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            fetchTemplates()
            fetchAllTemplates()
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

      {/* Edit Template Modal */}
      {editingTemplate && (
        <EditTemplateModal
          template={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSuccess={() => {
            setEditingTemplate(null)
            fetchTemplates()
            fetchAllTemplates()
          }}
        />
      )}

      {/* Create Folder Modal */}
      {showCreateFolderModal && selectedClient && (
        <CreateFolderModal
          clientId={selectedClient.id}
          onClose={() => setShowCreateFolderModal(false)}
          onSuccess={() => {
            setShowCreateFolderModal(false)
            fetchFolders()
          }}
        />
      )}

      {/* Edit Folder Modal */}
      {editingFolder && (
        <EditFolderModal
          folder={editingFolder}
          onClose={() => setEditingFolder(null)}
          onSuccess={() => {
            setEditingFolder(null)
            fetchFolders()
          }}
        />
      )}

      {/* Move to Folder Modal */}
      {movingTemplate && (
        <MoveToFolderModal
          template={movingTemplate}
          folders={folders}
          onClose={() => setMovingTemplate(null)}
          onSuccess={() => {
            setMovingTemplate(null)
            fetchTemplates()
            fetchAllTemplates()
          }}
        />
      )}
    </div>
  )
}

function FolderActionsMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="p-1 rounded hover:bg-gray-200"
      >
        <MoreVertical className="h-4 w-4 text-gray-500" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-gray-200 rounded-md shadow-lg z-20">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
                setOpen(false)
              }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
            >
              <Pencil className="h-3 w-3" />
              Rename
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
                setOpen(false)
              }}
              className="w-full px-3 py-2 text-sm text-left text-red-600 hover:bg-red-50 flex items-center gap-2"
            >
              <X className="h-3 w-3" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function CreateFolderModal({
  clientId,
  onClose,
  onSuccess,
}: {
  clientId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setSubmitting(true)
    try {
      const { error } = await supabase.from('template_folders').insert({
        name: name.trim(),
        client_id: clientId,
      })

      if (error) {
        if (error.message.includes('unique') || error.message.includes('duplicate')) {
          alert('A folder with this name already exists')
          setSubmitting(false)
          return
        }
        throw error
      }
      onSuccess()
    } catch (error) {
      console.error('Error creating folder:', error)
      alert('Failed to create folder')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Create Folder</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Folder Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Holiday Campaigns"
            autoFocus
          />

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating...' : 'Create Folder'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function EditFolderModal({
  folder,
  onClose,
  onSuccess,
}: {
  folder: Folder
  onClose: () => void
  onSuccess: () => void
}) {
  const [name, setName] = useState(folder.name)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setSubmitting(true)
    try {
      const { error } = await supabase
        .from('template_folders')
        .update({ name: name.trim() })
        .eq('id', folder.id)

      if (error) {
        if (error.message.includes('unique') || error.message.includes('duplicate')) {
          alert('A folder with this name already exists')
          setSubmitting(false)
          return
        }
        throw error
      }
      onSuccess()
    } catch (error) {
      console.error('Error renaming folder:', error)
      alert('Failed to rename folder')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Rename Folder</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Folder Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function MoveToFolderModal({
  template,
  folders,
  onClose,
  onSuccess,
}: {
  template: Template
  folders: Folder[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(template.folder_id || null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const { error } = await supabase
        .from('templates')
        .update({ folder_id: selectedFolderId })
        .eq('id', template.id)

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error moving template:', error)
      alert('Failed to move template')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Move to Folder</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Moving "<span className="font-medium">{template.name}</span>"
        </p>

        <div className="space-y-2 max-h-64 overflow-auto mb-4">
          {/* Unfiled option */}
          <button
            onClick={() => setSelectedFolderId(null)}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors text-left border',
              selectedFolderId === null
                ? 'border-blue-500 bg-blue-50 text-blue-600'
                : 'border-gray-200 hover:bg-gray-50'
            )}
          >
            <FileText className="h-4 w-4" />
            <span>Unfiled</span>
          </button>

          {folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => setSelectedFolderId(folder.id)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors text-left border',
                selectedFolderId === folder.id
                  ? 'border-blue-500 bg-blue-50 text-blue-600'
                  : 'border-gray-200 hover:bg-gray-50'
              )}
            >
              <FolderIcon className="h-4 w-4" />
              <span className="flex-1 truncate">{folder.name}</span>
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Moving...' : 'Move'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function AddTemplateModal({
  onClose,
  onSuccess,
  clientId,
  folders,
  defaultFolderId,
}: {
  onClose: () => void
  onSuccess: () => void
  clientId: string
  folders: Folder[]
  defaultFolderId: string | null
}) {
  const [formData, setFormData] = useState({
    name: '',
    subject: '',
    preview_text: '',
    html_content: '',
    folder_id: defaultFolderId,
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error } = await supabase.from('templates').insert({
        name: formData.name,
        subject: formData.subject,
        preview_text: formData.preview_text,
        html_content: formData.html_content,
        folder_id: formData.folder_id,
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

          {/* Folder Selector */}
          {folders.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Folder (optional)
              </label>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={formData.folder_id || ''}
                onChange={(e) => setFormData({ ...formData, folder_id: e.target.value || null })}
              >
                <option value="">Unfiled</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </div>
          )}

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

function EditTemplateModal({
  template,
  onClose,
  onSuccess,
}: {
  template: Template
  onClose: () => void
  onSuccess: () => void
}) {
  const [formData, setFormData] = useState({
    name: template.name,
    subject: template.subject,
    preview_text: template.preview_text || '',
    html_content: template.html_content,
  })
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const { error } = await supabase
        .from('templates')
        .update({
          name: formData.name,
          subject: formData.subject,
          preview_text: formData.preview_text,
          html_content: formData.html_content,
          updated_at: new Date().toISOString(),
        })
        .eq('id', template.id)

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error updating template:', error)
      alert('Failed to update template')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Edit Email Design</h2>
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
              {submitting ? 'Saving...' : 'Save Changes'}
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
