import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useClient } from '../context/ClientContext'
import type { Campaign, AnalyticsEvent, Tag } from '../types/index.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Badge from '../components/ui/Badge'
import Input from '../components/ui/Input'
import { BarChart3, TrendingUp, MousePointer, Mail, AlertCircle, Eye, X, RefreshCw, Download, Table, LayoutDashboard, Users, Tag as TagIcon } from 'lucide-react'
import type { Contact } from '../types/index.js'

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
  uniqueUnsubscribeClicks: number
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

interface SendGridStats {
  requests: number
  delivered: number
  opens: number
  unique_opens: number
  clicks: number
  unique_clicks: number
  bounces: number
  bounce_drops: number
  blocks: number
  spam_reports: number
  spam_report_drops: number
  unsubscribes: number
  unsubscribe_drops: number
  invalid_emails: number
  deferred: number
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
  const [viewMode, setViewMode] = useState<'details' | 'table' | 'subscribers'>('details')
  const [allCampaignMetrics, setAllCampaignMetrics] = useState<CampaignMetrics[]>([])
  const [loadingMetrics, setLoadingMetrics] = useState(false)
  const [subscriberTab, setSubscriberTab] = useState<'top' | 'bounced' | 'unsubscribed'>('top')
  const [topSubscribers, setTopSubscribers] = useState<Contact[]>([])
  const [bouncedContacts, setBouncedContacts] = useState<(Contact & { campaign_name?: string })[]>([])
  const [unsubscribedContacts, setUnsubscribedContacts] = useState<Contact[]>([])
  const [showUnknownDateUnsubs, setShowUnknownDateUnsubs] = useState(false)
  const [loadingSubscribers, setLoadingSubscribers] = useState(false)
  const [bounceFilter, setBounceFilter] = useState<'all' | 'hard' | 'soft'>('all')
  const [eventFilter, setEventFilter] = useState<'all' | 'open' | 'click'>('all')
  const [filteredEventContacts, setFilteredEventContacts] = useState<AnalyticsEvent[]>([])
  const [loadingFilteredEvents, setLoadingFilteredEvents] = useState(false)
  const [showTagModal, setShowTagModal] = useState(false)
  const [availableTags, setAvailableTags] = useState<Tag[]>([])
  const [selectedTag, setSelectedTag] = useState('')
  const [newTagName, setNewTagName] = useState('')
  const [taggingInProgress, setTaggingInProgress] = useState(false)
  const [sendgridStats, setSendgridStats] = useState<SendGridStats | null>(null)
  const [loadingSendgridStats, setLoadingSendgridStats] = useState(false)
  const [sendgridStatsError, setSendgridStatsError] = useState<string | null>(null)

  useEffect(() => {
    fetchCampaigns()
  }, [selectedClient])

  useEffect(() => {
    if (selectedCampaign) {
      fetchEvents(selectedCampaign)
      fetchSendGridStats(selectedCampaign)
    }
  }, [selectedCampaign])

  // Fetch all events of a specific type when filter changes
  useEffect(() => {
    if (eventFilter !== 'all' && selectedCampaign) {
      fetchFilteredEvents(selectedCampaign, eventFilter)
    }
  }, [eventFilter, selectedCampaign])

  const fetchFilteredEvents = async (campaignId: string, eventType: 'open' | 'click') => {
    setLoadingFilteredEvents(true)
    try {
      const { data, error } = await supabase
        .from('analytics_events')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('event_type', eventType)
        .order('timestamp', { ascending: false })

      if (error) throw error

      // Deduplicate by email to get unique contacts
      // For clicks, exclude unsubscribe link clicks
      const emailMap = new Map<string, AnalyticsEvent>()
      for (const event of (data || [])) {
        // Skip unsubscribe clicks when showing click contacts
        if (eventType === 'click' && event.url?.includes('/unsubscribe')) {
          continue
        }
        if (!emailMap.has(event.email)) {
          emailMap.set(event.email, event)
        }
      }
      setFilteredEventContacts(Array.from(emailMap.values()))
    } catch (error) {
      console.error('Error fetching filtered events:', error)
    } finally {
      setLoadingFilteredEvents(false)
    }
  }

