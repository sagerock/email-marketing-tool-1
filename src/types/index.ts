export interface Contact {
  id: string
  email: string
  first_name?: string
  last_name?: string
  tags: string[]
  custom_fields?: Record<string, any>
  unsubscribed: boolean
  unsubscribed_at?: string
  unsubscribe_token: string
  created_at: string
  updated_at: string
  client_id?: string
}

export interface Template {
  id: string
  name: string
  subject: string
  html_content: string
  preview_text?: string
  thumbnail?: string
  created_at: string
  updated_at: string
  client_id?: string
}

export interface Campaign {
  id: string
  name: string
  template_id: string
  subject: string
  from_email: string
  from_name: string
  reply_to?: string
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  scheduled_at?: string
  sent_at?: string
  recipient_count: number
  filter_tags?: string[]
  ip_pool?: string
  created_at: string
  updated_at: string
  client_id?: string
}

export interface AnalyticsEvent {
  id: string
  campaign_id: string
  email: string
  event_type: 'delivered' | 'open' | 'click' | 'bounce' | 'spam' | 'unsubscribe'
  timestamp: string
  url?: string
  user_agent?: string
}

export interface VerifiedSender {
  email: string
  name: string
}

export interface Client {
  id: string
  name: string
  sendgrid_api_key: string
  ip_pools?: string[]
  mailing_address?: string
  verified_senders?: VerifiedSender[]
  created_at: string
  updated_at: string
}

export interface CampaignStats {
  campaign_id: string
  sent: number
  delivered: number
  opens: number
  unique_opens: number
  clicks: number
  unique_clicks: number
  bounces: number
  spam_reports: number
  unsubscribes: number
}
