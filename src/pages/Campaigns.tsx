import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Campaign, Template } from '../types/index.js'
import { Card, CardContent } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { Plus, Send, X, Mail, Edit2 } from 'lucide-react'

export default function Campaigns() {
  const { selectedClient } = useClient()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null)
  const [sendingCampaignId, setSendingCampaignId] = useState<string | null>(null)
  const [showTestEmailModal, setShowTestEmailModal] = useState<Campaign | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchCampaigns()
  }, [selectedClient])

  const fetchCampaigns = async () => {
    if (!selectedClient) {
      setCampaigns([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('created_at', { ascending: false })

      if (error) throw error
      setCampaigns(data || [])
    } catch (error) {
      console.error('Error fetching campaigns:', error)
    } finally {
      setLoading(false)
    }
  }

  const getStatusColor = (status: Campaign['status']) => {
    switch (status) {
      case 'draft':
        return 'default'
      case 'scheduled':
        return 'info'
      case 'sending':
        return 'warning'
      case 'sent':
        return 'success'
      case 'failed':
        return 'danger'
      default:
        return 'default'
    }
  }

  const handleSendCampaign = async (campaignId: string, campaign: Campaign) => {
    // Check for compliance tags before sending
    if (campaign.template_id) {
      try {
        const { data: template, error } = await supabase
          .from('templates')
          .select('html_content')
          .eq('id', campaign.template_id)
          .single()

        if (!error && template) {
          const html = template.html_content.toLowerCase()
          const hasUnsubscribe = html.includes('{{unsubscribe_url}}')
          const hasMailingAddress = html.includes('{{mailing_address}}')

          if (!hasUnsubscribe || !hasMailingAddress) {
            const missing = []
            if (!hasUnsubscribe) missing.push('{{unsubscribe_url}}')
            if (!hasMailingAddress) missing.push('{{mailing_address}}')

            if (!confirm(
              `⚠️ CAN-SPAM WARNING\n\n` +
              `Your template is missing required tags:\n${missing.join(', ')}\n\n` +
              `Sending without these tags may violate CAN-SPAM law.\n` +
              `Penalties can reach $51,744 per email.\n\n` +
              `Are you SURE you want to send anyway?`
            )) {
              return
            }
          }
        }
      } catch (error) {
        console.error('Error checking template compliance:', error)
      }
    }

    if (!confirm('Are you sure you want to send this campaign? This cannot be undone.')) {
      return
    }

    setSendingCampaignId(campaignId)
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001'
      const response = await fetch(`${apiUrl}/api/send-campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send campaign')
      }

      alert(`Campaign sent successfully to ${data.sent} recipients!`)
      fetchCampaigns()
    } catch (error) {
      console.error('Error sending campaign:', error)
      alert(error instanceof Error ? error.message : 'Failed to send campaign')
    } finally {
      setSendingCampaignId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Campaigns</h1>
          <p className="mt-1 text-sm text-gray-600">
            Create and manage your email campaigns
          </p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Create Campaign
        </Button>
      </div>

      {/* Campaigns List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading campaigns...</div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-gray-500">
              <Send className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>No campaigns yet. Create your first campaign to get started.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {campaign.name}
                      </h3>
                      <Badge variant={getStatusColor(campaign.status)}>
                        {campaign.status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-gray-500">Subject</p>
                        <p className="text-gray-900">{campaign.subject}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">From</p>
                        <p className="text-gray-900">
                          {campaign.from_name} &lt;{campaign.from_email}&gt;
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-500">Recipients</p>
                        <p className="text-gray-900">{campaign.recipient_count}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">
                          {campaign.scheduled_at ? 'Scheduled For' : 'Created'}
                        </p>
                        <p className="text-gray-900">
                          {new Date(
                            campaign.scheduled_at || campaign.created_at
                          ).toLocaleString()}
                        </p>
                      </div>
                      {campaign.filter_tags && campaign.filter_tags.length > 0 && (
                        <div className="col-span-2">
                          <p className="text-gray-500 mb-1">Target Tags</p>
                          <div className="flex flex-wrap gap-1">
                            {campaign.filter_tags.map((tag) => (
                              <Badge key={tag} variant="info">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {campaign.status === 'draft' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingCampaign(campaign)}
                        >
                          <Edit2 className="h-4 w-4 mr-1" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setShowTestEmailModal(campaign)}
                        >
                          <Mail className="h-4 w-4 mr-1" />
                          Send Test
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSendCampaign(campaign.id, campaign)}
                          disabled={sendingCampaignId === campaign.id}
                        >
                          <Send className="h-4 w-4 mr-1" />
                          {sendingCampaignId === campaign.id ? 'Sending...' : 'Send Now'}
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(campaign.id)}
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

      {/* Create Campaign Modal */}
      {showCreateModal && selectedClient && (
        <CreateCampaignModal
          clientId={selectedClient.id}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false)
            fetchCampaigns()
          }}
        />
      )}

      {/* Edit Campaign Modal */}
      {editingCampaign && selectedClient && (
        <CreateCampaignModal
          clientId={selectedClient.id}
          campaign={editingCampaign}
          onClose={() => setEditingCampaign(null)}
          onSuccess={() => {
            setEditingCampaign(null)
            fetchCampaigns()
          }}
        />
      )}

      {/* Send Test Email Modal */}
      {showTestEmailModal && (
        <SendTestEmailModal
          campaign={showTestEmailModal}
          onClose={() => setShowTestEmailModal(null)}
        />
      )}
    </div>
  )

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this campaign?')) return

    try {
      const { error } = await supabase.from('campaigns').delete().eq('id', id)
      if (error) throw error
      fetchCampaigns()
    } catch (error) {
      console.error('Error deleting campaign:', error)
      alert('Failed to delete campaign')
    }
  }
}

// Helper to convert Date to local datetime string for datetime-local input
function toLocalDateTimeString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function CreateCampaignModal({
  onClose,
  onSuccess,
  clientId,
  campaign,
}: {
  onClose: () => void
  onSuccess: () => void
  clientId: string
  campaign?: Campaign
}) {
  const isEditing = !!campaign
  const [templates, setTemplates] = useState<Template[]>([])
  const [totalContactCount, setTotalContactCount] = useState(0)
  const [filteredTagCount, setFilteredTagCount] = useState<number | null>(null)
  const countRequestVersion = useRef(0)
  const [allTags, setAllTags] = useState<string[]>([])
  const [verifiedSenders, setVerifiedSenders] = useState<{email: string, name: string}[]>([])
  const [defaultUtmParams, setDefaultUtmParams] = useState('')
  const [formData, setFormData] = useState({
    name: campaign?.name || '',
    template_id: campaign?.template_id || '',
    subject: campaign?.subject || '',
    from_email: campaign?.from_email || '',
    from_name: campaign?.from_name || '',
    reply_to: campaign?.reply_to || '',
    filter_tags: campaign?.filter_tags || ([] as string[]),
    scheduled_at: campaign?.scheduled_at ? toLocalDateTimeString(new Date(campaign.scheduled_at)) : '',
    utm_params: campaign?.utm_params || '',
  })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchTemplates()
    fetchContacts()
    fetchVerifiedSenders()
  }, [])

  const fetchVerifiedSenders = async () => {
    const { data } = await supabase
      .from('clients')
      .select('verified_senders, default_utm_params')
      .eq('id', clientId)
      .single()

    if (data?.verified_senders) {
      setVerifiedSenders(data.verified_senders)
    }
    if (data?.default_utm_params) {
      setDefaultUtmParams(data.default_utm_params)
      // Pre-populate utm_params for new campaigns
      if (!campaign) {
        setFormData(prev => ({ ...prev, utm_params: data.default_utm_params }))
      }
    }
  }

  // Update form data when campaign prop changes
  useEffect(() => {
    if (campaign) {
      setFormData({
        name: campaign.name || '',
        template_id: campaign.template_id || '',
        subject: campaign.subject || '',
        from_email: campaign.from_email || '',
        from_name: campaign.from_name || '',
        reply_to: campaign.reply_to || '',
        filter_tags: campaign.filter_tags || [],
        scheduled_at: campaign.scheduled_at ? toLocalDateTimeString(new Date(campaign.scheduled_at)) : '',
        utm_params: campaign.utm_params || '',
      })
    }
  }, [campaign])

  // Fetch filtered count when tags change
  useEffect(() => {
    if (formData.filter_tags.length > 0) {
      fetchFilteredTagCount(formData.filter_tags)
    } else {
      setFilteredTagCount(null)
    }
  }, [formData.filter_tags])

  const fetchFilteredTagCount = async (tags: string[]) => {
    if (tags.length === 0) {
      setFilteredTagCount(null)
      return
    }

    // Increment version and capture it for this request
    countRequestVersion.current += 1
    const thisRequestVersion = countRequestVersion.current

    try {
      const { count, error } = await supabase
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .eq('unsubscribed', false)
        .overlaps('tags', tags)

      if (error) throw error

      // Only update if this is still the latest request
      if (thisRequestVersion === countRequestVersion.current) {
        setFilteredTagCount(count || 0)
      }
    } catch (error) {
      console.error('Error fetching filtered count:', error)
    }
  }

  const fetchTemplates = async () => {
    const { data } = await supabase
      .from('templates')
      .select('*')
      .eq('client_id', clientId)
    setTemplates(data || [])
  }

  const fetchContacts = async () => {
    // Get total count of subscribed contacts
    const { count } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('unsubscribed', false)

    setTotalContactCount(count || 0)

    // Get unique tags from the tags table
    const { data: tagsData } = await supabase
      .from('tags')
      .select('name')
      .eq('client_id', clientId)
      .order('name')

    if (tagsData) {
      setAllTags(tagsData.map(t => t.name))
    }
  }

  const handleTemplateChange = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId)
    if (template) {
      setFormData({
        ...formData,
        template_id: templateId,
        subject: template.subject,
      })
    }
  }

  const checkComplianceTags = () => {
    const selectedTemplate = templates.find((t) => t.id === formData.template_id)
    if (!selectedTemplate) return { hasUnsubscribe: true, hasMailingAddress: true }

    const html = selectedTemplate.html_content.toLowerCase()
    const hasUnsubscribe = html.includes('{{unsubscribe_url}}')
    const hasMailingAddress = html.includes('{{mailing_address}}')

    return { hasUnsubscribe, hasMailingAddress }
  }

  const complianceCheck = checkComplianceTags()
  const hasMissingTags = !complianceCheck.hasUnsubscribe || !complianceCheck.hasMailingAddress

  const toggleTag = (tag: string) => {
    setFormData({
      ...formData,
      filter_tags: formData.filter_tags.includes(tag)
        ? formData.filter_tags.filter((t) => t !== tag)
        : [...formData.filter_tags, tag],
    })
  }

  const getRecipientCount = () => {
    if (formData.filter_tags.length === 0) return totalContactCount
    // Use database count for accurate OR logic filtering
    return filteredTagCount
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const recipientCount = getRecipientCount() ?? 0
      // Convert local datetime to UTC ISO string for proper timezone handling
      const scheduledAtUtc = formData.scheduled_at
        ? new Date(formData.scheduled_at).toISOString()
        : null
      const campaignData = {
        ...formData,
        template_id: formData.template_id || null,
        reply_to: formData.reply_to || null,
        scheduled_at: scheduledAtUtc,
        recipient_count: recipientCount,
        status: formData.scheduled_at ? 'scheduled' : 'draft',
        client_id: clientId,
      }

      if (isEditing && campaign) {
        const { error } = await supabase
          .from('campaigns')
          .update(campaignData)
          .eq('id', campaign.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('campaigns').insert(campaignData)
        if (error) throw error
      }

      onSuccess()
    } catch (error) {
      console.error(`Error ${isEditing ? 'updating' : 'creating'} campaign:`, error)
      alert(`Failed to ${isEditing ? 'update' : 'create'} campaign`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">
            {isEditing ? 'Edit Campaign' : 'Create New Campaign'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Campaign Name *"
            required
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Design
            </label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={formData.template_id}
              onChange={(e) => handleTemplateChange(e.target.value)}
            >
              <option value="">No design selected (custom HTML)</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>

          {/* CAN-SPAM Compliance Warning */}
          {formData.template_id && hasMissingTags && (
            <div className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-amber-800">
                    ⚠️ Missing Required CAN-SPAM Tags
                  </h3>
                  <div className="mt-2 text-sm text-amber-700">
                    <p className="mb-1">Your template is missing:</p>
                    <ul className="list-disc list-inside space-y-1">
                      {!complianceCheck.hasUnsubscribe && (
                        <li>
                          <code className="bg-amber-100 px-1 rounded">{'{{unsubscribe_url}}'}</code> - Required by law
                        </li>
                      )}
                      {!complianceCheck.hasMailingAddress && (
                        <li>
                          <code className="bg-amber-100 px-1 rounded">{'{{mailing_address}}'}</code> - Required by CAN-SPAM
                        </li>
                      )}
                    </ul>
                    <p className="mt-2 text-xs">
                      <strong>Important:</strong> Sending emails without these tags may violate CAN-SPAM law.
                      Penalties can reach $51,744 per email. Please edit your template to include these tags.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Merge Tags Help */}
          <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
            <h3 className="text-sm font-semibold text-blue-900 mb-2">
              📝 Available Merge Tags
            </h3>
            <p className="text-xs text-blue-800 mb-2">
              Use these tags in your email template to personalize each email:
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-white rounded px-2 py-1.5 border border-blue-100">
                <code className="text-blue-700 font-mono">{'{{first_name}}'}</code>
                <span className="text-gray-600 ml-2">→ First name</span>
              </div>
              <div className="bg-white rounded px-2 py-1.5 border border-blue-100">
                <code className="text-blue-700 font-mono">{'{{last_name}}'}</code>
                <span className="text-gray-600 ml-2">→ Last name</span>
              </div>
              <div className="bg-white rounded px-2 py-1.5 border border-blue-100">
                <code className="text-blue-700 font-mono">{'{{email}}'}</code>
                <span className="text-gray-600 ml-2">→ Email</span>
              </div>
              <div className="bg-white rounded px-2 py-1.5 border border-blue-100">
                <code className="text-blue-700 font-mono">{'{{unsubscribe_url}}'}</code>
                <span className="text-gray-600 ml-2">→ Unsubscribe link</span>
              </div>
              <div className="bg-white rounded px-2 py-1.5 border border-blue-100 col-span-2">
                <code className="text-blue-700 font-mono">{'{{mailing_address}}'}</code>
                <span className="text-gray-600 ml-2">→ Your mailing address (CAN-SPAM required)</span>
              </div>
            </div>
            <p className="text-xs text-blue-700 mt-3 font-medium">
              💡 Example footer: "{'{{mailing_address}}'} | <a href="{'{{unsubscribe_url}}'}">Unsubscribe</a>"
            </p>
          </div>

          <Input
            label="Email Subject *"
            required
            value={formData.subject}
            onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              From Sender *
            </label>
            {verifiedSenders.length > 0 ? (
              <select
                required
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={`${formData.from_email}|||${formData.from_name}`}
                onChange={(e) => {
                  const [email, name] = e.target.value.split('|||')
                  setFormData({ ...formData, from_email: email, from_name: name })
                }}
              >
                <option value="">Select a verified sender</option>
                {verifiedSenders.map((sender, index) => (
                  <option key={index} value={`${sender.email}|||${sender.name}`}>
                    {sender.name} &lt;{sender.email}&gt;
                  </option>
                ))}
              </select>
            ) : (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
                No verified senders configured. Please add verified senders in Settings first.
              </div>
            )}
            <p className="mt-1 text-xs text-gray-500">
              This email must be verified in SendGrid. Manage senders in Settings.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reply-To Email (optional)
            </label>
            <input
              type="email"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="replies@example.com"
              value={formData.reply_to}
              onChange={(e) =>
                setFormData({ ...formData, reply_to: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-gray-500">
              If left blank, replies will go to the sender email above.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              UTM Parameters (optional)
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="utm_source=newsletter&utm_medium=email"
              value={formData.utm_params}
              onChange={(e) =>
                setFormData({ ...formData, utm_params: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-gray-500">
              These parameters will be appended to all links in the email.
              {defaultUtmParams && !campaign && (
                <span className="text-blue-600"> Pre-filled from client settings.</span>
              )}
            </p>
          </div>

          {allTags.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Target Recipients by Tags (optional)
              </label>
              <div className="flex flex-wrap gap-2 p-3 border border-gray-300 rounded-md">
                {allTags.map((tag) => (
                  <Badge
                    key={tag}
                    variant={formData.filter_tags.includes(tag) ? 'info' : 'default'}
                    className="cursor-pointer hover:opacity-80"
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 text-sm text-gray-500">
                {getRecipientCount() !== null ? getRecipientCount() : '...'} recipient(s) will receive this campaign
              </p>
            </div>
          )}

          <Input
            label="Schedule Send Time (optional)"
            type="datetime-local"
            value={formData.scheduled_at}
            onChange={(e) =>
              setFormData({ ...formData, scheduled_at: e.target.value })
            }
          />

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? isEditing ? 'Saving...' : 'Creating...'
                : isEditing ? 'Save Changes'
                : formData.scheduled_at
                ? 'Schedule Campaign'
                : 'Create Draft'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SendTestEmailModal({
  campaign,
  onClose,
}: {
  campaign: Campaign
  onClose: () => void
}) {
  const [testEmails, setTestEmails] = useState('')
  const [sending, setSending] = useState(false)

  const handleSendTest = async (e: React.FormEvent) => {
    e.preventDefault()
    setSending(true)

    try {
      // Parse comma-separated emails
      const emails = testEmails
        .split(',')
        .map(email => email.trim())
        .filter(email => email.length > 0)

      if (emails.length === 0) {
        throw new Error('Please enter at least one email address')
      }

      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001'
      const response = await fetch(`${apiUrl}/api/send-test-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId: campaign.id,
          testEmails: emails,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send test email')
      }

      alert(data.message)
      onClose()
    } catch (error) {
      console.error('Error sending test email:', error)
      alert(error instanceof Error ? error.message : 'Failed to send test email')
    } finally {
      setSending(false)
    }
  }

  const emailCount = testEmails
    .split(',')
    .map(email => email.trim())
    .filter(email => email.length > 0).length

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Send Test Email</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSendTest} className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-3">
              Campaign: <strong>{campaign.name}</strong>
            </p>
            <p className="text-sm text-gray-600 mb-3">
              Subject: <strong>{campaign.subject}</strong>
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Test Email Address(es) *
            </label>
            <input
              type="text"
              required
              value={testEmails}
              onChange={(e) => setTestEmails(e.target.value)}
              placeholder="email1@example.com, email2@example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Separate multiple emails with commas {emailCount > 0 && `(${emailCount} recipient${emailCount > 1 ? 's' : ''})`}
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
            <p className="text-sm text-blue-800">
              Test emails will be sent with placeholder data (First Name: John, Last Name: Doe)
              and the subject will be prefixed with [TEST].
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending || emailCount === 0}>
              {sending ? 'Sending...' : `Send Test${emailCount > 1 ? ` (${emailCount})` : ''}`}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