  const fetchAvailableTags = async () => {
    if (!selectedClient) return
    try {
      const { data, error } = await supabase
        .from('tags')
        .select('*')
        .eq('client_id', selectedClient.id)
        .order('name')
      if (error) throw error
      setAvailableTags(data || [])
    } catch (error) {
      console.error('Error fetching tags:', error)
    }
  }

  const applyTagToFilteredContacts = async () => {
    const tagName = selectedTag || newTagName.trim()
    if (!tagName || !selectedClient || filteredEventContacts.length === 0) return

    setTaggingInProgress(true)
    try {
      const emails = filteredEventContacts.map(e => e.email)

      // Fetch contacts by email for this client
      const { data: contacts, error: fetchError } = await supabase
        .from('contacts')
        .select('id, email, tags')
        .eq('client_id', selectedClient.id)
        .in('email', emails)

      if (fetchError) throw fetchError

      // Update each contact to add the tag (if not already present)
      let updatedCount = 0
      for (const contact of (contacts || [])) {
        const currentTags = contact.tags || []
        if (!currentTags.includes(tagName)) {
          const { error: updateError } = await supabase
            .from('contacts')
            .update({ tags: [...currentTags, tagName] })
            .eq('id', contact.id)
          if (updateError) throw updateError
          updatedCount++
        }
      }

      // Upsert the tag to the tags table
      await supabase.from('tags').upsert(
        { name: tagName, client_id: selectedClient.id },
        { onConflict: 'name,client_id' }
      )

      alert(`Tagged ${updatedCount} contacts with "${tagName}"`)
      setShowTagModal(false)
      setSelectedTag('')
      setNewTagName('')
    } catch (error) {
      console.error('Error applying tag:', error)
      alert('Failed to apply tag. Please try again.')
    } finally {
      setTaggingInProgress(false)
    }
  }

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

      // For unique opens/clicks, we need to paginate to get ALL distinct emails
      // (Supabase default limit is 1000 rows)
      const fetchOpenEmails = async () => {
        const emails: string[] = []
        let page = 0
        const pageSize = 1000

        while (true) {
          const { data, error } = await supabase
            .from('analytics_events')
            .select('email')
            .eq('campaign_id', campaignId)
            .eq('event_type', 'open')
            .range(page * pageSize, (page + 1) * pageSize - 1)

          if (error) throw error
          if (!data || data.length === 0) break

          emails.push(...data.map(d => d.email))
          if (data.length < pageSize) break
          page++
        }
        return emails
      }

      const fetchClickEmails = async () => {
        const clicks: { email: string; url: string | null }[] = []
        let page = 0
        const pageSize = 1000

        while (true) {
          const { data, error } = await supabase
            .from('analytics_events')
            .select('email, url')
            .eq('campaign_id', campaignId)
            .eq('event_type', 'click')
            .range(page * pageSize, (page + 1) * pageSize - 1)

          if (error) throw error
          if (!data || data.length === 0) break

          clicks.push(...data)
          if (data.length < pageSize) break
          page++
        }
        return clicks
      }

      const [openEmails, clickEmails] = await Promise.all([
        fetchOpenEmails(),
        fetchClickEmails(),
      ])

      const uniqueOpenEmails = new Set(openEmails)

      // Separate clicks into engaged vs unsubscribe clicks
      const engagedClickEmails = new Set<string>()
      const unsubscribeClickEmails = new Set<string>()
      for (const event of clickEmails) {
        const isUnsubscribeClick = event.url?.includes('/unsubscribe')
        if (isUnsubscribeClick) {
          unsubscribeClickEmails.add(event.email)
        } else {
          engagedClickEmails.add(event.email)
        }
      }

      setEventCounts({
        delivered: deliveredRes.count || 0,
        opens: opensRes.count || 0,
        uniqueOpens: uniqueOpenEmails.size,
        clicks: clicksRes.count || 0,
        uniqueClicks: engagedClickEmails.size,
        uniqueUnsubscribeClicks: unsubscribeClickEmails.size,
        bounces: bouncesRes.count || 0,
        spam: spamRes.count || 0,
        unsubscribes: unsubscribesRes.count || 0,
      })

