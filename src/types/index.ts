export interface Contact {
  id: string
  email: string
  first_name?: string
  last_name?: string
  company?: string
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
  folder_id?: string
  created_at: string
  updated_at: string
  client_id?: string
}

export interface Folder {
  id: string
  name: string
  client_id: string
  created_at: string
  updated_at: string
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
  utm_params?: string
  folder_id?: string
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
  ip_pool?: string
  mailing_address?: string
  default_utm_params?: string
  verified_senders?: VerifiedSender[]
  created_at: string
  updated_at: string
  // Salesforce integration fields
  salesforce_instance_url?: string
  salesforce_client_id?: string
  salesforce_client_secret?: string
  salesforce_connected_at?: string
  last_salesforce_sync?: string
  salesforce_sync_status?: string
  salesforce_sync_message?: string
  salesforce_sync_count?: number
}

export interface Tag {
  id: string
  name: string
  client_id: string
  contact_count: number
  created_at: string
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

// Automation Sequences Types
export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived'
export type EnrollmentStatus = 'active' | 'completed' | 'paused' | 'cancelled' | 'failed'

export interface EmailSequence {
  id: string
  name: string
  description?: string
  status: SequenceStatus
  trigger_type: 'manual' | 'tag_added' | 'contact_created'
  trigger_config: Record<string, any>
  from_email: string
  from_name: string
  reply_to?: string
  filter_tags?: string[]
  start_time?: string // HH:MM format for preferred send time
  total_enrolled: number
  total_completed: number
  client_id?: string
  created_at: string
  updated_at: string
}

export interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  subject: string
  template_id?: string
  html_content?: string
  delay_days: number
  delay_hours: number
  send_time?: string
  sent_count: number
  open_count: number
  click_count: number
  created_at: string
  updated_at: string
}

export interface SequenceEnrollment {
  id: string
  sequence_id: string
  contact_id: string
  status: EnrollmentStatus
  current_step: number
  enrolled_at: string
  completed_at?: string
  paused_at?: string
  cancelled_at?: string
  last_email_sent_at?: string
  next_email_scheduled_at?: string
  // Joined fields
  contact?: Contact
}

export interface ScheduledEmail {
  id: string
  enrollment_id: string
  step_id: string
  contact_id: string
  scheduled_for: string
  status: 'pending' | 'sent' | 'failed' | 'cancelled'
  sent_at?: string
  error_message?: string
  attempts: number
  created_at: string
}

export interface SequenceAnalytics {
  id: string
  sequence_id: string
  step_id: string
  enrollment_id?: string
  email: string
  event_type: string
  timestamp: string
  url?: string
  user_agent?: string
  ip_address?: string
  sg_event_id?: string
  created_at: string
}

export interface SequenceStats {
  sequence_id: string
  total_enrolled: number
  active: number
  completed: number
  paused: number
  cancelled: number
  emails_sent: number
  opens: number
  clicks: number
  bounces: number
  unsubscribes: number
}

// Salesforce Campaign Integration Types
export interface SalesforceCampaign {
  id: string
  salesforce_id: string
  name: string
  type?: string
  status?: string
  start_date?: string
  end_date?: string
  client_id: string
  created_at: string
  updated_at: string
}

export interface SalesforceCampaignMember {
  id: string
  salesforce_id: string
  salesforce_campaign_id: string
  contact_id: string
  status?: string
  synced_at: string
  client_id: string
  created_at: string
  // Joined fields
  contact?: Contact
  campaign?: SalesforceCampaign
}

export interface IndustryLink {
  id: string
  industry: string
  link_url: string
  client_id: string
  created_at: string
  updated_at: string
}
