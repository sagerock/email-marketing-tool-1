import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Campaign, Template, Contact } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Badge from '../components/ui/Badge'
import { Plus, Send, Calendar, X } from 'lucide-react'

export default function Campaigns() {
  const { selectedClient } = useClient()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
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
                      <Button size="sm" variant="outline">
                        Edit
                      </Button>
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

function CreateCampaignModal({
  onClose,
  onSuccess,
  clientId,
}: {
  onClose: () => void
  onSuccess: () => void
  clientId: string
}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [formData, setFormData] = useState({
    name: '',
    template_id: '',
    subject: '',
    from_email: '',
    from_name: '',
    reply_to: '',
    filter_tags: [] as string[],
    scheduled_at: '',
    ip_pool: '',
  })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchTemplates()
    fetchContacts()
  }, [])

  const fetchTemplates = async () => {
    const { data } = await supabase
      .from('templates')
      .select('*')
      .eq('client_id', clientId)
    setTemplates(data || [])
  }

  const fetchContacts = async () => {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('client_id', clientId)
      .eq('unsubscribed', false) // Only fetch subscribed contacts
    if (data) {
      setContacts(data)
      const tags = Array.from(
        new Set(data.flatMap((c) => c.tags || []))
      ).sort()
      setAllTags(tags)
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

  const toggleTag = (tag: string) => {
    setFormData({
      ...formData,
      filter_tags: formData.filter_tags.includes(tag)
        ? formData.filter_tags.filter((t) => t !== tag)
        : [...formData.filter_tags, tag],
    })
  }

  const getRecipientCount = () => {
    if (formData.filter_tags.length === 0) return contacts.length
    return contacts.filter((contact) =>
      formData.filter_tags.every((tag) => contact.tags?.includes(tag))
    ).length
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      const recipientCount = getRecipientCount()
      const campaignData = {
        ...formData,
        template_id: formData.template_id || null,
        reply_to: formData.reply_to || null,
        scheduled_at: formData.scheduled_at || null,
        ip_pool: formData.ip_pool || null,
        recipient_count: recipientCount,
        status: formData.scheduled_at ? 'scheduled' : 'draft',
        client_id: clientId,
      }

      const { error } = await supabase.from('campaigns').insert(campaignData)
      if (error) throw error
      onSuccess()
    } catch (error) {
      console.error('Error creating campaign:', error)
      alert('Failed to create campaign')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Create New Campaign</h2>
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

          <Input
            label="Email Subject *"
            required
            value={formData.subject}
            onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="From Name *"
              required
              value={formData.from_name}
              onChange={(e) =>
                setFormData({ ...formData, from_name: e.target.value })
              }
            />
            <Input
              label="From Email *"
              type="email"
              required
              value={formData.from_email}
              onChange={(e) =>
                setFormData({ ...formData, from_email: e.target.value })
              }
            />
          </div>

          <Input
            label="Reply-To Email"
            type="email"
            value={formData.reply_to}
            onChange={(e) =>
              setFormData({ ...formData, reply_to: e.target.value })
            }
          />

          <Input
            label="IP Pool (optional)"
            placeholder="SendGrid IP pool name"
            value={formData.ip_pool}
            onChange={(e) =>
              setFormData({ ...formData, ip_pool: e.target.value })
            }
          />

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
                {getRecipientCount()} recipient(s) will receive this campaign
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
                ? 'Creating...'
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