      console.log(`Event counts - delivered: ${deliveredRes.count}, opens: ${opensRes.count}, clicks: ${clicksRes.count}`)
    } catch (error) {
      console.error('Error fetching events:', error)
    }
  }

  const fetchSendGridStats = async (campaignId: string) => {
    setLoadingSendgridStats(true)
    setSendgridStatsError(null)
    setSendgridStats(null)

    try {
      const response = await fetch(`${API_URL}/api/campaigns/${campaignId}/sendgrid-stats`)
      const data = await response.json()

      if (!response.ok) {
        // Don't show error for campaigns sent before category tracking was added
        if (data.error?.includes('No stats found') || response.status === 404) {
          console.log('No SendGrid category stats available for this campaign (likely sent before tracking was added)')
          setSendgridStatsError('Stats not available - campaign was sent before SendGrid category tracking was enabled')
        } else {
          console.error('SendGrid stats error:', data.error)
          setSendgridStatsError(data.error || 'Failed to fetch SendGrid stats')
        }
        return
      }

      setSendgridStats(data.stats)
      console.log('SendGrid stats loaded:', data.stats)
    } catch (error) {
      console.error('Error fetching SendGrid stats:', error)
      setSendgridStatsError('Failed to connect to stats API')
    } finally {
      setLoadingSendgridStats(false)
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
        uniqueUnsubscribeClicks: 0,
        bounces: 0,
        blocks: 0,
        spam: 0,
        unsubscribes: 0,
        source: 'none' as const,
      }
    }

    // Use SendGrid stats when available (authoritative), fall back to webhook stats
    if (sendgridStats) {
      return {
        sent: sendgridStats.requests,
        delivered: sendgridStats.delivered,
        opens: sendgridStats.opens,
        uniqueOpens: sendgridStats.unique_opens,
        clicks: sendgridStats.clicks,
        uniqueClicks: sendgridStats.unique_clicks,
        uniqueUnsubscribeClicks: eventCounts.uniqueUnsubscribeClicks, // Not in SendGrid stats
        bounces: sendgridStats.bounces,
        blocks: sendgridStats.blocks,
        spam: sendgridStats.spam_reports,
        unsubscribes: sendgridStats.unsubscribes,
        source: 'sendgrid' as const,
        // Additional SendGrid-only metrics
        bounceDrops: sendgridStats.bounce_drops,
        spamDrops: sendgridStats.spam_report_drops,
        unsubscribeDrops: sendgridStats.unsubscribe_drops,
        invalidEmails: sendgridStats.invalid_emails,
        deferred: sendgridStats.deferred,
      }
    }

    // Fall back to webhook-derived stats
    return {
      sent: campaign.recipient_count,
      delivered: eventCounts.delivered,
      opens: eventCounts.opens,
      uniqueOpens: eventCounts.uniqueOpens,
      clicks: eventCounts.clicks,
      uniqueClicks: eventCounts.uniqueClicks,
      uniqueUnsubscribeClicks: eventCounts.uniqueUnsubscribeClicks,
      bounces: eventCounts.bounces,
      blocks: 0,
      spam: eventCounts.spam,
      unsubscribes: eventCounts.unsubscribes,
      source: 'webhook' as const,
    }
  }

  const stats = getStats()

  // Helper to fetch all emails with pagination (Supabase default limit is 1000)
  const fetchAllEmailsForCampaign = async (campaignId: string, eventType: string) => {
    const emails: string[] = []
    let page = 0
    const pageSize = 1000

    while (true) {
      const { data, error } = await supabase
        .from('analytics_events')
        .select('email')
        .eq('campaign_id', campaignId)
        .eq('event_type', eventType)
        .range(page * pageSize, (page + 1) * pageSize - 1)

      if (error) throw error
      if (!data || data.length === 0) break

      emails.push(...data.map(e => e.email))
      if (data.length < pageSize) break
      page++
    }
    return emails
  }

  // Fetch metrics for all campaigns (for table view)
  const fetchAllCampaignMetrics = async () => {
    if (!selectedClient || campaigns.length === 0) return

    setLoadingMetrics(true)
    try {
      const metricsPromises = campaigns.map(async (campaign) => {
        const [deliveredRes, openEmails, clickEmails, bouncesRes, unsubscribesRes] = await Promise.all([
          supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('event_type', 'delivered'),
          fetchAllEmailsForCampaign(campaign.id, 'open'),
          fetchAllEmailsForCampaign(campaign.id, 'click'),
          supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('event_type', 'bounce'),
          supabase.from('analytics_events').select('*', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('event_type', 'unsubscribe'),
        ])

        const uniqueOpenEmails = new Set(openEmails)
        const uniqueClickEmails = new Set(clickEmails)

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

  // Fetch top engaged subscribers
  const fetchTopSubscribers = async () => {
    if (!selectedClient) return

    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('client_id', selectedClient.id)
        .gt('engagement_score', 0)
        .order('engagement_score', { ascending: false })
        .limit(100)

      if (error) throw error
      setTopSubscribers(data || [])
    } catch (error) {
      console.error('Error fetching top subscribers:', error)
    }
  }

  // Fetch bounced contacts with campaign info
  const fetchBouncedContacts = async () => {
    if (!selectedClient) return

    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('*, last_bounce_campaign:campaigns!last_bounce_campaign_id(name)')
        .eq('client_id', selectedClient.id)
        .neq('bounce_status', 'none')
        .not('bounce_status', 'is', null)
        .order('bounced_at', { ascending: false })
        .limit(100)

      if (error) throw error
      setBouncedContacts(
        (data || []).map((c: any) => ({
          ...c,
          campaign_name: c.last_bounce_campaign?.name || 'Unknown'
        }))
      )
    } catch (error) {
      console.error('Error fetching bounced contacts:', error)
    }
  }

  // Fetch unsubscribed contacts
  const fetchUnsubscribedContacts = async () => {
    if (!selectedClient) return

    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('client_id', selectedClient.id)
        .eq('unsubscribed', true)
        .order('unsubscribed_at', { ascending: false })

      if (error) throw error
      setUnsubscribedContacts(data || [])
    } catch (error) {
      console.error('Error fetching unsubscribed contacts:', error)
    }
  }

  // Load subscriber data when switching to subscribers view
  useEffect(() => {
    if (viewMode === 'subscribers' && selectedClient) {
      setLoadingSubscribers(true)
      Promise.all([fetchTopSubscribers(), fetchBouncedContacts(), fetchUnsubscribedContacts()])
        .finally(() => setLoadingSubscribers(false))
    }
  }, [viewMode, selectedClient])

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
            <Button
              variant={viewMode === 'subscribers' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setViewMode('subscribers')}
            >
              <Users className="h-4 w-4 mr-2" />
              Subscribers
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
      ) : viewMode === 'subscribers' ? (
        /* Subscribers View */
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Subscriber Engagement</CardTitle>
              <div className="flex gap-2">
                <Button
                  variant={subscriberTab === 'top' ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => setSubscriberTab('top')}
                >
                  Top Engaged ({topSubscribers.length})
                </Button>
                <Button
                  variant={subscriberTab === 'bounced' ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => setSubscriberTab('bounced')}
                >
                  Bounced ({bouncedContacts.length})
                </Button>
                <Button
                  variant={subscriberTab === 'unsubscribed' ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => setSubscriberTab('unsubscribed')}
                >
                  Unsubscribed ({unsubscribedContacts.length})
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingSubscribers ? (
              <div className="text-center py-12 text-gray-500">Loading subscriber data...</div>
            ) : subscriberTab === 'top' ? (
              topSubscribers.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <Users className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p>No engagement data yet. Open and click events will populate this list.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Email</th>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Name</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Opens</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Clicks</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-700">Score</th>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Last Engaged</th>
                        <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {topSubscribers.map((contact) => (
                        <tr key={contact.id} className="hover:bg-gray-50">
                          <td className="py-3 px-4 text-sm text-gray-900">{contact.email}</td>
                          <td className="py-3 px-4 text-sm text-gray-600">
                            {contact.first_name || contact.last_name
                              ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
                              : '-'}
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-900 text-right">{contact.total_opens || 0}</td>
                          <td className="py-3 px-4 text-sm text-gray-900 text-right">{contact.total_clicks || 0}</td>
                          <td className="py-3 px-4 text-sm text-right">
                            <span className={`font-medium ${
                              (contact.engagement_score || 0) > 10 ? 'text-green-600' : 'text-blue-600'
                            }`}>
                              {contact.engagement_score || 0}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-sm text-gray-600">
                            {contact.last_engaged_at
                              ? new Date(contact.last_engaged_at).toLocaleDateString()
                              : '-'}
                          </td>
                          <td className="py-3 px-4 text-sm text-center">
                            {contact.unsubscribed ? (
                              <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800">
                                Unsubscribed
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">
                                Subscribed
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : subscriberTab === 'bounced' ? (
              (() => {
                const filteredBounces = bouncedContacts.filter(c =>
                  bounceFilter === 'all' ? true : c.bounce_status === bounceFilter
                )
                const hardCount = bouncedContacts.filter(c => c.bounce_status === 'hard').length
                const softCount = bouncedContacts.filter(c => c.bounce_status === 'soft').length

                return (
                  <div className="space-y-4">
                    {/* Bounce Type Filter */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setBounceFilter('all')}
                        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                          bounceFilter === 'all'
                            ? 'bg-gray-900 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        All ({bouncedContacts.length})
                      </button>
                      <button
                        onClick={() => setBounceFilter('hard')}
                        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                          bounceFilter === 'hard'
                            ? 'bg-red-600 text-white'
                            : 'bg-red-50 text-red-700 hover:bg-red-100'
                        }`}
                      >
                        Hard ({hardCount})
                      </button>
                      <button
                        onClick={() => setBounceFilter('soft')}
                        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                          bounceFilter === 'soft'
                            ? 'bg-yellow-500 text-white'
                            : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                        }`}
                      >
                        Soft ({softCount})
                      </button>
                    </div>

                    {filteredBounces.length === 0 ? (
                      <div className="text-center py-12 text-gray-500">
                        <AlertCircle className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                        <p>No {bounceFilter === 'all' ? '' : bounceFilter + ' '}bounced contacts.</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Email</th>
                              <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Name</th>
                              <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Bounce Type</th>
                              <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Bounced At</th>
                              <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Campaign</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {filteredBounces.map((contact) => (
                              <tr key={contact.id} className="hover:bg-gray-50">
                                <td className="py-3 px-4 text-sm text-gray-900">{contact.email}</td>
                                <td className="py-3 px-4 text-sm text-gray-600">
                                  {contact.first_name || contact.last_name
                                    ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
                                    : '-'}
                                </td>
                                <td className="py-3 px-4 text-sm">
                                  <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                                    contact.bounce_status === 'hard'
                                      ? 'bg-red-100 text-red-800'
                                      : 'bg-yellow-100 text-yellow-800'
                                  }`}>
                                    {contact.bounce_status === 'hard' ? 'Hard Bounce' : 'Soft Bounce'}
                                  </span>
                                </td>
                                <td className="py-3 px-4 text-sm text-gray-600">
                                  {contact.bounced_at
                                    ? new Date(contact.bounced_at).toLocaleDateString()
                                    : '-'}
                                </td>
                                <td className="py-3 px-4 text-sm text-gray-600">{contact.campaign_name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })()
            ) : (
              /* Unsubscribed Tab */
              (() => {
                // Separate contacts with dates from those without
                const datedContacts = unsubscribedContacts.filter(c => c.unsubscribed_at)
                const unknownDateContacts = unsubscribedContacts.filter(c => !c.unsubscribed_at)

                // Group dated contacts by month
                const groupedByMonth = datedContacts.reduce((groups, contact) => {
                  const date = new Date(contact.unsubscribed_at!)
                  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
                  const label = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
                  if (!groups[key]) {
                    groups[key] = { label, contacts: [] }
                  }
                  groups[key].contacts.push(contact)
                  return groups
                }, {} as Record<string, { label: string; contacts: Contact[] }>)

                const sortedMonths = Object.entries(groupedByMonth).sort((a, b) => b[0].localeCompare(a[0]))

                if (unsubscribedContacts.length === 0) {
                  return (
                    <div className="text-center py-12 text-gray-500">
                      <Mail className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                      <p>No unsubscribed contacts.</p>
                    </div>
                  )
                }

                const renderContactTable = (contacts: Contact[]) => (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-2 px-4 text-sm font-medium text-gray-700">Email</th>
                          <th className="text-left py-2 px-4 text-sm font-medium text-gray-700">Name</th>
                          <th className="text-left py-2 px-4 text-sm font-medium text-gray-700">Unsubscribed</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {contacts.map((contact) => (
                          <tr key={contact.id} className="hover:bg-gray-50">
                            <td className="py-2 px-4 text-sm text-gray-900">{contact.email}</td>
                            <td className="py-2 px-4 text-sm text-gray-600">
                              {contact.first_name || contact.last_name
                                ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
                                : '-'}
                            </td>
                            <td className="py-2 px-4 text-sm text-gray-600">
                              {contact.unsubscribed_at
                                ? new Date(contact.unsubscribed_at).toLocaleDateString()
                                : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )

                return (
                  <div className="space-y-6">
                    {/* Dated unsubscribes grouped by month */}
                    {sortedMonths.map(([key, { label, contacts }]) => (
                      <div key={key}>
                        <h3 className="text-sm font-medium text-gray-700 mb-3">
                          {label} ({contacts.length})
                        </h3>
                        {renderContactTable(contacts)}
                      </div>
                    ))}

                    {/* Unknown date unsubscribes - collapsible */}
                    {unknownDateContacts.length > 0 && (
                      <div className="border-t pt-4">
                        <button
                          onClick={() => setShowUnknownDateUnsubs(!showUnknownDateUnsubs)}
                          className="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-700"
                        >
                          <span className={`transform transition-transform ${showUnknownDateUnsubs ? 'rotate-90' : ''}`}>
                            ▶
                          </span>
                          Legacy unsubscribes - no date recorded ({unknownDateContacts.length})
                        </button>
                        {showUnknownDateUnsubs && (
                          <div className="mt-3">
                            {renderContactTable(unknownDateContacts)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Show message if only unknown date contacts exist */}
                    {datedContacts.length === 0 && unknownDateContacts.length > 0 && !showUnknownDateUnsubs && (
                      <p className="text-sm text-gray-500 text-center py-4">
                        Click above to view {unknownDateContacts.length} legacy unsubscribes without dates.
                      </p>
                    )}
                  </div>
                )
              })()
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

          {/* Stats Source Indicator */}
          <div className="flex items-center gap-2 text-sm">
            {loadingSendgridStats ? (
              <span className="text-gray-500">Loading SendGrid stats...</span>
            ) : stats.source === 'sendgrid' ? (
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Stats from SendGrid API (authoritative)
              </span>
            ) : stats.source === 'webhook' ? (
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                Stats from webhooks {sendgridStatsError && '- SendGrid stats unavailable'}
              </span>
            ) : null}
          </div>

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
              onClick={() => setEventFilter(eventFilter === 'open' ? 'all' : 'open')}
              active={eventFilter === 'open'}
            />
            <StatsCard
              title="Clicked"
              value={stats.uniqueClicks}
              subtitle={`${((stats.uniqueClicks / stats.delivered) * 100 || 0).toFixed(1)}% click rate`}
              icon={MousePointer}
              color="orange"
              onClick={() => setEventFilter(eventFilter === 'click' ? 'all' : 'click')}
              active={eventFilter === 'click'}
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
                <CardTitle>Delivery Issues</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Bounces</span>
                    <span className="text-sm font-medium text-red-600">
                      {stats.bounces.toLocaleString()}
                    </span>
                  </div>
                  {stats.blocks > 0 && (
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-600">Blocks (ISP rejected)</span>
                      <span className="text-sm font-medium text-red-600">
                        {stats.blocks.toLocaleString()}
                      </span>
                    </div>
                  )}
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
                  {/* Show additional SendGrid metrics when available */}
                  {stats.source === 'sendgrid' && (
                    <>
                      {'invalidEmails' in stats && stats.invalidEmails > 0 && (
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Invalid Emails</span>
                          <span className="text-sm font-medium text-red-600">
                            {stats.invalidEmails}
                          </span>
                        </div>
                      )}
                      {'deferred' in stats && stats.deferred > 0 && (
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Deferred</span>
                          <span className="text-sm font-medium text-yellow-600">
                            {stats.deferred.toLocaleString()}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {(stats.bounces > 0 || stats.spam > 0 || stats.unsubscribes > 0 || stats.blocks > 0) && (
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
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>
                {eventFilter === 'all' ? 'Recent Events' : eventFilter === 'open' ? 'Contacts Who Opened' : 'Contacts Who Clicked'}
                {eventFilter !== 'all' && filteredEventContacts.length > 0 && (
                  <span className="text-sm font-normal text-gray-500 ml-2">
                    ({filteredEventContacts.length} contacts)
                  </span>
                )}
              </CardTitle>
              {eventFilter !== 'all' && (
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      fetchAvailableTags()
                      setShowTagModal(true)
                    }}
                  >
                    <TagIcon className="h-4 w-4 mr-2" />
                    Tag These Contacts
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEventFilter('all')}>
                    Show All Events
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {(() => {
                // Use pre-fetched filtered contacts when filter is active, otherwise show recent events
                const displayEvents = eventFilter === 'all'
                  ? events.slice(0, 50)
                  : filteredEventContacts

                if (loadingFilteredEvents && eventFilter !== 'all') {
                  return (
                    <p className="text-center py-8 text-gray-500">
                      Loading {eventFilter} events...
                    </p>
                  )
                }

                if (displayEvents.length === 0) {
                  return (
                    <p className="text-center py-8 text-gray-500">
                      {eventFilter === 'all'
                        ? 'No events yet. Events will appear here as recipients interact with your campaign.'
                        : `No ${eventFilter} events found.`}
                    </p>
                  )
                }

                return (
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
                      {displayEvents.map((event) => (
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
                )
              })()}
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

          {/* Tag Contacts Modal */}
          {showTagModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
              onClick={() => setShowTagModal(false)}
            >
              <div
                className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
                  <h3 className="text-lg font-semibold text-gray-900">
                    Tag {filteredEventContacts.length} Contacts
                  </h3>
                  <button
                    onClick={() => setShowTagModal(false)}
                    className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  >
                    <X className="h-5 w-5 text-gray-500" />
                  </button>
                </div>
                <div className="p-6 space-y-4 overflow-y-auto flex-1">
                  <p className="text-sm text-gray-600">
                    Add a tag to all contacts who {eventFilter === 'open' ? 'opened' : 'clicked'} this campaign.
                  </p>

                  {/* Existing Tags */}
                  {availableTags.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Select existing tag ({availableTags.length} available)
                      </label>
                      <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-1">
                        {availableTags.map((tag) => (
                          <Badge
                            key={tag.id}
                            variant={selectedTag === tag.name ? 'info' : 'default'}
                            className="cursor-pointer"
                            onClick={() => {
                              setSelectedTag(selectedTag === tag.name ? '' : tag.name)
                              setNewTagName('')
                            }}
                          >
                            {tag.name}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Or divider */}
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-gray-200" />
                    </div>
                    <div className="relative flex justify-center text-sm">
                      <span className="px-2 bg-white text-gray-500">or create new</span>
                    </div>
                  </div>

                  {/* New Tag Input */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      New tag name
                    </label>
                    <Input
                      placeholder="e.g., Clicked-Jan2026-Tradeshow"
                      value={newTagName}
                      onChange={(e) => {
                        setNewTagName(e.target.value)
                        setSelectedTag('')
                      }}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg shrink-0">
                  <Button variant="outline" onClick={() => setShowTagModal(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={applyTagToFilteredContacts}
                    disabled={taggingInProgress || (!selectedTag && !newTagName.trim())}
                  >
                    {taggingInProgress ? 'Tagging...' : 'Apply Tag'}
                  </Button>
                </div>
              </div>
            </div>
          )}
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
  onClick,
  active,
}: {
  title: string
  value: number
  subtitle?: string
  icon: any
  color: string
  onClick?: () => void
  active?: boolean
}) {
  const colorClasses = {
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    purple: 'bg-purple-100 text-purple-600',
    orange: 'bg-orange-100 text-orange-600',
  }

  return (
    <Card
      className={`${onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''} ${active ? 'ring-2 ring-blue-500' : ''}`}
      onClick={onClick}
    >
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
