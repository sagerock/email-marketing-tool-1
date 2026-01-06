import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { EmailSequence, SequenceStep, Template, Contact, SequenceEnrollment, SalesforceCampaign } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import {
  Plus,
  X,
  Zap,
  Play,
  Pause,
  Users,
  Mail,
  Clock,
  ChevronRight,
  Trash2,
  Edit,
  Eye
} from 'lucide-react'

export default function Automations() {
  const { selectedClient } = useClient()
  const [sequences, setSequences] = useState<EmailSequence[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedSequence, setSelectedSequence] = useState<EmailSequence | null>(null)
  const [editingSequence, setEditingSequence] = useState<EmailSequence | null>(null)
  const [showEnrollModal, setShowEnrollModal] = useState(false)
  const [enrollingSequence, setEnrollingSequence] = useState<EmailSequence | null>(null)

  useEffect(() => {
    fetchSequences()
  }, [selectedClient])

  const fetchSequences = async () => {
    if (!selectedClient) {
      setSequences([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('email_sequences')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('created_at', { ascending: false })

      if (error) throw error
      setSequences(data || [])
    } catch (error) {
      console.error('Error fetching sequences:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleStatusChange = async (sequence: EmailSequence, newStatus: 'active' | 'paused') => {
    try {
      const { error } = await supabase
        .from('email_sequences')
        .update({ status: newStatus })
        .eq('id', sequence.id)

      if (error) throw error
      fetchSequences()
    } catch (error) {
      console.error('Error updating sequence status:', error)
      alert('Failed to update sequence status')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this sequence? All enrollments will be cancelled.')) return

    try {
      const { error } = await supabase.from('email_sequences').delete().eq('id', id)
      if (error) throw error
      fetchSequences()
    } catch (error) {
      console.error('Error deleting sequence:', error)
      alert('Failed to delete sequence')
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="success">Active</Badge>
      case 'paused':
        return <Badge variant="warning">Paused</Badge>
      case 'draft':
        return <Badge variant="default">Draft</Badge>
      case 'archived':
        return <Badge variant="default">Archived</Badge>
      default:
        return <Badge variant="default">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Automations</h1>
          <p className="mt-1 text-sm text-gray-600">
            Create email sequences that automatically send over time
          </p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Create Sequence
        </Button>
      </div>

      {/* Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            How Automations Work
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <span className="text-blue-600 font-medium">1</span>
              </div>
              <div>
                <p className="font-medium text-gray-900">Create a Sequence</p>
                <p className="text-gray-600">Define a series of emails with delays between each</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <span className="text-blue-600 font-medium">2</span>
              </div>
              <div>
                <p className="font-medium text-gray-900">Enroll Contacts</p>
                <p className="text-gray-600">Add contacts manually or set up automatic triggers</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <span className="text-blue-600 font-medium">3</span>
              </div>
              <div>
                <p className="font-medium text-gray-900">Emails Send Automatically</p>
                <p className="text-gray-600">The scheduler sends emails at the configured intervals</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sequences List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading sequences...</div>
      ) : sequences.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-gray-500">
              <Zap className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>No automation sequences yet.</p>
              <p className="text-sm mt-1">Create your first sequence to start automating your emails.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sequences.map((sequence) => (
            <Card key={sequence.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">{sequence.name}</h3>
                      {getStatusBadge(sequence.status)}
                    </div>
                    {sequence.description && (
                      <p className="text-sm text-gray-600 mb-3">{sequence.description}</p>
                    )}
                    <div className="flex items-center gap-6 text-sm text-gray-500">
                      <div className="flex items-center gap-1">
                        <Users className="h-4 w-4" />
                        <span>{sequence.total_enrolled} enrolled</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Mail className="h-4 w-4" />
                        <span>From: {sequence.from_name}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        <span>{new Date(sequence.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {sequence.status === 'active' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatusChange(sequence, 'paused')}
                      >
                        <Pause className="h-4 w-4 mr-1" />
                        Pause
                      </Button>
                    ) : sequence.status === 'paused' || sequence.status === 'draft' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatusChange(sequence, 'active')}
                      >
                        <Play className="h-4 w-4 mr-1" />
                        Activate
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEnrollingSequence(sequence)
                        setShowEnrollModal(true)
                      }}
                    >
                      <Users className="h-4 w-4 mr-1" />
                      Enroll
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingSequence(sequence)}
                    >
                      <Edit className="h-4 w-4 mr-1" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedSequence(sequence)}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      View
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(sequence.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Sequence Modal */}
      {showCreateModal && selectedClient && (
        <CreateSequenceModal
          clientId={selectedClient.id}
          verifiedSenders={selectedClient.verified_senders || []}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false)
            fetchSequences()
          }}
        />
      )}

      {/* Edit Sequence Modal */}
      {editingSequence && selectedClient && (
        <EditSequenceModal
          sequence={editingSequence}
          clientId={selectedClient.id}
          verifiedSenders={selectedClient.verified_senders || []}
          onClose={() => setEditingSequence(null)}
          onSuccess={() => {
            setEditingSequence(null)
            fetchSequences()
          }}
        />
      )}

      {/* View Sequence Modal */}
      {selectedSequence && (
        <ViewSequenceModal
          sequence={selectedSequence}
          onClose={() => setSelectedSequence(null)}
        />
      )}

      {/* Enroll Contacts Modal */}
      {showEnrollModal && enrollingSequence && selectedClient && (
        <EnrollContactsModal
          sequence={enrollingSequence}
          clientId={selectedClient.id}
          onClose={() => {
            setShowEnrollModal(false)
            setEnrollingSequence(null)
          }}
          onSuccess={() => {
            setShowEnrollModal(false)
            setEnrollingSequence(null)
            fetchSequences()
          }}
        />
      )}
    </div>
  )
}

// Create Sequence Modal
function CreateSequenceModal({
  clientId,
  verifiedSenders,
  onClose,
  onSuccess,
}: {
  clientId: string
  verifiedSenders: { email: string; name: string }[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [step, setStep] = useState<'info' | 'steps'>('info')
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    from_email: verifiedSenders[0]?.email || '',
    from_name: verifiedSenders[0]?.name || '',
    reply_to: '',
    start_time: '', // HH:MM format or empty for immediate
    trigger_type: 'manual' as 'manual' | 'tag_added' | 'salesforce_campaign',
    trigger_tag: '',
    trigger_salesforce_campaign_id: '',
  })
  const [sequenceSteps, setSequenceSteps] = useState<Partial<SequenceStep>[]>([
    { step_order: 1, subject: '', delay_days: 0, delay_hours: 0 }
  ])
  const [templates, setTemplates] = useState<Template[]>([])
  const [availableTags, setAvailableTags] = useState<string[]>([])
  const [salesforceCampaigns, setSalesforceCampaigns] = useState<SalesforceCampaign[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    // Fetch templates
    const { data: templatesData } = await supabase
      .from('templates')
      .select('*')
      .eq('client_id', clientId)
      .order('name')
    setTemplates(templatesData || [])

    // Fetch all unique tags from contacts
    const { data: contacts } = await supabase
      .from('contacts')
      .select('tags')
      .eq('client_id', clientId)

    const tags = new Set<string>()
    contacts?.forEach(contact => {
      contact.tags?.forEach((tag: string) => tags.add(tag))
    })
    setAvailableTags(Array.from(tags).sort())

    // Fetch Salesforce campaigns
    const { data: sfCampaigns } = await supabase
      .from('salesforce_campaigns')
      .select('*')
      .eq('client_id', clientId)
      .order('name', { ascending: true })
    setSalesforceCampaigns(sfCampaigns || [])
  }

  const addStep = () => {
    setSequenceSteps([
      ...sequenceSteps,
      {
        step_order: sequenceSteps.length + 1,
        subject: '',
        delay_days: 1,
        delay_hours: 0
      }
    ])
  }

  const removeStep = (index: number) => {
    if (sequenceSteps.length === 1) return
    const updated = sequenceSteps.filter((_, i) => i !== index)
    // Reorder steps
    updated.forEach((s, i) => s.step_order = i + 1)
    setSequenceSteps(updated)
  }

  const updateStep = (index: number, field: string, value: any) => {
    setSequenceSteps(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  const updateStepFields = (index: number, updates: Record<string, any>) => {
    setSequenceSteps(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], ...updates }
      return updated
    })
  }

  const handleSubmit = async () => {
    if (!formData.name || !formData.from_email) {
      alert('Please fill in all required fields')
      return
    }

    const hasEmptySteps = sequenceSteps.some(s => !s.subject)
    if (hasEmptySteps) {
      alert('Please add a subject for all steps')
      return
    }

    setSubmitting(true)
    try {
      // Create sequence
      const { data: sequence, error: seqError } = await supabase
        .from('email_sequences')
        .insert({
          name: formData.name,
          description: formData.description,
          from_email: formData.from_email,
          from_name: formData.from_name,
          reply_to: formData.reply_to || null,
          start_time: formData.start_time || null,
          trigger_type: formData.trigger_type,
          trigger_config: formData.trigger_type === 'tag_added' && formData.trigger_tag
            ? { tag: formData.trigger_tag }
            : {},
          trigger_salesforce_campaign_id: formData.trigger_type === 'salesforce_campaign' && formData.trigger_salesforce_campaign_id
            ? formData.trigger_salesforce_campaign_id
            : null,
          client_id: clientId,
          status: 'draft',
        })
        .select()
        .single()

      if (seqError) throw seqError

      // Create steps
      const stepsToInsert = sequenceSteps.map(s => ({
        sequence_id: sequence.id,
        step_order: s.step_order,
        subject: s.subject,
        template_id: s.template_id || null,
        html_content: s.html_content || null,
        delay_days: s.delay_days || 0,
        delay_hours: s.delay_hours || 0,
      }))

      const { error: stepsError } = await supabase
        .from('sequence_steps')
        .insert(stepsToInsert)

      if (stepsError) throw stepsError

      onSuccess()
    } catch (error) {
      console.error('Error creating sequence:', error)
      alert('Failed to create sequence')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-xl font-semibold">Create Email Sequence</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {step === 'info' ? (
            <div className="space-y-4">
              <Input
                label="Sequence Name *"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Welcome Series"
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Optional description for this sequence"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  From Sender *
                </label>
                <select
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  value={`${formData.from_email}|${formData.from_name}`}
                  onChange={(e) => {
                    const [email, name] = e.target.value.split('|')
                    setFormData({ ...formData, from_email: email, from_name: name })
                  }}
                >
                  {verifiedSenders.map((sender) => (
                    <option key={sender.email} value={`${sender.email}|${sender.name}`}>
                      {sender.name} &lt;{sender.email}&gt;
                    </option>
                  ))}
                </select>
              </div>
              <Input
                label="Reply-To Email"
                type="email"
                value={formData.reply_to}
                onChange={(e) => setFormData({ ...formData, reply_to: e.target.value })}
                placeholder="Optional reply-to address"
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Preferred Send Time (optional)
                </label>
                <div className="flex items-center gap-3">
                  <select
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
                    value={formData.start_time ? 'scheduled' : 'immediate'}
                    onChange={(e) => {
                      if (e.target.value === 'immediate') {
                        setFormData({ ...formData, start_time: '' })
                      } else {
                        setFormData({ ...formData, start_time: '09:00' })
                      }
                    }}
                  >
                    <option value="immediate">Any time (based on step delays)</option>
                    <option value="scheduled">At specific time of day</option>
                  </select>
                  {formData.start_time && (
                    <input
                      type="time"
                      className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                      value={formData.start_time}
                      onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                    />
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {formData.start_time
                    ? `Emails will be sent at ${formData.start_time} (after any step delays)`
                    : 'Emails send based on step delay settings only'}
                </p>
              </div>

              {/* Auto-enrollment trigger */}
              <div className="pt-4 border-t">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Auto-Enrollment Trigger
                </label>
                <select
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-2"
                  value={formData.trigger_type}
                  onChange={(e) => setFormData({
                    ...formData,
                    trigger_type: e.target.value as 'manual' | 'tag_added' | 'salesforce_campaign',
                    trigger_tag: e.target.value === 'tag_added' ? formData.trigger_tag : '',
                    trigger_salesforce_campaign_id: e.target.value === 'salesforce_campaign' ? formData.trigger_salesforce_campaign_id : '',
                  })}
                >
                  <option value="manual">Manual enrollment only</option>
                  <option value="tag_added">Auto-enroll when tag is added</option>
                  <option value="salesforce_campaign">Auto-enroll from Salesforce Campaign</option>
                </select>

                {formData.trigger_type === 'tag_added' && (
                  <div>
                    <select
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      value={formData.trigger_tag}
                      onChange={(e) => setFormData({ ...formData, trigger_tag: e.target.value })}
                    >
                      <option value="">Select a tag...</option>
                      {availableTags.map((tag) => (
                        <option key={tag} value={tag}>{tag}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Contacts will be automatically enrolled when they receive this tag
                    </p>
                  </div>
                )}

                {formData.trigger_type === 'salesforce_campaign' && (
                  <div>
                    <select
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      value={formData.trigger_salesforce_campaign_id}
                      onChange={(e) => setFormData({ ...formData, trigger_salesforce_campaign_id: e.target.value })}
                    >
                      <option value="">Select a Salesforce Campaign...</option>
                      {salesforceCampaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {campaign.name} {campaign.type ? `(${campaign.type})` : ''}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Leads added to this Salesforce Campaign will be automatically enrolled.
                      {salesforceCampaigns.length === 0 && (
                        <span className="block text-amber-600 mt-1">
                          No campaigns found. Sync campaigns from Settings → Salesforce first.
                        </span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-gray-900">Email Steps</h3>
                <Button variant="outline" size="sm" onClick={addStep}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Step
                </Button>
              </div>

              {sequenceSteps.map((stepData, index) => (
                <Card key={index} className="relative">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-600 font-medium text-sm">{index + 1}</span>
                      </div>
                      <div className="flex-1 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-600">Wait</span>
                          <input
                            type="number"
                            min="0"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={stepData.delay_days || 0}
                            onChange={(e) => updateStep(index, 'delay_days', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">days</span>
                          <input
                            type="number"
                            min="0"
                            max="23"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={stepData.delay_hours || 0}
                            onChange={(e) => updateStep(index, 'delay_hours', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">
                            {index === 0 ? 'after enrollment' : 'after previous step'}
                          </span>
                        </div>
                        <Input
                          label="Subject *"
                          required
                          value={stepData.subject || ''}
                          onChange={(e) => updateStep(index, 'subject', e.target.value)}
                          placeholder="Email subject line"
                        />
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Email Template
                          </label>
                          <select
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                            value={stepData.template_id || ''}
                            onChange={(e) => {
                              const templateId = e.target.value || null
                              const template = templateId ? templates.find(t => t.id === templateId) : null
                              // Update both template_id and subject in one call to avoid race conditions
                              const updates: Record<string, any> = { template_id: templateId }
                              if (template?.subject) {
                                updates.subject = template.subject
                              }
                              updateStepFields(index, updates)
                            }}
                          >
                            <option value="">Select a template...</option>
                            {templates.map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        </div>
                        {/* Merge Tags Help - only show for first step */}
                        {index === 0 && (
                          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs">
                            <p className="font-semibold text-blue-900 mb-2">📝 Available Merge Tags:</p>
                            <div className="grid grid-cols-2 gap-1 text-blue-800 mb-2">
                              <span><code className="bg-white px-1 rounded">{'{{first_name}}'}</code> → First name</span>
                              <span><code className="bg-white px-1 rounded">{'{{last_name}}'}</code> → Last name</span>
                              <span><code className="bg-white px-1 rounded">{'{{email}}'}</code> → Email</span>
                              <span><code className="bg-white px-1 rounded">{'{{campaign_name}}'}</code> → Tradeshow name</span>
                            </div>
                            <div className="mt-2 pt-2 border-t border-blue-200">
                              <p className="font-semibold text-blue-900 mb-1">🔗 URL Tags (must wrap in &lt;a href=""&gt;):</p>
                              <div className="space-y-1">
                                <div className="bg-white rounded px-2 py-1 border border-blue-100">
                                  <code className="text-blue-700 font-mono text-xs">{'<a href="{{unsubscribe_url}}">Unsubscribe</a>'}</code>
                                </div>
                                <div className="bg-white rounded px-2 py-1 border border-blue-100">
                                  <code className="text-blue-700 font-mono text-xs">{'<a href="{{industry_link}}">View industry solutions</a>'}</code>
                                </div>
                              </div>
                            </div>
                            <p className="text-blue-700 mt-2">
                              <code>{'{{campaign_name}}'}</code> uses the Salesforce Campaign that triggered enrollment.
                            </p>
                          </div>
                        )}
                      </div>
                      {sequenceSteps.length > 1 && (
                        <button
                          onClick={() => removeStep(index)}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between p-6 border-t bg-gray-50">
          {step === 'steps' ? (
            <>
              <Button variant="outline" onClick={() => setStep('info')}>
                Back
              </Button>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Creating...' : 'Create Sequence'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => setStep('steps')}>
                Next: Add Email Steps
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Edit Sequence Modal
function EditSequenceModal({
  sequence,
  clientId,
  verifiedSenders,
  onClose,
  onSuccess,
}: {
  sequence: EmailSequence
  clientId: string
  verifiedSenders: { email: string; name: string }[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [formData, setFormData] = useState({
    name: sequence.name,
    description: sequence.description || '',
    from_email: sequence.from_email,
    from_name: sequence.from_name,
    reply_to: sequence.reply_to || '',
    start_time: sequence.start_time || '',
    trigger_type: sequence.trigger_type || 'manual',
    trigger_tag: (sequence.trigger_config as any)?.tag || '',
    trigger_salesforce_campaign_id: sequence.trigger_salesforce_campaign_id || '',
  })
  const [steps, setSteps] = useState<SequenceStep[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [availableTags, setAvailableTags] = useState<string[]>([])
  const [salesforceCampaigns, setSalesforceCampaigns] = useState<SalesforceCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [activeTab, setActiveTab] = useState<'settings' | 'steps'>('steps')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      const [stepsRes, templatesRes, contactsRes, sfCampaignsRes] = await Promise.all([
        supabase
          .from('sequence_steps')
          .select('*')
          .eq('sequence_id', sequence.id)
          .order('step_order'),
        supabase
          .from('templates')
          .select('*')
          .eq('client_id', clientId)
          .order('name'),
        supabase
          .from('contacts')
          .select('tags')
          .eq('client_id', clientId),
        supabase
          .from('salesforce_campaigns')
          .select('*')
          .eq('client_id', clientId)
          .order('name', { ascending: true })
      ])

      if (stepsRes.error) throw stepsRes.error
      setSteps(stepsRes.data || [])
      setTemplates(templatesRes.data || [])
      setSalesforceCampaigns(sfCampaignsRes.data || [])

      // Extract unique tags
      const tags = new Set<string>()
      contactsRes.data?.forEach(contact => {
        contact.tags?.forEach((tag: string) => tags.add(tag))
      })
      setAvailableTags(Array.from(tags).sort())
    } catch (error) {
      console.error('Error fetching sequence data:', error)
    } finally {
      setLoading(false)
    }
  }

  const addStep = async () => {
    const newStepOrder = steps.length + 1
    try {
      const { data, error } = await supabase
        .from('sequence_steps')
        .insert({
          sequence_id: sequence.id,
          step_order: newStepOrder,
          subject: `Email ${newStepOrder}`,
          delay_days: newStepOrder === 1 ? 0 : 1,
          delay_hours: 0,
        })
        .select()
        .single()

      if (error) throw error
      setSteps([...steps, data])
    } catch (error) {
      console.error('Error adding step:', error)
      alert('Failed to add step')
    }
  }

  const updateStep = async (stepId: string, field: string, value: any) => {
    try {
      const { error } = await supabase
        .from('sequence_steps')
        .update({ [field]: value })
        .eq('id', stepId)

      if (error) throw error

      setSteps(prev => prev.map(s =>
        s.id === stepId ? { ...s, [field]: value } : s
      ))
    } catch (error) {
      console.error('Error updating step:', error)
    }
  }

  const updateStepMultiple = async (stepId: string, updates: Record<string, any>) => {
    try {
      const { error } = await supabase
        .from('sequence_steps')
        .update(updates)
        .eq('id', stepId)

      if (error) throw error

      setSteps(prev => prev.map(s =>
        s.id === stepId ? { ...s, ...updates } : s
      ))
    } catch (error) {
      console.error('Error updating step:', error)
    }
  }

  const deleteStep = async (stepId: string) => {
    if (steps.length === 1) {
      alert('Sequence must have at least one step')
      return
    }

    if (!confirm('Delete this step?')) return

    try {
      const { error } = await supabase
        .from('sequence_steps')
        .delete()
        .eq('id', stepId)

      if (error) throw error

      // Reorder remaining steps
      const remainingSteps = steps.filter(s => s.id !== stepId)
      for (let i = 0; i < remainingSteps.length; i++) {
        if (remainingSteps[i].step_order !== i + 1) {
          await supabase
            .from('sequence_steps')
            .update({ step_order: i + 1 })
            .eq('id', remainingSteps[i].id)
          remainingSteps[i].step_order = i + 1
        }
      }

      setSteps(remainingSteps)
    } catch (error) {
      console.error('Error deleting step:', error)
      alert('Failed to delete step')
    }
  }

  const saveSettings = async () => {
    setSubmitting(true)
    try {
      const { error } = await supabase
        .from('email_sequences')
        .update({
          name: formData.name,
          description: formData.description || null,
          from_email: formData.from_email,
          from_name: formData.from_name,
          reply_to: formData.reply_to || null,
          start_time: formData.start_time || null,
          trigger_type: formData.trigger_type,
          trigger_config: formData.trigger_type === 'tag_added' && formData.trigger_tag
            ? { tag: formData.trigger_tag }
            : {},
          trigger_salesforce_campaign_id: formData.trigger_type === 'salesforce_campaign' && formData.trigger_salesforce_campaign_id
            ? formData.trigger_salesforce_campaign_id
            : null,
        })
        .eq('id', sequence.id)

      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error saving sequence:', error)
      alert('Failed to save sequence')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-xl font-semibold">Edit Sequence: {sequence.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          <button
            className={`px-6 py-3 text-sm font-medium ${
              activeTab === 'steps'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab('steps')}
          >
            Email Steps ({steps.length})
          </button>
          <button
            className={`px-6 py-3 text-sm font-medium ${
              activeTab === 'settings'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab('settings')}
          >
            Settings
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : activeTab === 'steps' ? (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <p className="text-sm text-gray-600">
                  Add and configure the emails in your sequence
                </p>
                <Button variant="outline" size="sm" onClick={addStep}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Step
                </Button>
              </div>

              {steps.map((step, index) => (
                <Card key={step.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-600 font-medium text-sm">{step.step_order}</span>
                      </div>
                      <div className="flex-1 space-y-3">
                        <div className="flex items-center gap-2 pb-2 border-b">
                          <Clock className="h-4 w-4 text-gray-400" />
                          <span className="text-sm text-gray-600">Wait</span>
                          <input
                            type="number"
                            min="0"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={step.delay_days}
                            onChange={(e) => updateStep(step.id, 'delay_days', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">days</span>
                          <input
                            type="number"
                            min="0"
                            max="23"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={step.delay_hours}
                            onChange={(e) => updateStep(step.id, 'delay_hours', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">
                            {index === 0 ? 'hours after enrollment' : 'hours after previous'}
                          </span>
                        </div>
                        <Input
                          label="Subject"
                          value={step.subject}
                          onChange={(e) => updateStep(step.id, 'subject', e.target.value)}
                          placeholder="Email subject line"
                        />
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Template
                          </label>
                          <select
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                            value={step.template_id || ''}
                            onChange={(e) => {
                              const templateId = e.target.value || null
                              const template = templateId ? templates.find(t => t.id === templateId) : null
                              // Update both template_id and subject in one call to avoid race conditions
                              const updates: Record<string, any> = { template_id: templateId }
                              if (template?.subject) {
                                updates.subject = template.subject
                              }
                              updateStepMultiple(step.id, updates)
                            }}
                          >
                            <option value="">Select a template...</option>
                            {templates.map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        </div>
                        {/* Merge Tags Help - only show for first step */}
                        {index === 0 && (
                          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs">
                            <p className="font-semibold text-blue-900 mb-2">📝 Available Merge Tags:</p>
                            <div className="grid grid-cols-2 gap-1 text-blue-800 mb-2">
                              <span><code className="bg-white px-1 rounded">{'{{first_name}}'}</code> → First name</span>
                              <span><code className="bg-white px-1 rounded">{'{{last_name}}'}</code> → Last name</span>
                              <span><code className="bg-white px-1 rounded">{'{{email}}'}</code> → Email</span>
                              <span><code className="bg-white px-1 rounded">{'{{campaign_name}}'}</code> → Tradeshow name</span>
                            </div>
                            <div className="mt-2 pt-2 border-t border-blue-200">
                              <p className="font-semibold text-blue-900 mb-1">🔗 URL Tags (must wrap in &lt;a href=""&gt;):</p>
                              <div className="space-y-1">
                                <div className="bg-white rounded px-2 py-1 border border-blue-100">
                                  <code className="text-blue-700 font-mono text-xs">{'<a href="{{unsubscribe_url}}">Unsubscribe</a>'}</code>
                                </div>
                                <div className="bg-white rounded px-2 py-1 border border-blue-100">
                                  <code className="text-blue-700 font-mono text-xs">{'<a href="{{industry_link}}">View industry solutions</a>'}</code>
                                </div>
                              </div>
                            </div>
                            <p className="text-blue-700 mt-2">
                              <code>{'{{campaign_name}}'}</code> uses the Salesforce Campaign that triggered enrollment.
                            </p>
                          </div>
                        )}
                        <div className="text-xs text-gray-500">
                          {step.sent_count} sent · {step.open_count} opens · {step.click_count} clicks
                        </div>
                      </div>
                      <button
                        onClick={() => deleteStep(step.id)}
                        className="text-gray-400 hover:text-red-500"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {steps.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Mail className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                  <p>No steps yet. Add your first email step.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <Input
                label="Sequence Name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  From Sender
                </label>
                <select
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  value={`${formData.from_email}|${formData.from_name}`}
                  onChange={(e) => {
                    const [email, name] = e.target.value.split('|')
                    setFormData({ ...formData, from_email: email, from_name: name })
                  }}
                >
                  {verifiedSenders.map((sender) => (
                    <option key={sender.email} value={`${sender.email}|${sender.name}`}>
                      {sender.name} &lt;{sender.email}&gt;
                    </option>
                  ))}
                </select>
              </div>
              <Input
                label="Reply-To Email"
                type="email"
                value={formData.reply_to}
                onChange={(e) => setFormData({ ...formData, reply_to: e.target.value })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Preferred Send Time (optional)
                </label>
                <div className="flex items-center gap-3">
                  <select
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
                    value={formData.start_time ? 'scheduled' : 'immediate'}
                    onChange={(e) => {
                      if (e.target.value === 'immediate') {
                        setFormData({ ...formData, start_time: '' })
                      } else {
                        setFormData({ ...formData, start_time: '09:00' })
                      }
                    }}
                  >
                    <option value="immediate">Any time (based on step delays)</option>
                    <option value="scheduled">At specific time of day</option>
                  </select>
                  {formData.start_time && (
                    <input
                      type="time"
                      className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                      value={formData.start_time}
                      onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                    />
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {formData.start_time
                    ? `Emails will be sent at ${formData.start_time} (after any step delays)`
                    : 'Emails send based on step delay settings only'}
                </p>
              </div>

              {/* Auto-enrollment trigger */}
              <div className="pt-4 border-t">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Auto-Enrollment Trigger
                </label>
                <select
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-2"
                  value={formData.trigger_type}
                  onChange={(e) => setFormData({
                    ...formData,
                    trigger_type: e.target.value as 'manual' | 'tag_added' | 'salesforce_campaign',
                    trigger_tag: e.target.value === 'tag_added' ? formData.trigger_tag : '',
                    trigger_salesforce_campaign_id: e.target.value === 'salesforce_campaign' ? formData.trigger_salesforce_campaign_id : '',
                  })}
                >
                  <option value="manual">Manual enrollment only</option>
                  <option value="tag_added">Auto-enroll when tag is added</option>
                  <option value="salesforce_campaign">Auto-enroll from Salesforce Campaign</option>
                </select>

                {formData.trigger_type === 'tag_added' && (
                  <div>
                    <select
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      value={formData.trigger_tag}
                      onChange={(e) => setFormData({ ...formData, trigger_tag: e.target.value })}
                    >
                      <option value="">Select a tag...</option>
                      {availableTags.map((tag) => (
                        <option key={tag} value={tag}>{tag}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Contacts will be automatically enrolled when they receive this tag
                    </p>
                  </div>
                )}

                {formData.trigger_type === 'salesforce_campaign' && (
                  <div>
                    <select
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      value={formData.trigger_salesforce_campaign_id}
                      onChange={(e) => setFormData({ ...formData, trigger_salesforce_campaign_id: e.target.value })}
                    >
                      <option value="">Select a Salesforce Campaign...</option>
                      {salesforceCampaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {campaign.name} {campaign.type ? `(${campaign.type})` : ''}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Leads added to this Salesforce Campaign will be automatically enrolled.
                      {salesforceCampaigns.length === 0 && (
                        <span className="block text-amber-600 mt-1">
                          No campaigns found. Sync campaigns from Settings → Salesforce first.
                        </span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-6 border-t bg-gray-50">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {activeTab === 'settings' && (
            <Button onClick={saveSettings} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save Settings'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// View Sequence Modal
function ViewSequenceModal({
  sequence,
  onClose,
}: {
  sequence: EmailSequence
  onClose: () => void
}) {
  const [steps, setSteps] = useState<SequenceStep[]>([])
  const [enrollments, setEnrollments] = useState<SequenceEnrollment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchDetails()
  }, [sequence.id])

  const fetchDetails = async () => {
    setLoading(true)
    try {
      const [stepsRes, enrollmentsRes] = await Promise.all([
        supabase
          .from('sequence_steps')
          .select('*')
          .eq('sequence_id', sequence.id)
          .order('step_order'),
        supabase
          .from('sequence_enrollments')
          .select(`
            *,
            contact:contacts(email, first_name, last_name)
          `)
          .eq('sequence_id', sequence.id)
          .order('enrolled_at', { ascending: false })
          .limit(50)
      ])

      if (stepsRes.error) throw stepsRes.error
      if (enrollmentsRes.error) throw enrollmentsRes.error

      setSteps(stepsRes.data || [])
      setEnrollments(enrollmentsRes.data || [])
    } catch (error) {
      console.error('Error fetching sequence details:', error)
    } finally {
      setLoading(false)
    }
  }

  const getEnrollmentStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="success">Active</Badge>
      case 'completed':
        return <Badge variant="default">Completed</Badge>
      case 'paused':
        return <Badge variant="warning">Paused</Badge>
      case 'cancelled':
        return <Badge variant="default">Cancelled</Badge>
      default:
        return <Badge variant="default">{status}</Badge>
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h2 className="text-xl font-semibold">{sequence.name}</h2>
            <p className="text-sm text-gray-600">
              From: {sequence.from_name} &lt;{sequence.from_email}&gt;
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : (
            <div className="space-y-6">
              {/* Steps */}
              <div>
                <h3 className="font-medium text-gray-900 mb-3">Email Steps ({steps.length})</h3>
                <div className="space-y-3">
                  {steps.map((step, index) => (
                    <div key={step.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                      <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-600 font-medium text-xs">{step.step_order}</span>
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-sm">{step.subject}</p>
                        <p className="text-xs text-gray-500">
                          {step.delay_days === 0 && step.delay_hours === 0
                            ? index === 0 ? 'Sends immediately' : 'Sends right after previous'
                            : index === 0
                              ? `${step.delay_days}d ${step.delay_hours}h after enrollment`
                              : `${step.delay_days}d ${step.delay_hours}h after previous`}
                        </p>
                      </div>
                      <div className="text-xs text-gray-500">
                        {step.sent_count} sent
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Enrollments */}
              <div>
                <h3 className="font-medium text-gray-900 mb-3">
                  Recent Enrollments ({sequence.total_enrolled} total)
                </h3>
                {enrollments.length === 0 ? (
                  <p className="text-sm text-gray-500">No contacts enrolled yet.</p>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Contact</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Status</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Step</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Enrolled</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {enrollments.map((enrollment) => (
                          <tr key={enrollment.id}>
                            <td className="px-4 py-2 text-sm">
                              {enrollment.contact?.email || 'Unknown'}
                            </td>
                            <td className="px-4 py-2">
                              {getEnrollmentStatusBadge(enrollment.status)}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-600">
                              {enrollment.current_step} / {steps.length}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-500">
                              {new Date(enrollment.enrolled_at).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end p-6 border-t bg-gray-50">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}

// Enroll Contacts Modal
function EnrollContactsModal({
  sequence,
  clientId,
  onClose,
  onSuccess,
}: {
  sequence: EmailSequence
  clientId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContacts, setSelectedContacts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [enrollMode, setEnrollMode] = useState<'individual' | 'tags'>('individual')
  const [allTags, setAllTags] = useState<string[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [tagMatchMode, setTagMatchMode] = useState<'any' | 'all'>('any')

  useEffect(() => {
    fetchEligibleContacts()
  }, [])

  const fetchEligibleContacts = async () => {
    setLoading(true)
    try {
      // Get contacts that are not already enrolled in this sequence
      const { data: enrolled } = await supabase
        .from('sequence_enrollments')
        .select('contact_id')
        .eq('sequence_id', sequence.id)

      const enrolledIds = enrolled?.map(e => e.contact_id) || []

      let query = supabase
        .from('contacts')
        .select('*')
        .eq('client_id', clientId)
        .eq('unsubscribed', false)
        .order('email')

      if (enrolledIds.length > 0) {
        query = query.not('id', 'in', `(${enrolledIds.join(',')})`)
      }

      const { data, error } = await query

      if (error) throw error
      setContacts(data || [])

      // Extract all unique tags
      const tags = new Set<string>()
      data?.forEach(contact => {
        contact.tags?.forEach((tag: string) => tags.add(tag))
      })
      setAllTags(Array.from(tags).sort())
    } catch (error) {
      console.error('Error fetching contacts:', error)
    } finally {
      setLoading(false)
    }
  }

  // Filter contacts based on mode
  const filteredContacts = contacts.filter(c => {
    const matchesSearch =
      c.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.last_name?.toLowerCase().includes(searchTerm.toLowerCase())

    if (enrollMode === 'tags' && selectedTags.length > 0) {
      const hasMatchingTags = tagMatchMode === 'any'
        ? selectedTags.some(tag => c.tags?.includes(tag))
        : selectedTags.every(tag => c.tags?.includes(tag))
      return matchesSearch && hasMatchingTags
    }

    return matchesSearch
  })

  // Auto-select all when filtering by tags
  useEffect(() => {
    if (enrollMode === 'tags' && selectedTags.length > 0) {
      setSelectedContacts(filteredContacts.map(c => c.id))
    }
  }, [selectedTags, tagMatchMode, enrollMode])

  const toggleContact = (id: string) => {
    setSelectedContacts(prev =>
      prev.includes(id)
        ? prev.filter(cId => cId !== id)
        : [...prev, id]
    )
  }

  const toggleAll = () => {
    if (selectedContacts.length === filteredContacts.length) {
      setSelectedContacts([])
    } else {
      setSelectedContacts(filteredContacts.map(c => c.id))
    }
  }

  const handleEnroll = async () => {
    if (selectedContacts.length === 0) {
      alert('Please select at least one contact')
      return
    }

    setSubmitting(true)
    try {
      // Get the first step to calculate next email time
      const { data: firstStep } = await supabase
        .from('sequence_steps')
        .select('*')
        .eq('sequence_id', sequence.id)
        .eq('step_order', 1)
        .single()

      // Calculate scheduled time for first email
      const now = new Date()
      let scheduledTime = new Date(now)

      if (firstStep) {
        // Add delay from first step
        scheduledTime.setDate(scheduledTime.getDate() + (firstStep.delay_days || 0))
        scheduledTime.setHours(scheduledTime.getHours() + (firstStep.delay_hours || 0))
      }

      // If sequence has a preferred start_time, adjust to that time
      if (sequence.start_time) {
        const [hours, minutes] = sequence.start_time.split(':').map(Number)
        scheduledTime.setHours(hours, minutes, 0, 0)

        // If the scheduled time is in the past, move to next day
        if (scheduledTime <= now) {
          scheduledTime.setDate(scheduledTime.getDate() + 1)
        }
      }

      // Create enrollments
      const enrollments = selectedContacts.map(contactId => ({
        sequence_id: sequence.id,
        contact_id: contactId,
        status: 'active',
        current_step: 0,
        next_email_scheduled_at: scheduledTime.toISOString(),
      }))

      const { error: enrollError } = await supabase
        .from('sequence_enrollments')
        .insert(enrollments)

      if (enrollError) throw enrollError

      // Update sequence total enrolled count
      await supabase
        .from('email_sequences')
        .update({ total_enrolled: sequence.total_enrolled + selectedContacts.length })
        .eq('id', sequence.id)

      // Schedule the first emails
      if (firstStep) {
        const { data: newEnrollments } = await supabase
          .from('sequence_enrollments')
          .select('id, contact_id')
          .eq('sequence_id', sequence.id)
          .in('contact_id', selectedContacts)

        if (newEnrollments) {
          const scheduledEmails = newEnrollments.map(enrollment => ({
            enrollment_id: enrollment.id,
            step_id: firstStep.id,
            contact_id: enrollment.contact_id,
            scheduled_for: scheduledTime.toISOString(),
            status: 'pending',
          }))

          await supabase.from('scheduled_emails').insert(scheduledEmails)
        }
      }

      onSuccess()
    } catch (error) {
      console.error('Error enrolling contacts:', error)
      alert('Failed to enroll contacts')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h2 className="text-xl font-semibold">Enroll Contacts</h2>
            <p className="text-sm text-gray-600">
              Select contacts to add to "{sequence.name}"
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mode Selection */}
        <div className="p-4 border-b space-y-3">
          <div className="flex gap-2">
            <button
              className={`px-3 py-1.5 text-sm rounded-md ${
                enrollMode === 'individual'
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              onClick={() => {
                setEnrollMode('individual')
                setSelectedTags([])
                setSelectedContacts([])
              }}
            >
              Select Individually
            </button>
            <button
              className={`px-3 py-1.5 text-sm rounded-md ${
                enrollMode === 'tags'
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              onClick={() => {
                setEnrollMode('tags')
                setSelectedContacts([])
              }}
            >
              Select by Tags
            </button>
          </div>

          {enrollMode === 'tags' && allTags.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Match:</span>
                <select
                  className="text-sm rounded-md border border-gray-300 px-2 py-1"
                  value={tagMatchMode}
                  onChange={(e) => setTagMatchMode(e.target.value as 'any' | 'all')}
                >
                  <option value="any">Any selected tag</option>
                  <option value="all">All selected tags</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    className={`px-2 py-1 text-xs rounded-full ${
                      selectedTags.includes(tag)
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                    onClick={() => {
                      setSelectedTags(prev =>
                        prev.includes(tag)
                          ? prev.filter(t => t !== tag)
                          : [...prev, tag]
                      )
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              {selectedTags.length > 0 && (
                <p className="text-xs text-gray-500">
                  {filteredContacts.length} contact(s) match selected tags
                </p>
              )}
            </div>
          )}

          {enrollMode === 'tags' && allTags.length === 0 && (
            <p className="text-sm text-gray-500">No tags found in your contacts.</p>
          )}

          <Input
            placeholder="Search contacts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading contacts...</div>
          ) : filteredContacts.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {enrollMode === 'tags' && selectedTags.length > 0
                ? 'No contacts match the selected tags.'
                : 'No eligible contacts found.'}
            </div>
          ) : (
            <div className="divide-y">
              <div className="px-4 py-2 bg-gray-50 flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedContacts.length === filteredContacts.length && filteredContacts.length > 0}
                  onChange={toggleAll}
                  className="rounded border-gray-300"
                />
                <span className="text-sm font-medium text-gray-700">
                  Select all ({filteredContacts.length})
                </span>
              </div>
              {filteredContacts.map((contact) => (
                <div
                  key={contact.id}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => toggleContact(contact.id)}
                >
                  <input
                    type="checkbox"
                    checked={selectedContacts.includes(contact.id)}
                    onChange={() => toggleContact(contact.id)}
                    className="rounded border-gray-300"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">
                      {contact.first_name} {contact.last_name}
                    </p>
                    <p className="text-sm text-gray-600">{contact.email}</p>
                  </div>
                  {contact.tags && contact.tags.length > 0 && (
                    <div className="flex gap-1">
                      {contact.tags.slice(0, 3).map((tag: string) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                      {contact.tags.length > 3 && (
                        <span className="text-xs text-gray-400">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center p-6 border-t bg-gray-50">
          <span className="text-sm text-gray-600">
            {selectedContacts.length} contact(s) selected
          </span>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleEnroll} disabled={submitting || selectedContacts.length === 0}>
              {submitting ? 'Enrolling...' : `Enroll ${selectedContacts.length} Contact(s)`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
