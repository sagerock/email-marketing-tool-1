/**
 * Backend API Server for Email Marketing Tool
 *
 * This is a simple Express.js server that handles:
 * 1. Sending campaigns via SendGrid
 * 2. Processing SendGrid webhook events
 * 3. Managing SendGrid IP pools
 *
 * Setup:
 * 1. Run: npm install express @sendgrid/mail @sendgrid/client @supabase/supabase-js dotenv cors
 * 2. Create a .env file with your credentials
 * 3. Run: node api/server.js
 */

const express = require('express')
const cors = require('cors')
const sgMail = require('@sendgrid/mail')
const sgClient = require('@sendgrid/client')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 3001

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173', // Local development
      'http://localhost:3000',
      'https://mail.sagerock.com', // Production frontend
    ]

    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)

    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}

// Middleware
app.use(cors(corsOptions))
app.use(express.json())

// Initialize Supabase
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key for backend
)

/**
 * Send a test email
 */
app.post('/api/send-test-email', async (req, res) => {
  try {
    const { campaignId, testEmail } = req.body

    if (!testEmail) {
      return res.status(400).json({ error: 'Test email address is required' })
    }

    // 1. Fetch campaign
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single()

    if (campaignError) throw campaignError

    // 2. Fetch client to get API key
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', campaign.client_id)
      .single()

    if (clientError) throw clientError

    // Set SendGrid API key
    sgMail.setApiKey(client.sendgrid_api_key)

    // 3. Fetch template if specified
    let htmlContent = ''
    if (campaign.template_id) {
      const { data: template } = await supabase
        .from('templates')
        .select('html_content')
        .eq('id', campaign.template_id)
        .single()

      htmlContent = template?.html_content || ''
    }

    // 4. Generate test email with placeholder data
    const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
    const testUnsubscribeUrl = `${baseUrl}/unsubscribe?token=TEST_TOKEN`

    // Replace merge tags with test data
    let personalizedHtml = htmlContent
      .replace(/{{email}}/gi, testEmail)
      .replace(/{{first_name}}/gi, 'John')
      .replace(/{{last_name}}/gi, 'Doe')
      .replace(/{{unsubscribe_url}}/gi, testUnsubscribeUrl)

    const msg = {
      to: testEmail,
      from: {
        email: campaign.from_email,
        name: campaign.from_name,
      },
      replyTo: campaign.reply_to || undefined,
      subject: `[TEST] ${campaign.subject}`,
      html: personalizedHtml,
      ipPoolName: campaign.ip_pool || undefined,
      headers: {
        'List-Unsubscribe': `<${testUnsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }

    await sgMail.send(msg)

    res.json({ success: true, message: `Test email sent to ${testEmail}` })
  } catch (error) {
    console.error('Error sending test email:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Send a campaign
 */
app.post('/api/send-campaign', async (req, res) => {
  try {
    const { campaignId } = req.body

    // 1. Fetch campaign
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single()

    if (campaignError) throw campaignError

    // 2. Fetch client to get API key
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', campaign.client_id)
      .single()

    if (clientError) throw clientError

    // Set SendGrid API key
    sgMail.setApiKey(client.sendgrid_api_key)

    // 3. Fetch template if specified
    let htmlContent = ''
    if (campaign.template_id) {
      const { data: template } = await supabase
        .from('templates')
        .select('html_content')
        .eq('id', campaign.template_id)
        .single()

      htmlContent = template?.html_content || ''
    }

    // 4. Fetch contacts (filtered by tags if specified)
    let query = supabase
      .from('contacts')
      .select('*')
      .eq('unsubscribed', false) // Exclude unsubscribed contacts

    if (campaign.client_id) {
      query = query.eq('client_id', campaign.client_id)
    }

    const { data: allContacts } = await query

    // Filter by tags if specified
    let contacts = allContacts || []
    if (campaign.filter_tags && campaign.filter_tags.length > 0) {
      contacts = contacts.filter((contact) =>
        campaign.filter_tags.every((tag) => contact.tags?.includes(tag))
      )
    }

    // 5. Update campaign status
    await supabase
      .from('campaigns')
      .update({
        status: 'sending',
        recipient_count: contacts.length,
      })
      .eq('id', campaignId)

    // 6. Send emails
    const baseUrl = process.env.BASE_URL || 'http://localhost:5173'

    const emailPromises = contacts.map((contact) => {
      // Generate unsubscribe URL
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}`

      // Replace merge tags in HTML
      let personalizedHtml = htmlContent
        .replace(/{{email}}/gi, contact.email)
        .replace(/{{first_name}}/gi, contact.first_name || '')
        .replace(/{{last_name}}/gi, contact.last_name || '')
        .replace(/{{unsubscribe_url}}/gi, unsubscribeUrl)

      const msg = {
        to: contact.email,
        from: {
          email: campaign.from_email,
          name: campaign.from_name,
        },
        replyTo: campaign.reply_to || undefined,
        subject: campaign.subject,
        html: personalizedHtml,
        customArgs: {
          campaign_id: campaignId,
        },
        ipPoolName: campaign.ip_pool || undefined,
        // Add List-Unsubscribe header for one-click unsubscribe
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }

      return sgMail.send(msg).catch((error) => {
        console.error(`Failed to send to ${contact.email}:`, error)
        return null
      })
    })

    await Promise.all(emailPromises)

    // 7. Update campaign to sent
    await supabase
      .from('campaigns')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', campaignId)

    res.json({ success: true, sent: contacts.length })
  } catch (error) {
    console.error('Error sending campaign:', error)

    // Update campaign to failed
    if (req.body.campaignId) {
      await supabase
        .from('campaigns')
        .update({ status: 'failed' })
        .eq('id', req.body.campaignId)
    }

    res.status(500).json({ error: error.message })
  }
})

