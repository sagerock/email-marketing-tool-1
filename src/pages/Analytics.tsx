import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Campaign, AnalyticsEvent } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import { BarChart3, TrendingUp, MousePointer, Mail, AlertCircle, Eye, X } from 'lucide-react'

// Extended campaign type with template data
interface CampaignWithTemplate extends Campaign {
  template?: {
    html_content: string
    name: string
  } | null
}

export default function Analytics() {
  const { selectedClient } = useClient()
  const [campaigns, setCampaigns] = useState<CampaignWithTemplate[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<string>('')
  const [events, setEvents] = useState<AnalyticsEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [showPreviewModal, setShowPreviewModal] = useState(false)

  useEffect(() => {
    fetchCampaigns()
  }, [selectedClient])

  useEffect(() => {
    if (selectedCampaign) {
      fetchEvents(selectedCampaign)
    }
  }, [selectedCampaign])

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
        .select('*, template:templates(html_content, name)')
        .eq('client_id', selectedClient.id)
        .in('status', ['sent', 'sending'])
        .order('created_at', { ascending: false })

      if (error) throw error
      setCampaigns(data || [])
      if (data && data.length > 0 && !selectedCampaign) {
        setSelectedCampaign(data[0].id)
      }
    } catch (error) {
      console.error('Error fetching campaigns:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchEvents = async (campaignId: string) => {
    try {
      const { data, error } = await supabase
        .from('analytics_events')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('timestamp', { ascending: false })

      if (error) throw error
      setEvents(data || [])
    } catch (error) {
      console.error('Error fetching events:', error)
    }
  }

  const getStats = () => {
    const campaign = campaigns.find((c) => c.id === selectedCampaign)
    if (!campaign) {
      return {
        sent: 0,
        delivered: 0,
        opens: 0,
        uniqueOpens: 0,
        clicks: 0,
        uniqueClicks: 0,
        bounces: 0,
        spam: 0,
      }
    }

    const delivered = events.filter((e) => e.event_type === 'delivered').length
    const opens = events.filter((e) => e.event_type === 'open').length
    const uniqueOpens = new Set(
      events.filter((e) => e.event_type === 'open').map((e) => e.email)
    ).size
    const clicks = events.filter((e) => e.event_type === 'click').length
    const uniqueClicks = new Set(
      events.filter((e) => e.event_type === 'click').map((e) => e.email)
    ).size
    const bounces = events.filter((e) => e.event_type === 'bounce').length
    const spam = events.filter((e) => e.event_type === 'spam').length

    return {
      sent: campaign.recipient_count,
      delivered,
      opens,
      uniqueOpens,
      clicks,
      uniqueClicks,
      bounces,
      spam,
    }
  }

  const stats = getStats()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-600">
          Track the performance of your email campaigns
        </p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading analytics...</div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-gray-500">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>No sent campaigns yet. Send a campaign to see analytics.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Campaign Selector */}
          <Card>
            <CardContent className="pt-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Campaign
              </label>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={selectedCampaign}
                onChange={(e) => setSelectedCampaign(e.target.value)}
              >
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name} - {new Date(campaign.created_at).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </CardContent>
          </Card>

          {/* Email Preview */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Email Preview</CardTitle>
              {campaigns.find((c) => c.id === selectedCampaign)?.template?.html_content && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPreviewModal(true)}
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View Full
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {(() => {
                const campaign = campaigns.find((c) => c.id === selectedCampaign)
                const htmlContent = campaign?.template?.html_content
                if (!htmlContent) {
                  return (
                    <div className="text-center py-8 text-gray-500">
                      <Mail className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                      <p>No template preview available</p>
                    </div>
                  )
                }
                return (
                  <div
                    className="relative border border-gray-200 rounded-lg overflow-hidden cursor-pointer hover:border-gray-300 transition-colors"
                    onClick={() => setShowPreviewModal(true)}
                  >
                    <div className="h-[200px] overflow-hidden">
                      <iframe
                        srcDoc={htmlContent}
                        title="Email Preview"
                        className="w-full border-0 pointer-events-none"
                        style={{
                          height: '600px',
                          transform: 'scale(0.333)',
                          transformOrigin: 'top left',
                          width: '300%',
                        }}
                      />
                    </div>
                    <div className="absolute inset-0 bg-transparent hover:bg-black/5 transition-colors" />
                  </div>
                )
              })()}
            </CardContent>
          </Card>

          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatsCard
              title="Sent"
              value={stats.sent}
              icon={Mail}
              color="blue"
            />
            <StatsCard
              title="Delivered"
              value={stats.delivered}
              subtitle={`${((stats.delivered / stats.sent) * 100 || 0).toFixed(1)}% delivery rate`}
              icon={TrendingUp}
              color="green"
            />
            <StatsCard
              title="Opened"
              value={stats.uniqueOpens}
              subtitle={`${((stats.uniqueOpens / stats.delivered) * 100 || 0).toFixed(1)}% open rate`}
              icon={Mail}
              color="purple"
            />
            <StatsCard
              title="Clicked"
              value={stats.uniqueClicks}
              subtitle={`${((stats.uniqueClicks / stats.uniqueOpens) * 100 || 0).toFixed(1)}% click rate`}
              icon={MousePointer}
              color="orange"
            />
          </div>

          {/* Additional Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Engagement Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Total Opens</span>
                    <span className="text-sm font-medium">{stats.opens}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Unique Opens</span>
                    <span className="text-sm font-medium">{stats.uniqueOpens}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Total Clicks</span>
                    <span className="text-sm font-medium">{stats.clicks}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Unique Clicks</span>
                    <span className="text-sm font-medium">{stats.uniqueClicks}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Issues</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Bounces</span>
                    <span className="text-sm font-medium text-red-600">
                      {stats.bounces}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Spam Reports</span>
                    <span className="text-sm font-medium text-red-600">
                      {stats.spam}
                    </span>
                  </div>
                  {(stats.bounces > 0 || stats.spam > 0) && (
                    <div className="pt-2 border-t border-gray-200">
                      <div className="flex items-start gap-2 text-sm text-amber-600">
                        <AlertCircle className="h-4 w-4 mt-0.5" />
                        <span>Review these issues to improve deliverability</span>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recent Events */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Events</CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-center py-8 text-gray-500">
                  No events yet. Events will appear here as recipients interact with your
                  campaign.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                          Email
                        </th>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                          Event
                        </th>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                          Time
                        </th>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">
                          Details
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {events.slice(0, 50).map((event) => (
                        <tr key={event.id} className="hover:bg-gray-50">
                          <td className="py-3 px-4 text-sm text-gray-900">
                            {event.email}
                          </td>
                          <td className="py-3 px-4 text-sm">
                            <span
                              className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                                event.event_type === 'delivered'
                                  ? 'bg-green-100 text-green-800'
                                  : event.event_type === 'open'
                                  ? 'bg-blue-100 text-blue-800'
                                  : event.event_type === 'click'
                                  ? 'bg-purple-100 text-purple-800'
                                  : event.event_type === 'bounce'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {event.event_type}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-600">
                            {new Date(event.timestamp).toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-600">
                            {event.url ? (
                              <span className="truncate max-w-xs inline-block">
                                {event.url}
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Preview Modal */}
          {showPreviewModal && (() => {
            const campaign = campaigns.find((c) => c.id === selectedCampaign)
            const htmlContent = campaign?.template?.html_content
            if (!htmlContent) return null
            return (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
                onClick={() => setShowPreviewModal(false)}
              >
                <div
                  className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {campaign?.subject || 'Email Preview'}
                      </h3>
                      <p className="text-sm text-gray-500">{campaign?.name}</p>
                    </div>
                    <button
                      onClick={() => setShowPreviewModal(false)}
                      className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                    >
                      <X className="h-5 w-5 text-gray-500" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto p-4">
                    <iframe
                      srcDoc={htmlContent}
                      title="Email Preview"
                      className="w-full border border-gray-200 rounded-lg"
                      style={{ height: '600px' }}
                    />
                  </div>
                </div>
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}

function StatsCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
}: {
  title: string
  value: number
  subtitle?: string
  icon: any
  color: string
}) {
  const colorClasses = {
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    purple: 'bg-purple-100 text-purple-600',
    orange: 'bg-orange-100 text-orange-600',
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-600">{title}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{value.toLocaleString()}</p>
            {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
          </div>
          <div className={`p-3 rounded-full ${colorClasses[color as keyof typeof colorClasses]}`}>
            <Icon className="h-6 w-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
