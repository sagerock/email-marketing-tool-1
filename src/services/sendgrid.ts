/**
 * SendGrid Service
 *
 * Note: SendGrid API calls should be made from a backend server, not directly from the browser.
 * This file provides the structure for SendGrid integration that would be used in a backend API.
 *
 * For production use, create a backend API (Node.js/Express, Python/Flask, etc.) that:
 * 1. Stores the SendGrid API key securely (never expose it in the frontend)
 * 2. Handles campaign sending
 * 3. Processes webhook events from SendGrid
 */

export interface SendEmailParams {
  to: string[]
  from: {
    email: string
    name: string
  }
  replyTo?: string
  subject: string
  html: string
  ipPoolName?: string
}

/**
 * This function would be called from your backend API
 * Example backend implementation (Node.js):
 *
 * const sgMail = require('@sendgrid/mail')
 * sgMail.setApiKey(process.env.SENDGRID_API_KEY)
 *
 * app.post('/api/send-campaign', async (req, res) => {
 *   const { campaignId } = req.body
 *
 *   // 1. Fetch campaign from Supabase
 *   // 2. Fetch template
 *   // 3. Fetch filtered contacts
 *   // 4. Send emails using sgMail.send()
 *   // 5. Update campaign status
 * })
 */
export async function sendCampaignViaAPI(campaignId: string): Promise<void> {
  // This would make a request to your backend API
  const response = await fetch('/api/send-campaign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignId }),
  })

  if (!response.ok) {
    throw new Error('Failed to send campaign')
  }
}

/**
 * Example backend webhook handler for SendGrid events:
 *
 * app.post('/api/webhook/sendgrid', async (req, res) => {
 *   const events = req.body // Array of SendGrid events
 *
 *   for (const event of events) {
 *     // Store event in analytics_events table
 *     await supabase.from('analytics_events').insert({
 *       campaign_id: event.campaign_id, // You'd include this in custom args
 *       email: event.email,
 *       event_type: event.event, // 'delivered', 'open', 'click', etc.
 *       timestamp: new Date(event.timestamp * 1000).toISOString(),
 *       url: event.url,
 *       user_agent: event.useragent,
 *       sg_event_id: event.sg_event_id
 *     })
 *   }
 *
 *   res.status(200).send('OK')
 * })
 */

/**
 * Helper to validate SendGrid API key format
 */
export function validateSendGridApiKey(apiKey: string): boolean {
  return apiKey.startsWith('SG.') && apiKey.length > 20
}

/**
 * Get IP pools from SendGrid (backend only)
 */
export async function getIPPools(apiKey: string): Promise<string[]> {
  // This would be implemented in your backend
  const response = await fetch('/api/sendgrid/ip-pools', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    throw new Error('Failed to fetch IP pools')
  }

  const data = await response.json()
  return data.map((pool: any) => pool.name)
}
