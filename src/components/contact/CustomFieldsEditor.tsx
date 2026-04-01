import { useState, useEffect } from 'react'
import type { Contact } from '../../types/index.js'
import Button from '../ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import { Pencil, Plus, X } from 'lucide-react'

interface CustomFieldsEditorProps {
  contact: Contact
  onUpdate: (fields: Record<string, any>) => void
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function CustomFieldsEditor({ contact, onUpdate }: CustomFieldsEditorProps) {
  const rawFields = contact.custom_fields || {}

  // Separate meeting_ fields from regular fields
  const meetingKeys = Object.keys(rawFields).filter((k) => k.startsWith('meeting_'))
  const regularKeys = Object.keys(rawFields).filter((k) => !k.startsWith('meeting_'))

  const [editing, setEditing] = useState(false)
  const [editedFields, setEditedFields] = useState<Record<string, any>>({})
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [showAddField, setShowAddField] = useState(false)

  useEffect(() => {
    setEditedFields({ ...rawFields })
  }, [contact.id, contact.custom_fields])

  const handleSave = () => {
    onUpdate(editedFields)
    setEditing(false)
    setShowAddField(false)
    setNewKey('')
    setNewValue('')
  }

  const handleCancel = () => {
    setEditedFields({ ...rawFields })
    setEditing(false)
    setShowAddField(false)
    setNewKey('')
    setNewValue('')
  }

  const handleFieldChange = (key: string, value: string) => {
    setEditedFields((prev) => ({ ...prev, [key]: value }))
  }

  const handleAddField = () => {
    if (!newKey.trim()) return
    const normalizedKey = newKey.trim().toLowerCase().replace(/\s+/g, '_')
    setEditedFields((prev) => ({ ...prev, [normalizedKey]: newValue }))
    setNewKey('')
    setNewValue('')
    setShowAddField(false)
  }

  const renderValue = (value: any): string => {
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return JSON.stringify(value, null, 2)
    return String(value)
  }

  const renderFieldGrid = (keys: string[], title?: string) => {
    if (keys.length === 0) return null

    return (
      <div>
        {title && (
          <h4 className="text-sm font-semibold text-gray-700 mb-3 mt-4">{title}</h4>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {keys.map((key) => (
            <div key={key}>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {humanizeKey(key)}
              </dt>
              {editing ? (
                <textarea
                  value={renderValue(editedFields[key])}
                  onChange={(e) => handleFieldChange(key, e.target.value)}
                  rows={typeof editedFields[key] === 'string' && editedFields[key].length > 80 ? 3 : 1}
                  className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                />
              ) : (
                <dd className="mt-0.5 text-sm text-gray-900 break-words">
                  {renderValue(rawFields[key]) || <span className="text-gray-400 italic">empty</span>}
                </dd>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const hasAnyFields = regularKeys.length > 0 || meetingKeys.length > 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>Custom Fields</CardTitle>
          {!editing ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5 mr-1" />
              Edit
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave}>
                Save
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!hasAnyFields && !editing ? (
          <p className="text-sm text-gray-500 text-center py-4">No custom fields.</p>
        ) : (
          <>
            {renderFieldGrid(regularKeys)}
            {renderFieldGrid(meetingKeys, 'Meeting Notes')}
          </>
        )}

        {editing && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            {showAddField ? (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Field Name</label>
                  <input
                    type="text"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="e.g. linkedin_url"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Value</label>
                  <input
                    type="text"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder="Value"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleAddField()
                      }
                    }}
                  />
                </div>
                <Button size="sm" onClick={handleAddField} disabled={!newKey.trim()}>
                  Add
                </Button>
                <button
                  onClick={() => {
                    setShowAddField(false)
                    setNewKey('')
                    setNewValue('')
                  }}
                  className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowAddField(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Field
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
