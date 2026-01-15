import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Campaign, AnalyticsEvent } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import { BarChart3, TrendingUp, MousePointer, Mail, AlertCircle, Eye, X, RefreshCw, Download, Table, LayoutDashboard } from 'lucide-react'

const API_URL = import.meta.env.VITE_API_URL || ''

// Extended campaign type with template data
interface CampaignWithTemplate extends Campaign {
  template?: {
    html_content: string
    name: string
  } | null
}

interface EventCounts {
  delivered: number
  opens: number
  uniqueOpens: number
  clicks: number
  uniqueClicks: number
  bounces: number
  spam: number
  unsubscribes: number
}

interface CampaignMetrics {
  id: string
  name: string
  sent_at: string
  sent: number
  delivered: number
  uniqueOpens: number
  uniqueClicks: number
  bounces: number
  unsubscribes: number
}

export default function Analytics() {
  const { selectedClient } = useClient()
  const [campaigns, setCampaigns] = useState<CampaignWithTemplate[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<string>('')
  const [events, setEvents] = useState<AnalyticsEvent[]>([])
  const [eventCounts, setEventCounts] = useState<EventCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPreviewModal, setShowPreviewModal] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ inserted: number; messagesFound: number } | null>(null)
  const [viewMode, setViewMode] = useState<'details' | 'table'>('details')
  const [allCampaignMetrics, setAllCampaignMetrics] = useState<CampaignMetrics[]>([])
  const [loadingMetrics, setLoadingMetrics] = useState(false)

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
      // Fetch recent events for the table (limit 100 for display)
      const { data, error } = await supabase
        .from('analytics_events')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('timestamp', { ascending: false })
        .limit(100)

      if (error) throw error
      setEvents(data || [])

      // Fetch counts separately using count queries (more efficient than fetching all rows)
      const [deliveredRes, opensRes, clicksRes, bouncesRes, spamRes, unsubscribesRes] = await Promise.all([
        supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('event_type', 'delivered'),
        supabase.from('analytics_events').select('email', { count: 'exact' }).eq('campaign_id', campaignId).eq('event_type', 'open'),
        supabase.from('analytics_events').select('email', { count: 'exact' }).eq('campaign_id', campaignId).eq('event_type', 'click'),
        supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('event_type', 'bounce'),
        supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('event_type', 'spam'),
        supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('event_type', 'unsubscribe'),
      ])

      // For unique opens/clicks, we need to get distinct emails
      const [uniqueOpensRes, uniqueClicksRes] = await Promise.all([
        supabase.from('analytics_events').select('email').eq('campaign_id', campaignId).eq('event_type', 'open'),
        supabase.from('analytics_events').select('email').eq('campaign_id', campaignId).eq('event_type', 'click'),
      ])

      const uniqueOpenEmails = new Set(uniqueOpensRes.data?.map(e => e.email) || [])
      const uniqueClickEmails = new Set(uniqueClicksRes.data?.map(e => e.email) || [])

      setEventCounts({
        delivered: deliveredRes.count || 0,
        opens: opensRes.count || 0,
        uniqueOpens: uniqueOpenEmails.size,
        clicks: clicksRes.count || 0,
        uniqueClicks: uniqueClickEmails.size,
        bounces: bouncesRes.count || 0,
        spam: spamRes.count || 0,
        unsubscribes: unsubscribesRes.count || 0,
      })

      console.log(`Event counts - delivered: ${deliveredRes.count}, opens: ${opensRes.count}, clicks: ${clicksRes.count}`)
    } catch (error) {
      console.error('Error fetching events:', error)
    }
  }

  const syncFromSendGrid = async () => {
    if (!selectedCampaign) return

    setSyncing(true)
    setSyncResult(null)

    try {
      const response = await fetch(`${API_URL}/api/campaigns/${selectedCampaign}/sync-sendgrid`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to sync from SendGrid')
      }

      setSyncResult({ inserted: data.inserted, messagesFound: data.messagesFound })

      // Refresh events after sync
      await fetchEvents(selectedCampaign)
    } catch (error) {
      console.error('Error syncing from SendGrid:', error)
      alert(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setSyncing(false)
    }
  }

  const getStats = () => {
    const campaign = campaigns.find((c) => c.id === selectedCampaign)
    if (!campaign || !eventCounts) {
      return {
        sent: 0,
        delivered: 0,
        opens: 0,
        uniqueOpens: 0,
        clicks: 0,
        uniqueClicks: 0,
        bounces: 0,
        spam: 0,
        unsubscribes: 0,
      }
    }

    return {
      sent: campaign.recipient_count,
      delivered: eventCounts.delivered,
      opens: eventCounts.opens,
      uniqueOpens: eventCounts.uniqueOpens,
      clicks: eventCounts.clicks,
      uniqueClicks: eventCounts.uniqueClicks,
      bounces: eventCounts.bounces,
      spam: eventCounts.spam,
      unsubscribes: eventCounts.unsubscribes,
    }
  }

  const stats = getStats()

  // Fetch metrics for all campaigns (for table view)
  const fetchAllCampaignMetrics = async () => {
    if (!selectedClient || campaigns.length === 0) return

    setLoadingMetrics(true)
    try {
      const metricsPromises = campaigns.map(async (campaign) => {
        const [deliveredRes, uniqueOpensRes, uniqueClicksRes, bouncesRes, unsubscribesRes] = await Promise.all([
          supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('event_type', 'delivered'),
          supabase.from('analytics_events').select('email').eq('campaign_id', campaign.id).eq('event_type', 'open'),
          supabase.from('analytics_events').select('email').eq('campaign_id', campaign.id).eq('event_type', 'click'),
          supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('event_type', 'bounce'),
          supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('event_type', 'unsubscribe'),
        ])

        const uniqueOpenEmails = new Set(uniqueOpensRes.data?.map(e => e.email) || [])
        const uniqueClickEmails = new Set(uniqueClicksRes.data?.map(e => e.email) || [])

        return {
          id: campaign.id,
          name: campaign.name,
          sent_at: campaign.sent_at || campaign.created_at,
          sent: campaign.recipient_count || 0,
          delivered: deliveredRes.count || 0,
          uniqueOpens: uniqueOpenEmails.size,
          uniqueClicks: uniqueClickEmails.size,
          bounces: bouncesRes.count || 0,
          unsubscribes: unsubscribesRes.count || 0,
        }
      })

      const metrics = await Promise.all(metricsPromises)
      // Sort by sent_at descending (most recent first)
      metrics.sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
      setAllCampaignMetrics(metrics)
    } catch (error) {
      console.error('Error fetching campaign metrics:', error)
    } finally {
      setLoadingMetrics(false)
    }
  }

  // Load metrics when switching to table view
  useEffect(() => {
    if (viewMode === 'table' && allCampaignMetrics.length === 0 && campaigns.length > 0) {
      fetchAllCampaignMetrics()
    }
  }, [viewMode, campaigns])

  // Export to CSV
  const exportToCSV = () => {
    if (allCampaignMetrics.length === 0) return

    const headers = ['Campaign Name', 'Sent Date', 'Sent', 'Delivered', 'Delivery %', 'Unique Opens', 'Open %', 'Unique Clicks', 'CTR %', 'Bounces', 'Unsubscribes']
    const rows = allCampaignMetrics.map(m => [
      `"${m.name.replace(/"/g, '""')}"`,
      new Date(m.sent_at).toLocaleDateString(),
      m.sent,
      m.delivered,
      m.sent > 0 ? ((m.delivered / m.sent) * 100).toFixed(1) + '%' : '0%',
      m.uniqueOpens,
      m.delivered > 0 ? ((m.uniqueOpens / m.delivered) * 100).toFixed(1) + '%' : '0%',
      m.uniqueClicks,
      m.uniqueOpens > 0 ? ((m.uniqueClicks / m.uniqueOpens) * 100).toFixed(1) + '%' : '0%',
      m.bounces,
      m.unsubscribes,
    ])

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `campaign-analytics-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
          <p className="mt-1 text-sm text-gray-600">
            Track the performance of your email campaigns
          </p>
        </div>
        {campaigns.length > 0 && (
          <div className="flex gap-2">
            <Button
              variant={viewMode === 'details' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setViewMode('details')}
            >
              <LayoutDashboard className="h-4 w-4 mr-2" />
              Campaign Details
            </Button>
            <Button
              variant={viewMode === 'table' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setViewMode('table')}
            >
              <Table className="h-4 w-4 mr-2" />
              All Campaigns
            </Button>
          </div>
        )}
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
      ) : viewMode === 'table' ? (
        /* All Campaigns Table View */
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>All Campaign Analytics</CardTitle>
            <Button variant="outline" size="sm" onClick={exportToCSV} disabled={allCampaignMetrics.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </CardHeader>
          <CardContent>
            {loadingMetrics ? (
              <div className="text-center py-12 text-gray-500">Loading campaign metrics...</div>
            ) : allCampaignMetrics.length === 0 ? (
              <div className="text-center py-12 text-gray-500">No campaign data available.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Campaign</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Sent Date</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Sent</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Delivered</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Del %</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Opens</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Open %</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Clicks</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">CTR %</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Bounces</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Unsubs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {allCampaignMetrics.map((m) => (
                      <tr
                        key={m.id}
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => {
                          setSelectedCampaign(m.id)
                          setViewMode('details')
                        }}
                      >
                        <td className="py-3 px-4 text-sm text-gray-900 font-medium">{m.name}</td>
                        <td className="py-3 px-4 text-sm text-gray-600">{new Date(m.sent_at).toLocaleDateString()}</td>
                        <td className="py-3 px-4 text-sm text-gray-900 text-right">{m.sent.toLocaleString()}</td>
                        <td className="py-3 px-4 text-sm text-gray-900 text-right">{m.delivered.toLocaleString()}</td>
                        <td className="py-3 px-4 text-sm text-gray-600 text-right">
                          {m.sent > 0 ? ((m.delivered / m.sent) * 100).toFixed(1) : '0'}%
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-900 text-right">{m.uniqueOpens.toLocaleString()}</td>
                        <td className="py-3 px-4 text-sm text-gray-600 text-right">
                          {m.delivered > 0 ? ((m.uniqueOpens / m.delivered) * 100).toFixed(1) : '0'}%
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-900 text-right">{m.uniqueClicks.toLocaleString()}</td>
                        <td className="py-3 px-4 text-sm text-gray-600 text-right">
                          {m.uniqueOpens > 0 ? ((m.uniqueClicks / m.uniqueOpens) * 100).toFixed(1) : '0'}%
                        </td>
                        <td className="py-3 px-4 text-sm text-red-600 text-right">{m.bounces}</td>
                        <td className="py-3 px-4 text-sm text-orange-600 text-right">{m.unsubscribes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Campaign Details View */}
          {/* Campaign Selector */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select Campaign
                  </label>
                  <select
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    value={selectedCampaign}
                    onChange={(e) => {
                      setSelectedCampaign(e.target.value)
                      setSyncResult(null)
                    }}
                  >
                    {campaigns.map((campaign) => (
                      <option key={campaign.id} value={campaign.id}>
                        {campaign.name} - {new Date(campaign.created_at).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  variant="outline"
                  onClick={syncFromSendGrid}
                  disabled={syncing || !selectedCampaign}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? 'Syncing...' : 'Sync from SendGrid'}
                </Button>
              </div>
              {syncResult && (
                <div className="mt-3 text-sm text-green-600">
                  Sync complete: Found {syncResult.messagesFound} messages, inserted {syncResult.inserted} new events
                </div>
              )}
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
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Unsubscribes</span>
                    <span className="text-sm font-medium text-orange-600">
                      {stats.unsubscribes}
                    </span>
                  </div>
                  {(stats.bounces > 0 || stats.spam > 0 || stats.unsubscribes > 0) && (
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