/**
 * SendGrid webhook endpoint for event tracking
 * Configure this URL in SendGrid: https://your-domain.com/api/webhook/sendgrid
 */
app.post('/api/webhook/sendgrid', async (req, res) => {
  try {
    const events = req.body

    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'Invalid payload' })
    }

    // Process each event
    for (const event of events) {
      // Extract campaign_id from custom args
      const campaignId = event.campaign_id || event.custom_args?.campaign_id

      if (!campaignId) {
        console.warn('Event missing campaign_id:', event)
        continue
      }

      // Map SendGrid event types to our event types
      const eventTypeMap = {
        delivered: 'delivered',
        open: 'open',
        click: 'click',
        bounce: 'bounce',
        dropped: 'bounce',
        spamreport: 'spam',
        unsubscribe: 'unsubscribe',
      }

      const eventType = eventTypeMap[event.event]
      if (!eventType) continue

      // Insert event into database
      await supabase.from('analytics_events').insert({
        campaign_id: campaignId,
        email: event.email,
        event_type: eventType,
        timestamp: new Date(event.timestamp * 1000).toISOString(),
        url: event.url || null,
        user_agent: event.useragent || null,
        ip_address: event.ip || null,
        sg_event_id: event.sg_event_id,
      })

      // If unsubscribe event, update contact status
      if (eventType === 'unsubscribe' && event.email) {
        await supabase
          .from('contacts')
          .update({
            unsubscribed: true,
            unsubscribed_at: new Date(event.timestamp * 1000).toISOString(),
          })
          .eq('email', event.email)
      }
    }

    res.status(200).send('OK')
  } catch (error) {
    console.error('Webhook error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get IP pools from SendGrid
 */
app.get('/api/sendgrid/ip-pools', async (req, res) => {
  try {
    const { clientId } = req.query

    // Fetch client API key
    const { data: client } = await supabase
      .from('clients')
      .select('sendgrid_api_key')
      .eq('id', clientId)
      .single()

    if (!client) {
      return res.status(404).json({ error: 'Client not found' })
    }

    sgClient.setApiKey(client.sendgrid_api_key)

    const request = {
      method: 'GET',
      url: '/v3/ips/pools',
    }

    const [response] = await sgClient.request(request)
    res.json(response.body)
  } catch (error) {
    console.error('Error fetching IP pools:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`)
})
