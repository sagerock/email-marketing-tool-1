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
const path = require('path')
const cron = require('node-cron')
const sgMail = require('@sendgrid/mail')
const sgClient = require('@sendgrid/client')
const { createClient } = require('@supabase/supabase-js')
const jsforce = require('jsforce')
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
 * Helper function to send a campaign by ID
 * Used by both the API endpoint and the scheduled campaign cron job
 */
async function sendCampaignById(campaignId) {
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

  console.log('📧 Sending campaign for client:', client.name, '| IP Pool:', client.ip_pool || '(none)')

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

  // 4. Get contact IDs from Salesforce Campaign if specified
  let sfCampaignContactIds = null
  if (campaign.salesforce_campaign_id) {
    const { data: members, error: membersError } = await supabase
      .from('salesforce_campaign_members')
      .select('contact_id')
      .eq('salesforce_campaign_id', campaign.salesforce_campaign_id)
      .eq('client_id', campaign.client_id)

    if (membersError) throw membersError
    sfCampaignContactIds = new Set(members?.map(m => m.contact_id) || [])
    console.log(`📧 Salesforce Campaign filter: ${sfCampaignContactIds.size} contacts in campaign`)

    // If no contacts in the campaign, return early
    if (sfCampaignContactIds.size === 0) {
      await supabase
        .from('campaigns')
        .update({ status: 'sent', sent_at: new Date().toISOString(), recipient_count: 0 })
        .eq('id', campaignId)
      return { sent: 0, failed: 0 }
    }
  }

  // 5. Fetch ALL contacts (paginated to handle large lists)
  let allContacts = []
  let page = 0
  const pageSize = 1000

  while (true) {
    let query = supabase
      .from('contacts')
      .select('*')
      .eq('unsubscribed', false)
      .eq('client_id', campaign.client_id)
      .range(page * pageSize, (page + 1) * pageSize - 1)

    const { data, error } = await query

    if (error) throw error
    if (!data || data.length === 0) break

    allContacts = allContacts.concat(data)
    page++

    // Safety check - stop if we've fetched less than a full page
    if (data.length < pageSize) break
  }

  console.log(`📧 Fetched ${allContacts.length} total contacts for campaign`)

  // Filter by Salesforce Campaign membership if specified
  let contacts = allContacts
  if (sfCampaignContactIds) {
    contacts = contacts.filter((contact) => sfCampaignContactIds.has(contact.id))
    console.log(`📧 After SF Campaign filter: ${contacts.length} contacts`)
  }

  // Filter by tags if specified (OR logic - contact has any of the selected tags)
  if (campaign.filter_tags && campaign.filter_tags.length > 0) {
    contacts = contacts.filter((contact) =>
      campaign.filter_tags.some((tag) => contact.tags?.includes(tag))
    )
    console.log(`📧 After tag filter: ${contacts.length} contacts`)
  }

  // Exclude hard-bounced contacts (they cannot receive emails)
  const beforeBounceFilter = contacts.length
  contacts = contacts.filter((contact) => contact.bounce_status !== 'hard')
  if (contacts.length < beforeBounceFilter) {
    console.log(`📧 Excluded ${beforeBounceFilter - contacts.length} hard-bounced contacts, ${contacts.length} remaining`)
  }

  // 6. Update campaign status
  await supabase
    .from('campaigns')
    .update({
      status: 'sending',
      recipient_count: contacts.length,
    })
    .eq('id', campaignId)

  // 7. Send emails
  const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
  const mailingAddress = client.mailing_address || 'No mailing address configured'
  const utmParams = campaign.utm_params || ''

  // Fetch Salesforce campaign name if linked
  let sfCampaignName = ''
  if (campaign.salesforce_campaign_id) {
    const { data: sfCampaign } = await supabase
      .from('salesforce_campaigns')
      .select('name')
      .eq('id', campaign.salesforce_campaign_id)
      .single()
    sfCampaignName = sfCampaign?.name || ''
  }

  // Pre-fetch all industry links for this client
  const { data: industryLinks } = await supabase
    .from('industry_links')
    .select('industry, link_url')
    .eq('client_id', campaign.client_id)

  const industryLinkMap = new Map(industryLinks?.map(il => [il.industry, il.link_url]) || [])
  const defaultIndustryUrl = 'https://alconox.com/industries/'

  // Helper function to append UTM params to URLs
  const appendUtmParams = (html, params) => {
    if (!params) return html
    // Match href attributes with http/https URLs (not mailto:, tel:, #, etc.)
    return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
      // Don't add UTM to unsubscribe URLs (they already have params)
      if (url.includes('unsubscribe')) return match
      const separator = url.includes('?') ? '&' : '?'
      return `href="${url}${separator}${params}"`
    })
  }

  const emailPromises = contacts.map((contact) => {
    // Generate unsubscribe URL with campaign_id for tracking
    const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}&campaign_id=${campaignId}`

    // Get industry link for this contact
    const industryLink = contact.industry ? (industryLinkMap.get(contact.industry) || defaultIndustryUrl) : defaultIndustryUrl

    // Replace merge tags in HTML
    let personalizedHtml = htmlContent
      .replace(/{{email}}/gi, contact.email)
      .replace(/{{first_name}}/gi, contact.first_name || '')
      .replace(/{{last_name}}/gi, contact.last_name || '')
      .replace(/{{unsubscribe_url}}/gi, unsubscribeUrl)
      .replace(/{{mailing_address}}/gi, mailingAddress)
      .replace(/{{campaign_name}}/gi, sfCampaignName)
      .replace(/{{industry_link}}/gi, industryLink)

    // Append UTM params to all links
    personalizedHtml = appendUtmParams(personalizedHtml, utmParams)

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
      ipPoolName: client.ip_pool || undefined,
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

  return { success: true, sent: contacts.length }
}

/**
 * Send test email(s)
 */
app.post('/api/send-test-email', async (req, res) => {
  try {
    const { campaignId, testEmail, testEmails } = req.body

    // Support both single email (legacy) and multiple emails
    const emails = testEmails || (testEmail ? [testEmail] : [])

    console.log('📧 Test email request:', { campaignId, emails })

    if (emails.length === 0) {
      return res.status(400).json({ error: 'At least one test email address is required' })
    }

    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign ID is required' })
    }

    // 1. Fetch campaign
    console.log('📋 Fetching campaign:', campaignId)
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single()

    if (campaignError) {
      console.error('❌ Campaign fetch error:', campaignError)
      throw new Error(`Campaign not found: ${campaignError.message}`)
    }

    console.log('✅ Campaign found:', campaign.name)

    // 2. Fetch client to get API key
    console.log('🔑 Fetching client:', campaign.client_id)
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', campaign.client_id)
      .single()

    if (clientError) {
      console.error('❌ Client fetch error:', clientError)
      throw new Error(`Client not found: ${clientError.message}`)
    }

    console.log('✅ Client found:', client.name, '| IP Pool:', client.ip_pool || '(none)')

    if (!client.sendgrid_api_key) {
      throw new Error('Client does not have a SendGrid API key configured')
    }

    // Set SendGrid API key
    sgMail.setApiKey(client.sendgrid_api_key)

    // 3. Fetch template if specified
    let htmlContent = ''
    if (campaign.template_id) {
      console.log('📄 Fetching template:', campaign.template_id)
      const { data: template, error: templateError } = await supabase
        .from('templates')
        .select('html_content')
        .eq('id', campaign.template_id)
        .single()

      if (templateError) {
        console.error('⚠️ Template fetch error:', templateError)
      } else {
        htmlContent = template?.html_content || ''
        console.log('✅ Template loaded, length:', htmlContent.length)
      }
    } else {
      console.log('⚠️ No template specified for campaign')
    }

    // Check if we have HTML content
    if (!htmlContent || htmlContent.trim().length === 0) {
      htmlContent = `
        <html>
          <body>
            <h1>Test Email</h1>
            <p>This is a test email for campaign: ${campaign.name}</p>
            <p>Subject: ${campaign.subject}</p>
            <p><strong>Note:</strong> This campaign doesn't have a template selected yet.</p>
          </body>
        </html>
      `
      console.log('⚠️ Using fallback HTML (no template content)')
    }

    // 4. Generate test email with placeholder data
    const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
    const testUnsubscribeUrl = `${baseUrl}/unsubscribe?token=TEST_TOKEN`

    // Helper function to append UTM params to URLs
    const appendUtmParams = (html, params) => {
      if (!params) return html
      return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
        if (url.includes('unsubscribe')) return match
        const separator = url.includes('?') ? '&' : '?'
        return `href="${url}${separator}${params}"`
      })
    }

    // Send test email to each recipient
    const mailingAddress = client.mailing_address || 'No mailing address configured'
    const utmParams = campaign.utm_params || ''
    let sentCount = 0

    for (const email of emails) {
      // Replace merge tags with test data
      let personalizedHtml = htmlContent
        .replace(/{{email}}/gi, email)
        .replace(/{{first_name}}/gi, 'John')
        .replace(/{{last_name}}/gi, 'Doe')
        .replace(/{{unsubscribe_url}}/gi, testUnsubscribeUrl)
        .replace(/{{mailing_address}}/gi, mailingAddress)

      // Append UTM params to all links
      personalizedHtml = appendUtmParams(personalizedHtml, utmParams)

      const msg = {
        to: email,
        from: {
          email: campaign.from_email,
          name: campaign.from_name,
        },
        replyTo: campaign.reply_to || undefined,
        subject: `[TEST] ${campaign.subject}`,
        html: personalizedHtml,
        ipPoolName: client.ip_pool || undefined,
        headers: {
          'List-Unsubscribe': `<${testUnsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }

      console.log('📤 Sending test email to:', email)
      await sgMail.send(msg)
      sentCount++
    }

    console.log(`✅ Test email(s) sent successfully to ${sentCount} recipient(s)`)
    res.json({
      success: true,
      message: emails.length === 1
        ? `Test email sent to ${emails[0]}`
        : `Test emails sent to ${sentCount} recipients`
    })
  } catch (error) {
    console.error('❌ Error sending test email:', error)

    // Provide more helpful error messages
    let errorMessage = error.message
    if (error.response && error.response.body) {
      console.error('SendGrid error details:', error.response.body)
      errorMessage = `SendGrid error: ${JSON.stringify(error.response.body.errors || error.response.body)}`
    }

    res.status(500).json({ error: errorMessage })
  }
})

/**
 * Send a campaign (manual trigger)
 */
app.post('/api/send-campaign', async (req, res) => {
  try {
    const { campaignId } = req.body
    const result = await sendCampaignById(campaignId)
    res.json(result)
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
      console.error('SendGrid webhook: Invalid payload (not an array)', req.body)
      return res.status(400).json({ error: 'Invalid payload' })
    }

    console.log(`SendGrid webhook: Received ${events.length} events`)

    let processed = 0
    let skipped = 0
    let errors = 0

    // Process each event
    for (const event of events) {
      // Extract campaign_id from custom args
      const campaignId = event.campaign_id || event.custom_args?.campaign_id

      if (!campaignId) {
        console.warn('Event missing campaign_id:', JSON.stringify(event))
        skipped++
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
      if (!eventType) {
        console.log(`SendGrid webhook: Skipping unmapped event type: ${event.event}`)
        skipped++
        continue
      }

      // Insert event into database
      const { error: insertError } = await supabase.from('analytics_events').insert({
        campaign_id: campaignId,
        email: event.email,
        event_type: eventType,
        timestamp: new Date(event.timestamp * 1000).toISOString(),
        url: event.url || null,
        user_agent: event.useragent || null,
        ip_address: event.ip || null,
        sg_event_id: event.sg_event_id,
      })

      if (insertError) {
        // Don't log duplicate key errors as they're expected
        if (!insertError.message?.includes('duplicate key')) {
          console.error(`SendGrid webhook: Insert error for ${event.email}:`, insertError.message)
        }
        errors++
        continue
      }

      processed++

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

      // If bounce event, flag contact as bounced
      if (eventType === 'bounce' && event.email) {
        // Determine bounce type from SendGrid event data
        // Hard bounces: invalid, bounce, blocked - permanent delivery failures
        // Soft bounces: deferred - temporary issues
        const isHardBounce = ['invalid', 'bounce', 'blocked'].includes(event.type) ||
                            event.reason?.toLowerCase().includes('invalid') ||
                            event.reason?.toLowerCase().includes('does not exist')

        await supabase
          .from('contacts')
          .update({
            bounce_status: isHardBounce ? 'hard' : 'soft',
            bounced_at: new Date(event.timestamp * 1000).toISOString(),
            last_bounce_campaign_id: campaignId,
          })
          .eq('email', event.email)

        console.log(`Bounce recorded for ${event.email}: ${isHardBounce ? 'hard' : 'soft'} bounce`)
      }

      // If open or click event, update engagement metrics
      if ((eventType === 'open' || eventType === 'click') && event.email) {
        const eventTimestamp = new Date(event.timestamp * 1000).toISOString()
        const eventUnixTime = event.timestamp

        // Fetch current engagement values
        const { data: contact } = await supabase
          .from('contacts')
          .select('total_opens, total_clicks, engagement_score')
          .eq('email', event.email)
          .single()

        if (contact) {
          let shouldCountClick = true

          // Bot detection for clicks
          if (eventType === 'click' && campaignId) {
            // Check for recent clicks from same email for same campaign (within last 60 seconds)
            const oneMinuteAgo = eventUnixTime - 60
            const { data: recentClicks } = await supabase
              .from('analytics_events')
              .select('url, timestamp')
              .eq('email', event.email)
              .eq('campaign_id', campaignId)
              .eq('event_type', 'click')
              .gte('timestamp', oneMinuteAgo)

            if (recentClicks && recentClicks.length >= 5) {
              // 5+ clicks in the last minute for same campaign = likely bot
              shouldCountClick = false
              // console.log(`Bot detected: ${event.email} has ${recentClicks.length} clicks in last 60s`)
            } else if (recentClicks && event.url) {
              // Check if this exact URL was already clicked
              const alreadyClicked = recentClicks.some(c => c.url === event.url)
              if (alreadyClicked) {
                shouldCountClick = false // Don't count duplicate URL clicks
              }
            }
          }

          const newOpens = (contact.total_opens || 0) + (eventType === 'open' ? 1 : 0)
          const newClicks = (contact.total_clicks || 0) + (eventType === 'click' && shouldCountClick ? 1 : 0)
          const newScore = newOpens + (newClicks * 2) // clicks worth 2 points

          await supabase
            .from('contacts')
            .update({
              total_opens: newOpens,
              total_clicks: newClicks,
              engagement_score: newScore,
              last_engaged_at: eventTimestamp,
            })
            .eq('email', event.email)
        }
      }
    }

    console.log(`SendGrid webhook: Processed ${processed}, skipped ${skipped}, errors ${errors}`)
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
 * Sync analytics events from SendGrid for a specific campaign
 * Pulls event data directly from SendGrid's Email Activity API
 */
app.post('/api/campaigns/:id/sync-sendgrid', async (req, res) => {
  try {
    const campaignId = req.params.id

    // 1. Get campaign details
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*, client:clients(id, sendgrid_api_key)')
      .eq('id', campaignId)
      .single()

    if (campaignError || !campaign) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    if (!campaign.client?.sendgrid_api_key) {
      return res.status(400).json({ error: 'No SendGrid API key configured for this client' })
    }

    if (!campaign.sent_at) {
      return res.status(400).json({ error: 'Campaign has not been sent yet' })
    }

    // 2. Build query for SendGrid Email Activity API
    // Query messages from around the time the campaign was sent
    const sentDate = new Date(campaign.sent_at)
    const startDate = new Date(sentDate.getTime() - 60 * 60 * 1000) // 1 hour before
    const endDate = new Date(sentDate.getTime() + 7 * 24 * 60 * 60 * 1000) // 7 days after

    // Build query - SendGrid uses ISO 8601 format
    const query = `subject="${campaign.subject}" AND last_event_time BETWEEN TIMESTAMP "${startDate.toISOString()}" AND TIMESTAMP "${endDate.toISOString()}"`

    console.log(`📊 Syncing SendGrid events for campaign: ${campaign.name}`)
    console.log(`   Query: ${query}`)

    // Use fetch directly (like curl) instead of SendGrid client library
    const url = new URL('https://api.sendgrid.com/v3/messages')
    url.searchParams.set('limit', '1000')
    url.searchParams.set('query', query)

    let response
    try {
      const fetchResponse = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${campaign.client.sendgrid_api_key}`,
        },
      })
      response = await fetchResponse.json()

      if (!fetchResponse.ok) {
        console.error('SendGrid API error:', response)
        if (fetchResponse.status === 403) {
          return res.status(400).json({
            error: 'Email Activity API not available. This feature requires the Email Activity Feed add-on in SendGrid.'
          })
        }
        if (fetchResponse.status === 400 || fetchResponse.status === 401) {
          return res.status(400).json({
            error: response.errors?.[0]?.message || 'Email Activity API error. Check your API key permissions.'
          })
        }
        throw new Error(response.errors?.[0]?.message || 'SendGrid API error')
      }
    } catch (fetchError) {
      console.error('SendGrid fetch error:', fetchError)
      throw fetchError
    }
    const messages = response.messages || []

    console.log(`   Found ${messages.length} messages in SendGrid`)

    // 5. Process each message and insert events for delivered, opens, and clicks
    let inserted = 0
    let skipped = 0

    for (const message of messages) {
      const email = message.to_email
      const timestamp = message.last_event_time || campaign.sent_at

      // Helper function to insert event if not exists
      const insertEvent = async (eventType, eventId) => {
        const { data: existing } = await supabase
          .from('analytics_events')
          .select('id')
          .eq('campaign_id', campaignId)
          .eq('email', email)
          .eq('event_type', eventType)
          .limit(1)

        if (existing && existing.length > 0) {
          return false // Already exists
        }

        const { error: insertError } = await supabase
          .from('analytics_events')
          .insert({
            campaign_id: campaignId,
            email: email,
            event_type: eventType,
            timestamp: timestamp,
            sg_event_id: eventId,
          })

        if (insertError && !insertError.message?.includes('duplicate key')) {
          console.error(`   Error inserting ${eventType} for ${email}:`, insertError.message)
          return false
        }
        return !insertError
      }

      // Insert delivered event if status is delivered
      if (message.status === 'delivered') {
        if (await insertEvent('delivered', `sync-${message.msg_id}-delivered`)) {
          inserted++
        } else {
          skipped++
        }
      } else if (message.status === 'not_delivered' || message.status === 'bounced') {
        if (await insertEvent('bounce', `sync-${message.msg_id}-bounce`)) {
          inserted++
        } else {
          skipped++
        }
      }

      // Insert open event if opens_count > 0
      if (message.opens_count > 0) {
        if (await insertEvent('open', `sync-${message.msg_id}-open`)) {
          inserted++
        } else {
          skipped++
        }
      }

      // Insert click event if clicks_count > 0
      if (message.clicks_count > 0) {
        if (await insertEvent('click', `sync-${message.msg_id}-click`)) {
          inserted++
        } else {
          skipped++
        }
      }
    }

    console.log(`   Inserted ${inserted} events, skipped ${skipped}`)

    res.json({
      success: true,
      messagesFound: messages.length,
      inserted,
      skipped,
    })
  } catch (error) {
    console.error('Error syncing SendGrid events:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

/**
 * Upsert contact endpoint
 * Creates or updates a contact and merges tags
 * Used by external integrations (Make.com, Zapier, etc.)
 */
app.post('/api/contacts/upsert', async (req, res) => {
  try {
    // Check API key authentication
    const authHeader = req.headers.authorization
    const apiKey = process.env.API_SECRET_KEY

    if (!apiKey) {
      console.error('❌ API_SECRET_KEY not configured')
      return res.status(500).json({ error: 'API key not configured on server' })
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' })
    }

    const providedKey = authHeader.substring(7) // Remove 'Bearer '
    if (providedKey !== apiKey) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    // Validate required fields
    const { client_id, email, first_name, last_name, tags } = req.body

    if (!client_id) {
      return res.status(400).json({ error: 'client_id is required' })
    }

    if (!email) {
      return res.status(400).json({ error: 'email is required' })
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim()

    // Check if contact exists
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('*')
      .eq('client_id', client_id)
      .eq('email', normalizedEmail)
      .single()

    let contact
    let action

    if (existingContact) {
      // Update existing contact - merge tags
      const existingTags = existingContact.tags || []
      const newTags = tags || []
      const mergedTags = [...new Set([...existingTags, ...newTags])]

      const { data: updated, error: updateError } = await supabase
        .from('contacts')
        .update({
          first_name: first_name || existingContact.first_name,
          last_name: last_name || existingContact.last_name,
          tags: mergedTags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingContact.id)
        .select()
        .single()

      if (updateError) throw updateError

      contact = updated
      action = 'updated'
      console.log(`📝 Updated contact ${normalizedEmail} with tags: ${mergedTags.join(', ')}`)
    } else {
      // Create new contact
      const { data: created, error: createError } = await supabase
        .from('contacts')
        .insert({
          client_id,
          email: normalizedEmail,
          first_name: first_name || null,
          last_name: last_name || null,
          tags: tags || [],
          unsubscribed: false,
          // unsubscribe_token is auto-generated by database trigger
        })
        .select()
        .single()

      if (createError) throw createError

      contact = created
      action = 'created'
      console.log(`✅ Created contact ${normalizedEmail} with tags: ${(tags || []).join(', ')}`)
    }

    res.json({
      success: true,
      contact_id: contact.id,
      action,
      email: contact.email,
      tags: contact.tags,
    })
  } catch (error) {
    console.error('❌ Error upserting contact:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Process scheduled sequence emails
 * This should be called periodically (e.g., every minute via cron)
 */
app.post('/api/sequences/process', async (req, res) => {
  try {
    const now = new Date().toISOString()

    // 1. Get pending scheduled emails that are due
    const { data: scheduledEmails, error: fetchError } = await supabase
      .from('scheduled_emails')
      .select(`
        *,
        enrollment:sequence_enrollments(
          *,
          sequence:email_sequences(*),
          contact:contacts(*),
          trigger_campaign:salesforce_campaigns(id, name, type)
        ),
        step:sequence_steps(*)
      `)
      .eq('status', 'pending')
      .lte('scheduled_for', now)
      .limit(50) // Process in batches

    if (fetchError) throw fetchError

    if (!scheduledEmails || scheduledEmails.length === 0) {
      return res.json({ processed: 0, message: 'No emails to process' })
    }

    console.log(`📬 Processing ${scheduledEmails.length} scheduled sequence emails`)

    let sent = 0
    let failed = 0

    for (const scheduledEmail of scheduledEmails) {
      try {
        const { enrollment, step } = scheduledEmail
        const { sequence, contact } = enrollment

        // Skip if sequence is not active, contact is unsubscribed, or contact has hard bounce
        if (sequence.status !== 'active' || contact.unsubscribed || contact.bounce_status === 'hard') {
          await supabase
            .from('scheduled_emails')
            .update({ status: 'cancelled' })
            .eq('id', scheduledEmail.id)
          continue
        }

        // Skip if enrollment is not active
        if (enrollment.status !== 'active') {
          await supabase
            .from('scheduled_emails')
            .update({ status: 'cancelled' })
            .eq('id', scheduledEmail.id)
          continue
        }

        // Get client for API key
        const { data: client } = await supabase
          .from('clients')
          .select('*')
          .eq('id', sequence.client_id)
          .single()

        if (!client || !client.sendgrid_api_key) {
          throw new Error('Client or API key not found')
        }

        sgMail.setApiKey(client.sendgrid_api_key)

        // Get template content if specified
        let htmlContent = step.html_content || ''
        if (step.template_id && !htmlContent) {
          const { data: template } = await supabase
            .from('templates')
            .select('html_content')
            .eq('id', step.template_id)
            .single()
          htmlContent = template?.html_content || ''
        }

        // Personalize content
        const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
        const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}`
        const mailingAddress = client.mailing_address || 'No mailing address configured'

        let personalizedHtml = htmlContent
          .replace(/{{email}}/gi, contact.email)
          .replace(/{{first_name}}/gi, contact.first_name || '')
          .replace(/{{last_name}}/gi, contact.last_name || '')
          .replace(/{{unsubscribe_url}}/gi, unsubscribeUrl)
          .replace(/{{mailing_address}}/gi, mailingAddress)

        // Handle campaign_name merge tag (from Salesforce Campaign trigger)
        if (enrollment.trigger_campaign) {
          personalizedHtml = personalizedHtml.replace(/{{campaign_name}}/gi, enrollment.trigger_campaign.name || '')
        } else {
          personalizedHtml = personalizedHtml.replace(/{{campaign_name}}/gi, '')
        }

        // Handle industry_link merge tag (lookup from industry_links table)
        if (contact.industry) {
          const { data: industryLink } = await supabase
            .from('industry_links')
            .select('link_url')
            .eq('client_id', sequence.client_id)
            .eq('industry', contact.industry)
            .single()

          const industryUrl = industryLink?.link_url || 'https://alconox.com/industries/'
          personalizedHtml = personalizedHtml.replace(/{{industry_link}}/gi, industryUrl)
        } else {
          // Default fallback URL
          personalizedHtml = personalizedHtml.replace(/{{industry_link}}/gi, 'https://alconox.com/industries/')
        }

        // Send email
        const msg = {
          to: contact.email,
          from: {
            email: sequence.from_email,
            name: sequence.from_name,
          },
          replyTo: sequence.reply_to || undefined,
          subject: step.subject,
          html: personalizedHtml,
          customArgs: {
            sequence_id: sequence.id,
            step_id: step.id,
            enrollment_id: enrollment.id,
          },
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }

        await sgMail.send(msg)

        // Update scheduled email status
        await supabase
          .from('scheduled_emails')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
          })
          .eq('id', scheduledEmail.id)

        // Update step sent count
        await supabase
          .from('sequence_steps')
          .update({ sent_count: step.sent_count + 1 })
          .eq('id', step.id)

        // Update enrollment
        const nextStepOrder = step.step_order + 1

        // Check if there's a next step
        const { data: nextStep } = await supabase
          .from('sequence_steps')
          .select('*')
          .eq('sequence_id', sequence.id)
          .eq('step_order', nextStepOrder)
          .single()

        if (nextStep) {
          // Schedule next email
          const nextSendTime = new Date()
          nextSendTime.setDate(nextSendTime.getDate() + (nextStep.delay_days || 0))
          nextSendTime.setHours(nextSendTime.getHours() + (nextStep.delay_hours || 0))

          await supabase.from('scheduled_emails').insert({
            enrollment_id: enrollment.id,
            step_id: nextStep.id,
            contact_id: contact.id,
            scheduled_for: nextSendTime.toISOString(),
            status: 'pending',
          })

          await supabase
            .from('sequence_enrollments')
            .update({
              current_step: step.step_order,
              last_email_sent_at: new Date().toISOString(),
              next_email_scheduled_at: nextSendTime.toISOString(),
            })
            .eq('id', enrollment.id)
        } else {
          // Sequence completed
          await supabase
            .from('sequence_enrollments')
            .update({
              current_step: step.step_order,
              status: 'completed',
              completed_at: new Date().toISOString(),
              last_email_sent_at: new Date().toISOString(),
              next_email_scheduled_at: null,
            })
            .eq('id', enrollment.id)

          // Update sequence completed count
          await supabase
            .from('email_sequences')
            .update({ total_completed: sequence.total_completed + 1 })
            .eq('id', sequence.id)
        }

        sent++
        console.log(`✅ Sent sequence email to ${contact.email} (step ${step.step_order})`)
      } catch (emailError) {
        console.error(`❌ Failed to send sequence email:`, emailError)

        // Update scheduled email with error
        await supabase
          .from('scheduled_emails')
          .update({
            status: 'failed',
            error_message: emailError.message,
            attempts: scheduledEmail.attempts + 1,
          })
          .eq('id', scheduledEmail.id)

        failed++
      }
    }

    res.json({
      processed: scheduledEmails.length,
      sent,
      failed,
    })
  } catch (error) {
    console.error('Error processing sequences:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Webhook handler for sequence analytics
 * This extends the existing webhook to handle sequence events
 */
app.post('/api/webhook/sequence', async (req, res) => {
  try {
    const events = req.body

    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'Invalid payload' })
    }

    for (const event of events) {
      const sequenceId = event.sequence_id || event.custom_args?.sequence_id
      const stepId = event.step_id || event.custom_args?.step_id
      const enrollmentId = event.enrollment_id || event.custom_args?.enrollment_id

      if (!sequenceId || !stepId) continue

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

      // Insert analytics event
      await supabase.from('sequence_analytics').insert({
        sequence_id: sequenceId,
        step_id: stepId,
        enrollment_id: enrollmentId,
        email: event.email,
        event_type: eventType,
        timestamp: new Date(event.timestamp * 1000).toISOString(),
        url: event.url || null,
        user_agent: event.useragent || null,
        ip_address: event.ip || null,
        sg_event_id: event.sg_event_id,
      })

      // Update step analytics
      if (eventType === 'open') {
        const { data: step } = await supabase
          .from('sequence_steps')
          .select('open_count')
          .eq('id', stepId)
          .single()
        if (step) {
          await supabase
            .from('sequence_steps')
            .update({ open_count: step.open_count + 1 })
            .eq('id', stepId)
        }
      } else if (eventType === 'click') {
        const { data: step } = await supabase
          .from('sequence_steps')
          .select('click_count')
          .eq('id', stepId)
          .single()
        if (step) {
          await supabase
            .from('sequence_steps')
            .update({ click_count: step.click_count + 1 })
            .eq('id', stepId)
        }
      }

      // Handle unsubscribe
      if (eventType === 'unsubscribe' && enrollmentId) {
        await supabase
          .from('sequence_enrollments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', enrollmentId)
      }
    }

    res.status(200).send('OK')
  } catch (error) {
    console.error('Sequence webhook error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============ SALESFORCE INTEGRATION ============
// Uses OAuth 2.0 Client Credentials Flow (server-to-server, no user interaction)

/**
 * Connect Salesforce using Client Credentials
 * Stores credentials and tests the connection
 */
app.post('/api/salesforce/connect', async (req, res) => {
  try {
    const { clientId, instanceUrl, salesforceClientId, salesforceClientSecret } = req.body

    if (!clientId || !instanceUrl || !salesforceClientId || !salesforceClientSecret) {
      return res.status(400).json({ error: 'All fields are required: clientId, instanceUrl, salesforceClientId, salesforceClientSecret' })
    }

    // Normalize instance URL
    let normalizedUrl = instanceUrl.trim()
    if (!normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl
    }
    if (normalizedUrl.endsWith('/')) {
      normalizedUrl = normalizedUrl.slice(0, -1)
    }

    // Test the connection by getting an access token
    const tokenUrl = `${normalizedUrl}/services/oauth2/token`
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: salesforceClientId,
      client_secret: salesforceClientSecret,
    })

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })

    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Salesforce token error:', tokenData)
      return res.status(400).json({ error: tokenData.error_description || tokenData.error || 'Failed to authenticate with Salesforce' })
    }

    // Connection successful - store credentials
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        salesforce_instance_url: normalizedUrl,
        salesforce_client_id: salesforceClientId,
        salesforce_client_secret: salesforceClientSecret,
        salesforce_connected_at: new Date().toISOString(),
        salesforce_sync_status: 'idle',
      })
      .eq('id', clientId)

    if (updateError) {
      console.error('Error storing Salesforce credentials:', updateError)
      return res.status(500).json({ error: 'Failed to save Salesforce connection' })
    }

    console.log(`✅ Salesforce connected for client ${clientId}`)
    res.json({ success: true, message: 'Salesforce connected successfully' })
  } catch (error) {
    console.error('Salesforce connect error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Disconnect Salesforce from a client
 */
app.post('/api/salesforce/disconnect', async (req, res) => {
  try {
    const { clientId } = req.body

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const { error } = await supabase
      .from('clients')
      .update({
        salesforce_instance_url: null,
        salesforce_client_id: null,
        salesforce_client_secret: null,
        salesforce_access_token: null,
        salesforce_refresh_token: null,
        salesforce_connected_at: null,
        salesforce_sync_status: null,
        salesforce_sync_message: null,
        last_salesforce_sync: null,
        salesforce_sync_count: null,
      })
      .eq('id', clientId)

    if (error) throw error

    console.log(`🔌 Salesforce disconnected for client ${clientId}`)
    res.json({ success: true })
  } catch (error) {
    console.error('Error disconnecting Salesforce:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get Salesforce connection status for a client
 */
app.get('/api/salesforce/status', async (req, res) => {
  try {
    const { clientId } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const { data: client, error } = await supabase
      .from('clients')
      .select('salesforce_instance_url, salesforce_connected_at, last_salesforce_sync, salesforce_sync_status, salesforce_sync_message, salesforce_sync_count')
      .eq('id', clientId)
      .single()

    if (error) throw error

    res.json({
      connected: !!client.salesforce_instance_url,
      instanceUrl: client.salesforce_instance_url,
      connectedAt: client.salesforce_connected_at,
      lastSync: client.last_salesforce_sync,
      syncStatus: client.salesforce_sync_status,
      syncMessage: client.salesforce_sync_message,
      syncCount: client.salesforce_sync_count,
    })
  } catch (error) {
    console.error('Error getting Salesforce status:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Helper function to get a Salesforce access token using Client Credentials flow
 * Returns { accessToken, instanceUrl }
 */
async function getSalesforceAccessToken(clientId) {
  const { data: client, error } = await supabase
    .from('clients')
    .select('salesforce_instance_url, salesforce_client_id, salesforce_client_secret')
    .eq('id', clientId)
    .single()

  if (error || !client.salesforce_client_id || !client.salesforce_client_secret) {
    throw new Error('Salesforce not connected for this client')
  }

  // Get fresh access token using Client Credentials flow
  const tokenUrl = `${client.salesforce_instance_url}/services/oauth2/token`
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: client.salesforce_client_id,
    client_secret: client.salesforce_client_secret,
  })

  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })

  const tokenData = await tokenResponse.json()

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || 'Failed to get Salesforce access token')
  }

  return {
    accessToken: tokenData.access_token,
    instanceUrl: client.salesforce_instance_url,
  }
}

/**
 * Helper function to get a Salesforce connection for a client
 * Uses Client Credentials flow to get fresh token
 */
async function getSalesforceConnection(clientId) {
  const { accessToken, instanceUrl } = await getSalesforceAccessToken(clientId)

  const conn = new jsforce.Connection({
    instanceUrl,
    accessToken,
  })

  return conn
}

/**
 * Get available Salesforce fields for Lead and Contact objects
 * This helps users understand what fields they can sync
 */
app.get('/api/salesforce/fields', async (req, res) => {
  try {
    const { clientId, object } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const conn = await getSalesforceConnection(clientId)

    // Get fields for both Lead and Contact, or a specific object
    const objects = object ? [object] : ['Lead', 'Contact']
    const result = {}

    for (const objName of objects) {
      const meta = await conn.sobject(objName).describe()
      result[objName] = meta.fields
        .filter(f => f.type !== 'address' && f.type !== 'location') // Filter out compound fields
        .map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          updateable: f.updateable,
          custom: f.custom,
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
    }

    res.json(result)
  } catch (error) {
    console.error('Error fetching Salesforce fields:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Sync contacts from Salesforce
 * Pulls Leads and Contacts modified since last sync
 */
app.post('/api/salesforce/sync', async (req, res) => {
  try {
    const { clientId, fullSync } = req.body

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    // Update sync status to 'syncing'
    await supabase
      .from('clients')
      .update({ salesforce_sync_status: 'syncing', salesforce_sync_message: 'Starting sync...' })
      .eq('id', clientId)

    const conn = await getSalesforceConnection(clientId)

    // Get last sync time
    const { data: client } = await supabase
      .from('clients')
      .select('last_salesforce_sync')
      .eq('id', clientId)
      .single()

    // For incremental sync, use last sync time. For full sync, use 60 days ago.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const syncSince = fullSync ? sixtyDaysAgo : client?.last_salesforce_sync

    let totalSynced = 0
    const syncStartTime = new Date().toISOString()

    // Sync Leads
    const leadsQuery = syncSince
      ? `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c FROM Lead WHERE Email != null AND LastModifiedDate > ${syncSince}`
      : `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c FROM Lead WHERE Email != null`

    console.log(`📥 Querying Salesforce Leads...`)

    try {
      let leads = await conn.query(leadsQuery)
      console.log(`Found ${leads.totalSize} total leads`)

      // Process all pages of results
      let leadBatch = 1
      const BATCH_SIZE = 100

      while (true) {
        console.log(`Processing lead batch ${leadBatch} (${leads.records.length} records)...`)

        // Collect records for batch upsert
        const batchRecords = []
        for (const lead of leads.records) {
          if (!lead.Email) continue
          batchRecords.push({
            client_id: clientId,
            email: lead.Email.toLowerCase().trim(),
            first_name: lead.FirstName || null,
            last_name: lead.LastName || null,
            company: lead.Company || null,
            salesforce_id: lead.Id,
            record_type: 'lead',
            industry: lead.Industry || null,
            source_code: lead.Source_code__c || null,
            source_code_history: lead.Source_Code_History__c || null,
            updated_at: new Date().toISOString(),
          })
        }

        // Upsert in batches of BATCH_SIZE
        for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
          const chunk = batchRecords.slice(i, i + BATCH_SIZE)
          const { error: upsertError } = await supabase
            .from('contacts')
            .upsert(chunk, {
              onConflict: 'salesforce_id',
              ignoreDuplicates: false,
            })

          if (upsertError) {
            // Try upserting by email instead if salesforce_id conflict fails
            await supabase
              .from('contacts')
              .upsert(chunk, {
                onConflict: 'email,client_id',
                ignoreDuplicates: false,
              })
          }
        }

        totalSynced += batchRecords.length

        // Check if there are more records to fetch
        if (!leads.done && leads.nextRecordsUrl) {
          leads = await conn.queryMore(leads.nextRecordsUrl)
          leadBatch++
        } else {
          break
        }
      }
    } catch (leadError) {
      console.error('Error syncing leads:', leadError.message)
      // Continue with contacts even if leads fail
    }

    // Sync Contacts (no Account.Name - not available in this org)
    const contactsQuery = syncSince
      ? `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c FROM Contact WHERE Email != null AND LastModifiedDate > ${syncSince}`
      : `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c FROM Contact WHERE Email != null`

    console.log(`📥 Querying Salesforce Contacts...`)

    try {
      let contacts = await conn.query(contactsQuery)
      console.log(`Found ${contacts.totalSize} total contacts`)

      // Process all pages of results
      let contactBatch = 1
      const BATCH_SIZE = 100

      while (true) {
        console.log(`Processing contact batch ${contactBatch} (${contacts.records.length} records)...`)

        // Collect records for batch upsert
        const batchRecords = []
        for (const contact of contacts.records) {
          if (!contact.Email) continue
          batchRecords.push({
            client_id: clientId,
            email: contact.Email.toLowerCase().trim(),
            first_name: contact.FirstName || null,
            last_name: contact.LastName || null,
            salesforce_id: contact.Id,
            record_type: 'contact',
            industry: contact.Industry__c || null,
            source_code: contact.Source_Code1__c || null,
            source_code_history: contact.Source_Code_History__c || null,
            updated_at: new Date().toISOString(),
          })
        }

        // Upsert in batches of BATCH_SIZE
        for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
          const chunk = batchRecords.slice(i, i + BATCH_SIZE)
          const { error: upsertError } = await supabase
            .from('contacts')
            .upsert(chunk, {
              onConflict: 'salesforce_id',
              ignoreDuplicates: false,
            })

          if (upsertError) {
            // Try upserting by email instead
            await supabase
              .from('contacts')
              .upsert(chunk, {
                onConflict: 'email,client_id',
                ignoreDuplicates: false,
              })
          }
        }

        totalSynced += batchRecords.length

        // Check if there are more records to fetch
        if (!contacts.done && contacts.nextRecordsUrl) {
          contacts = await conn.queryMore(contacts.nextRecordsUrl)
          contactBatch++
        } else {
          break
        }
      }
    } catch (contactError) {
      console.error('Error syncing contacts:', contactError.message)
    }

    // Update sync status
    await supabase
      .from('clients')
      .update({
        salesforce_sync_status: 'success',
        salesforce_sync_message: `Synced ${totalSynced} records`,
        salesforce_sync_count: totalSynced,
        last_salesforce_sync: syncStartTime,
      })
      .eq('id', clientId)

    console.log(`✅ Salesforce sync complete: ${totalSynced} records synced`)

    res.json({
      success: true,
      synced: totalSynced,
      message: `Successfully synced ${totalSynced} records from Salesforce`,
    })
  } catch (error) {
    console.error('Salesforce sync error:', error)

    // Update status to error
    await supabase
      .from('clients')
      .update({
        salesforce_sync_status: 'error',
        salesforce_sync_message: error.message,
      })
      .eq('id', req.body.clientId)

    res.status(500).json({ error: error.message })
  }
})

/**
 * Preview Salesforce data without syncing
 * Useful for testing the connection and seeing what data is available
 */
app.get('/api/salesforce/preview', async (req, res) => {
  try {
    const { clientId, object, limit } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const conn = await getSalesforceConnection(clientId)
    const recordLimit = parseInt(limit) || 10
    const targetObject = object || 'Lead'

    let query
    if (targetObject === 'Lead') {
      query = `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, LastModifiedDate FROM Lead WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT ${recordLimit}`
    } else {
      query = `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, LastModifiedDate FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT ${recordLimit}`
    }

    const result = await conn.query(query)

    res.json({
      object: targetObject,
      totalSize: result.totalSize,
      records: result.records,
    })
  } catch (error) {
    console.error('Error previewing Salesforce data:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============ INDUSTRY LINKS ENDPOINTS ============

/**
 * Get all industry links for a client
 */
app.get('/api/industry-links', async (req, res) => {
  try {
    const { clientId } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const { data, error } = await supabase
      .from('industry_links')
      .select('*')
      .eq('client_id', clientId)
      .order('industry', { ascending: true })

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Error fetching industry links:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Create or update an industry link
 */
app.post('/api/industry-links', async (req, res) => {
  try {
    const { clientId, industry, linkUrl, id } = req.body

    if (!clientId || !industry || !linkUrl) {
      return res.status(400).json({ error: 'clientId, industry, and linkUrl are required' })
    }

    let result
    if (id) {
      // Update existing
      const { data, error } = await supabase
        .from('industry_links')
        .update({
          industry,
          link_url: linkUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single()

      if (error) throw error
      result = data
    } else {
      // Create new (upsert by industry)
      const { data, error } = await supabase
        .from('industry_links')
        .upsert({
          client_id: clientId,
          industry,
          link_url: linkUrl,
        }, {
          onConflict: 'industry,client_id',
        })
        .select()
        .single()

      if (error) throw error
      result = data
    }

    res.json(result)
  } catch (error) {
    console.error('Error saving industry link:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Delete an industry link
 */
app.delete('/api/industry-links/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('industry_links')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting industry link:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============ SALESFORCE CAMPAIGNS ENDPOINTS ============

/**
 * Get all synced Salesforce campaigns for a client
 */
app.get('/api/salesforce/campaigns', async (req, res) => {
  try {
    const { clientId } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const { data, error } = await supabase
      .from('salesforce_campaigns')
      .select('*')
      .eq('client_id', clientId)
      .order('start_date', { ascending: false })

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Error fetching Salesforce campaigns:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get campaign members for a specific Salesforce campaign
 */
app.get('/api/salesforce/campaigns/:campaignId/members', async (req, res) => {
  try {
    const { campaignId } = req.params

    const { data, error } = await supabase
      .from('salesforce_campaign_members')
      .select(`
        *,
        contact:contacts(id, email, first_name, last_name, industry, record_type)
      `)
      .eq('salesforce_campaign_id', campaignId)
      .order('synced_at', { ascending: false })

    if (error) throw error

    res.json(data || [])
  } catch (error) {
    console.error('Error fetching campaign members:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Sync Salesforce Campaigns and Campaign Members
 * Only syncs Lead-based campaign members (LeadId != null)
 */
app.post('/api/salesforce/sync-campaigns', async (req, res) => {
  const { clientId } = req.body

  if (!clientId) {
    return res.status(400).json({ error: 'clientId is required' })
  }

  // Return immediately - sync runs in background
  res.json({
    success: true,
    message: 'Campaign sync started. This may take several minutes for large datasets. Check server logs for progress.',
  })

  // Run sync in background
  try {
    console.log(`🔄 Starting Salesforce Campaign sync for client ${clientId}`)

    const conn = await getSalesforceConnection(clientId)

    // 1. Query all Campaigns from Salesforce
    const campaignsQuery = `
      SELECT Id, Name, Type, Status, StartDate, EndDate
      FROM Campaign
      ORDER BY StartDate DESC
    `

    const campaignsResult = await conn.query(campaignsQuery)
    console.log(`📋 Found ${campaignsResult.totalSize} Salesforce campaigns`)

    let campaignsSynced = 0
    let membersSynced = 0
    let newEnrollments = 0

    // 2. Upsert campaigns into our database
    for (const sfCampaign of campaignsResult.records) {
      const { data: campaign, error: campaignError } = await supabase
        .from('salesforce_campaigns')
        .upsert({
          salesforce_id: sfCampaign.Id,
          name: sfCampaign.Name,
          type: sfCampaign.Type || null,
          status: sfCampaign.Status || null,
          start_date: sfCampaign.StartDate || null,
          end_date: sfCampaign.EndDate || null,
          client_id: clientId,
        }, {
          onConflict: 'salesforce_id,client_id',
        })
        .select()
        .single()

      if (campaignError) {
        console.error(`Error upserting campaign ${sfCampaign.Name}:`, campaignError)
        continue
      }

      campaignsSynced++

      // 3. Get Campaign Members - ONLY Leads (LeadId != null)
      const membersQuery = `
        SELECT Id, LeadId, Status
        FROM CampaignMember
        WHERE CampaignId = '${sfCampaign.Id}'
        AND LeadId != null
      `

      try {
        const membersResult = await conn.query(membersQuery)
        console.log(`  📥 Campaign "${sfCampaign.Name}": ${membersResult.totalSize} Lead members`)

        if (membersResult.records.length === 0) continue

        // Get all Lead IDs from this campaign
        const leadIds = membersResult.records.map(m => m.LeadId)

        // Batch lookup: find all matching contacts at once
        const { data: contacts } = await supabase
          .from('contacts')
          .select('id, salesforce_id')
          .eq('client_id', clientId)
          .in('salesforce_id', leadIds)

        const contactMap = new Map(contacts?.map(c => [c.salesforce_id, c.id]) || [])

        // Get existing members in one query
        const memberSfIds = membersResult.records.map(m => m.Id)
        const { data: existingMembers } = await supabase
          .from('salesforce_campaign_members')
          .select('salesforce_id')
          .eq('client_id', clientId)
          .in('salesforce_id', memberSfIds)

        const existingMemberSet = new Set(existingMembers?.map(m => m.salesforce_id) || [])

        // Prepare batch upsert data
        const membersToUpsert = []
        const newMemberContactIds = []

        for (const member of membersResult.records) {
          const contactId = contactMap.get(member.LeadId)
          if (!contactId) continue // Lead not synced yet

          const isNew = !existingMemberSet.has(member.Id)

          membersToUpsert.push({
            salesforce_id: member.Id,
            salesforce_campaign_id: campaign.id,
            contact_id: contactId,
            status: member.Status || null,
            client_id: clientId,
            synced_at: new Date().toISOString(),
          })

          if (isNew) {
            newMemberContactIds.push(contactId)
          }
        }

        // Batch upsert all members
        if (membersToUpsert.length > 0) {
          const { error: batchError } = await supabase
            .from('salesforce_campaign_members')
            .upsert(membersToUpsert, { onConflict: 'salesforce_id,client_id' })

          if (batchError) {
            console.error(`Error batch upserting members:`, batchError)
          } else {
            membersSynced += membersToUpsert.length
          }
        }

        // Handle auto-enrollment for new members (if any sequences are configured)
        if (newMemberContactIds.length > 0) {
          const { data: sequences } = await supabase
            .from('email_sequences')
            .select('*')
            .eq('client_id', clientId)
            .eq('status', 'active')
            .eq('trigger_type', 'salesforce_campaign')
            .contains('trigger_salesforce_campaign_ids', [campaign.id])

          if (sequences && sequences.length > 0) {
            for (const sequence of sequences) {
              // Get first step
              const { data: firstStep } = await supabase
                .from('sequence_steps')
                .select('*')
                .eq('sequence_id', sequence.id)
                .eq('step_order', 1)
                .single()

              if (!firstStep) continue

              // Get already enrolled contacts
              const { data: existingEnrollments } = await supabase
                .from('sequence_enrollments')
                .select('contact_id')
                .eq('sequence_id', sequence.id)
                .in('contact_id', newMemberContactIds)

              const enrolledSet = new Set(existingEnrollments?.map(e => e.contact_id) || [])
              const contactsToEnroll = newMemberContactIds.filter(id => !enrolledSet.has(id))

              if (contactsToEnroll.length === 0) continue

              const now = new Date().toISOString()

              // Batch create enrollments
              const enrollmentsToCreate = contactsToEnroll.map(contactId => ({
                sequence_id: sequence.id,
                contact_id: contactId,
                status: 'active',
                current_step: 0,
                trigger_campaign_id: campaign.id,
                next_email_scheduled_at: now,
              }))

              const { data: createdEnrollments, error: enrollError } = await supabase
                .from('sequence_enrollments')
                .insert(enrollmentsToCreate)
                .select('id, contact_id')

              if (enrollError) {
                console.error('Error batch creating enrollments:', enrollError)
                continue
              }

              // Batch schedule first emails
              const emailsToSchedule = createdEnrollments.map(enrollment => ({
                enrollment_id: enrollment.id,
                step_id: firstStep.id,
                contact_id: enrollment.contact_id,
                scheduled_for: now,
                status: 'pending',
              }))

              await supabase.from('scheduled_emails').insert(emailsToSchedule)

              // Update sequence enrolled count
              await supabase
                .from('email_sequences')
                .update({ total_enrolled: sequence.total_enrolled + createdEnrollments.length })
                .eq('id', sequence.id)

              newEnrollments += createdEnrollments.length
              console.log(`  ✅ Auto-enrolled ${createdEnrollments.length} contacts in sequence "${sequence.name}"`)
            }
          }
        }
      } catch (memberError) {
        console.error(`Error processing members for campaign ${sfCampaign.Name}:`, memberError.message)
      }
    }

    console.log(`✅ Salesforce Campaign sync complete: ${campaignsSynced} campaigns, ${membersSynced} members, ${newEnrollments} new enrollments`)
  } catch (error) {
    console.error('❌ Error syncing Salesforce campaigns:', error)
  }
})

// Enroll existing campaign members into a sequence
app.post('/api/sequences/:sequenceId/enroll-campaign-members', async (req, res) => {
  const { sequenceId } = req.params
  const { campaignIds, clientId } = req.body

  if (!sequenceId || !campaignIds || !Array.isArray(campaignIds) || campaignIds.length === 0) {
    return res.status(400).json({ error: 'sequenceId and campaignIds array are required' })
  }

  try {
    // Get the sequence
    const { data: sequence, error: seqError } = await supabase
      .from('email_sequences')
      .select('*')
      .eq('id', sequenceId)
      .single()

    if (seqError || !sequence) {
      return res.status(404).json({ error: 'Sequence not found' })
    }

    // Get first step
    const { data: firstStep } = await supabase
      .from('sequence_steps')
      .select('*')
      .eq('sequence_id', sequenceId)
      .eq('step_order', 1)
      .single()

    if (!firstStep) {
      return res.status(400).json({ error: 'Sequence has no steps' })
    }

    // Get all contacts who are members of the specified campaigns
    const { data: members, error: membersError } = await supabase
      .from('salesforce_campaign_members')
      .select('contact_id')
      .in('salesforce_campaign_id', campaignIds)
      .eq('client_id', clientId)

    if (membersError) throw membersError

    if (!members || members.length === 0) {
      return res.json({ enrolled: 0, message: 'No contacts found in selected campaigns' })
    }

    // Get unique contact IDs
    const contactIds = [...new Set(members.map(m => m.contact_id))]

    // Check which contacts are already enrolled
    const { data: existingEnrollments } = await supabase
      .from('sequence_enrollments')
      .select('contact_id')
      .eq('sequence_id', sequenceId)
      .in('contact_id', contactIds)

    const enrolledSet = new Set(existingEnrollments?.map(e => e.contact_id) || [])
    const contactsToEnroll = contactIds.filter(id => !enrolledSet.has(id))

    if (contactsToEnroll.length === 0) {
      return res.json({ enrolled: 0, message: 'All contacts are already enrolled' })
    }

    // Check for unsubscribed contacts
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id')
      .in('id', contactsToEnroll)
      .eq('unsubscribed', false)

    const subscribedContactIds = contacts?.map(c => c.id) || []

    if (subscribedContactIds.length === 0) {
      return res.json({ enrolled: 0, message: 'All contacts are unsubscribed' })
    }

    const now = new Date().toISOString()

    // Create enrollments
    const enrollmentsToCreate = subscribedContactIds.map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      status: 'active',
      current_step: 1,
      enrolled_at: now,
      next_email_scheduled_at: now, // Send first email immediately
    }))

    // Batch insert enrollments
    const { error: enrollError } = await supabase
      .from('sequence_enrollments')
      .insert(enrollmentsToCreate)

    if (enrollError) throw enrollError

    // Schedule first emails
    const scheduledEmailsToCreate = subscribedContactIds.map(contactId => ({
      enrollment_id: null, // Will be linked later
      step_id: firstStep.id,
      contact_id: contactId,
      scheduled_for: now,
      status: 'pending',
      attempts: 0,
    }))

    // Get the created enrollment IDs
    const { data: newEnrollments } = await supabase
      .from('sequence_enrollments')
      .select('id, contact_id')
      .eq('sequence_id', sequenceId)
      .in('contact_id', subscribedContactIds)

    // Create scheduled emails with enrollment IDs
    if (newEnrollments) {
      const enrollmentMap = new Map(newEnrollments.map(e => [e.contact_id, e.id]))
      const emailsWithEnrollmentIds = scheduledEmailsToCreate.map(email => ({
        ...email,
        enrollment_id: enrollmentMap.get(email.contact_id),
      }))

      await supabase.from('scheduled_emails').insert(emailsWithEnrollmentIds)
    }

    // Update sequence total_enrolled count
    await supabase
      .from('email_sequences')
      .update({ total_enrolled: (sequence.total_enrolled || 0) + subscribedContactIds.length })
      .eq('id', sequenceId)

    console.log(`✅ Enrolled ${subscribedContactIds.length} contacts into sequence ${sequence.name}`)

    res.json({
      enrolled: subscribedContactIds.length,
      message: `Successfully enrolled ${subscribedContactIds.length} contact(s)`,
    })
  } catch (error) {
    console.error('Error enrolling campaign members:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Backfill engagement scores for existing contacts
 * OPTIMIZED: Only processes contacts that have analytics events
 */
app.post('/api/contacts/backfill-engagement', async (req, res) => {
  try {
    const { clientId } = req.body

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    console.log(`📊 Starting optimized engagement backfill for client ${clientId}`)

    // Step 1: Get all unique emails that have ANY analytics events
    console.log(`   Step 1: Finding emails with analytics events...`)
    const { data: emailsWithEvents, error: emailsError } = await supabase
      .from('analytics_events')
      .select('email')

    if (emailsError) throw emailsError

    // Get unique emails
    const uniqueEmails = [...new Set(emailsWithEvents?.map(e => e.email) || [])]
    console.log(`   Found ${uniqueEmails.length} unique emails with analytics events`)

    if (uniqueEmails.length === 0) {
      return res.json({ updated: 0, total: 0, message: 'No analytics events found' })
    }

    // Step 2: Get contacts for this client that match those emails
    console.log(`   Step 2: Matching to contacts for this client...`)
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id, email')
      .eq('client_id', clientId)
      .in('email', uniqueEmails)

    if (contactsError) throw contactsError

    if (!contacts || contacts.length === 0) {
      return res.json({ updated: 0, total: 0, message: 'No matching contacts found' })
    }

    // Debug: check if our suspicious contacts are in the list
    const debugEmails = ['judith.neiman@wynnlasvegas.com', 'kaydia_king@heart-nta.org', 'kbarnes@estee.ca']
    const foundDebugContacts = contacts.filter(c => debugEmails.includes(c.email))
    console.log(`   DEBUG: Found ${foundDebugContacts.length} of 3 suspicious contacts:`, foundDebugContacts.map(c => c.email))

    console.log(`   Found ${contacts.length} contacts to process (skipping ${uniqueEmails.length - contacts.length} emails not in this client)`)

    // Step 3: Process each contact with events
    let updated = 0
    let processed = 0

    for (const contact of contacts) {
      processed++
      if (processed % 100 === 0) {
        console.log(`   Processing ${processed}/${contacts.length}...`)
      }

      // Get open count (opens are reliable, not typically faked by bots)
      const { count: openCount } = await supabase
        .from('analytics_events')
        .select('*', { count: 'exact', head: true })
        .eq('email', contact.email)
        .eq('event_type', 'open')

      // Get click events with timestamps and URLs for bot detection
      const { data: clickEvents } = await supabase
        .from('analytics_events')
        .select('timestamp, url, campaign_id')
        .eq('email', contact.email)
        .eq('event_type', 'click')
        .order('timestamp', { ascending: true })

      // Calculate human clicks (filtering out bot activity)
      let humanClicks = 0
      if (clickEvents && clickEvents.length > 0) {
        // Group clicks by campaign
        const clicksByCampaign = {}
        for (const click of clickEvents) {
          const campId = click.campaign_id || 'unknown'
          if (!clicksByCampaign[campId]) {
            clicksByCampaign[campId] = []
          }
          clicksByCampaign[campId].push(click)
        }

        // For each campaign, check if clicks look like bot or human
        for (const campId in clicksByCampaign) {
          const campClicks = clicksByCampaign[campId]

          if (campClicks.length === 1) {
            // Single click is likely human
            humanClicks += 1
          } else {
            // Multiple clicks - check time spread
            // Convert timestamps to milliseconds for proper comparison
            const timestamps = campClicks.map(c => new Date(c.timestamp).getTime())
            const minTime = Math.min(...timestamps)
            const maxTime = Math.max(...timestamps)
            const timeSpreadSeconds = (maxTime - minTime) / 1000

            // Debug logging for suspicious contacts
            const debugEmails = ['judith.neiman@wynnlasvegas.com', 'kaydia_king@heart-nta.org', 'kbarnes@estee.ca']
            if (debugEmails.includes(contact.email)) {
              console.log(`   DEBUG ${contact.email}: ${campClicks.length} clicks, timeSpread=${timeSpreadSeconds}s, raw timestamps:`, campClicks.slice(0, 3).map(c => c.timestamp))
            }

            // If all clicks happened within 30 seconds, likely a bot
            // Bots click all links nearly simultaneously
            if (timeSpreadSeconds <= 30) {
              // Bot detected - don't count these clicks
              if (debugEmails.includes(contact.email)) {
                console.log(`   DEBUG ${contact.email}: BOT DETECTED - setting clicks to 0`)
              }
            } else {
              // Human behavior - count unique URLs clicked
              const uniqueUrls = new Set(campClicks.map(c => c.url).filter(Boolean))
              humanClicks += uniqueUrls.size
              if (debugEmails.includes(contact.email)) {
                console.log(`   DEBUG ${contact.email}: HUMAN - counting ${uniqueUrls.size} unique URLs`)
              }
            }
          }
        }
      }

      // Get bounce status
      const { data: bounceEvent } = await supabase
        .from('analytics_events')
        .select('timestamp, campaign_id')
        .eq('email', contact.email)
        .eq('event_type', 'bounce')
        .order('timestamp', { ascending: false })
        .limit(1)
        .single()

      // Get last engagement timestamp
      const { data: lastEngagement } = await supabase
        .from('analytics_events')
        .select('timestamp')
        .eq('email', contact.email)
        .in('event_type', ['open', 'click'])
        .order('timestamp', { ascending: false })
        .limit(1)
        .single()

      const totalOpens = openCount || 0
      const totalClicks = humanClicks // Use bot-filtered click count
      const engagementScore = totalOpens + (totalClicks * 2)

      // Build update object
      const updateData = {
        total_opens: totalOpens,
        total_clicks: totalClicks,
        engagement_score: engagementScore,
      }

      // Add bounce data if present
      if (bounceEvent) {
        updateData.bounce_status = 'hard' // Assume hard bounce for historical data
        updateData.bounced_at = bounceEvent.timestamp
        updateData.last_bounce_campaign_id = bounceEvent.campaign_id
      }

      // Add last engaged timestamp
      if (lastEngagement) {
        updateData.last_engaged_at = lastEngagement.timestamp
      }

      // Update contact
      const { error: updateError } = await supabase
        .from('contacts')
        .update(updateData)
        .eq('id', contact.id)

      if (!updateError) {
        updated++
      }
    }

    console.log(`   ✅ Updated ${updated} of ${contacts.length} contacts`)

    res.json({
      updated,
      total: contacts.length,
      message: `Successfully backfilled engagement data for ${updated} contacts`,
    })
  } catch (error) {
    console.error('Error backfilling engagement:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Sync bounce types from SendGrid's suppression API
 * Updates contacts with accurate hard/soft bounce classification
 */
app.post('/api/contacts/sync-bounce-types', async (req, res) => {
  try {
    const { clientId } = req.body

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    // Get client's SendGrid API key
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('sendgrid_api_key')
      .eq('id', clientId)
      .single()

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' })
    }

    console.log(`📧 Syncing bounce types from SendGrid for client ${clientId}`)

    // Fetch bounces from SendGrid (hard bounces)
    const bouncesResponse = await fetch('https://api.sendgrid.com/v3/suppression/bounces', {
      headers: {
        'Authorization': `Bearer ${client.sendgrid_api_key}`,
        'Content-Type': 'application/json',
      },
    })

    if (!bouncesResponse.ok) {
      throw new Error(`SendGrid bounces API error: ${bouncesResponse.status}`)
    }

    const bounces = await bouncesResponse.json()
    console.log(`   Found ${bounces.length} bounces in SendGrid`)

    // Fetch blocks from SendGrid (usually soft/temporary issues)
    const blocksResponse = await fetch('https://api.sendgrid.com/v3/suppression/blocks', {
      headers: {
        'Authorization': `Bearer ${client.sendgrid_api_key}`,
        'Content-Type': 'application/json',
      },
    })

    if (!blocksResponse.ok) {
      throw new Error(`SendGrid blocks API error: ${blocksResponse.status}`)
    }

    const blocks = await blocksResponse.json()
    console.log(`   Found ${blocks.length} blocks in SendGrid`)

    // Create maps for quick lookup
    const hardBounceEmails = new Set(bounces.map(b => b.email.toLowerCase()))
    const softBounceEmails = new Set(blocks.map(b => b.email.toLowerCase()))

    // Remove overlaps - if in both, treat as hard bounce
    for (const email of hardBounceEmails) {
      softBounceEmails.delete(email)
    }

    let hardUpdated = 0
    let softUpdated = 0

    // Update hard bounces
    if (hardBounceEmails.size > 0) {
      const hardEmails = Array.from(hardBounceEmails)

      // Process in batches of 100 for the IN clause
      for (let i = 0; i < hardEmails.length; i += 100) {
        const batch = hardEmails.slice(i, i + 100)
        const { data, error } = await supabase
          .from('contacts')
          .update({ bounce_status: 'hard' })
          .eq('client_id', clientId)
          .in('email', batch)
          .select('id')

        if (!error && data) {
          hardUpdated += data.length
        }
      }
    }

    // Update soft bounces (blocks)
    if (softBounceEmails.size > 0) {
      const softEmails = Array.from(softBounceEmails)

      for (let i = 0; i < softEmails.length; i += 100) {
        const batch = softEmails.slice(i, i + 100)
        const { data, error } = await supabase
          .from('contacts')
          .update({ bounce_status: 'soft' })
          .eq('client_id', clientId)
          .in('email', batch)
          .select('id')

        if (!error && data) {
          softUpdated += data.length
        }
      }
    }

    console.log(`   ✅ Updated ${hardUpdated} hard bounces, ${softUpdated} soft bounces`)

    res.json({
      hardBounces: hardUpdated,
      softBounces: softUpdated,
      sendgridHardTotal: bounces.length,
      sendgridSoftTotal: blocks.length,
      message: `Updated ${hardUpdated} hard bounces and ${softUpdated} soft bounces from SendGrid`,
    })
  } catch (error) {
    console.error('Error syncing bounce types:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// STATIC FILE SERVING (Frontend)
// Serve the built React app from the dist folder
// This must come AFTER all API routes
// ============================================================

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, '../dist')))

// Handle SPA routing - serve index.html for all non-API routes
// This allows React Router to handle client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`)

  // Start cron job to process scheduled campaigns and sequence emails every minute
  cron.schedule('* * * * *', async () => {
    try {
      // ============ PART 0: Process scheduled campaigns ============
      const now = new Date().toISOString()
      const { data: scheduledCampaigns, error: scheduledError } = await supabase
        .from('campaigns')
        .select('id, name')
        .eq('status', 'scheduled')
        .lte('scheduled_at', now)

      if (scheduledError) {
        console.error('❌ Error fetching scheduled campaigns:', scheduledError.message)
      } else if (scheduledCampaigns && scheduledCampaigns.length > 0) {
        console.log(`📅 Found ${scheduledCampaigns.length} scheduled campaign(s) to send`)

        for (const campaign of scheduledCampaigns) {
          try {
            console.log(`📧 Sending scheduled campaign: ${campaign.name} (${campaign.id})`)
            const result = await sendCampaignById(campaign.id)
            console.log(`✅ Scheduled campaign sent: ${campaign.name} - ${result.sent} emails`)
          } catch (campaignError) {
            console.error(`❌ Failed to send scheduled campaign ${campaign.name}:`, campaignError.message)
            // Mark campaign as failed
            await supabase
              .from('campaigns')
              .update({ status: 'failed' })
              .eq('id', campaign.id)
          }
        }
      }

      // ============ PART 1: Auto-enroll contacts based on tag triggers ============
      const { data: activeSequences } = await supabase
        .from('email_sequences')
        .select('*')
        .eq('status', 'active')
        .eq('trigger_type', 'tag_added')

      if (activeSequences && activeSequences.length > 0) {
        for (const sequence of activeSequences) {
          const triggerTag = sequence.trigger_config?.tag
          if (!triggerTag) continue

          // Find contacts with this tag who aren't enrolled yet
          const { data: contacts } = await supabase
            .from('contacts')
            .select('id')
            .eq('client_id', sequence.client_id)
            .eq('unsubscribed', false)
            .contains('tags', [triggerTag])

          if (!contacts || contacts.length === 0) continue

          const contactIds = contacts.map(c => c.id)

          // Get already enrolled contacts
          const { data: enrolled } = await supabase
            .from('sequence_enrollments')
            .select('contact_id')
            .eq('sequence_id', sequence.id)
            .in('contact_id', contactIds)

          const enrolledIds = new Set(enrolled?.map(e => e.contact_id) || [])
          const newContactIds = contactIds.filter(id => !enrolledIds.has(id))

          if (newContactIds.length === 0) continue

          // Get first step
          const { data: firstStep } = await supabase
            .from('sequence_steps')
            .select('*')
            .eq('sequence_id', sequence.id)
            .eq('step_order', 1)
            .single()

          if (!firstStep) continue

          const now = new Date()

          // Create enrollments
          const enrollments = newContactIds.map(contactId => ({
            sequence_id: sequence.id,
            contact_id: contactId,
            status: 'active',
            current_step: 0,
            next_email_scheduled_at: now.toISOString(),
          }))

          const { error: enrollError } = await supabase
            .from('sequence_enrollments')
            .insert(enrollments)

          if (enrollError) {
            console.error('❌ Error auto-enrolling contacts:', enrollError)
            continue
          }

          // Get the new enrollments to schedule emails
          const { data: newEnrollments } = await supabase
            .from('sequence_enrollments')
            .select('id, contact_id')
            .eq('sequence_id', sequence.id)
            .in('contact_id', newContactIds)

          if (newEnrollments) {
            const scheduledEmails = newEnrollments.map(enrollment => ({
              enrollment_id: enrollment.id,
              step_id: firstStep.id,
              contact_id: enrollment.contact_id,
              scheduled_for: now.toISOString(),
              status: 'pending',
            }))

            await supabase.from('scheduled_emails').insert(scheduledEmails)
          }

          // Update total enrolled count
          await supabase
            .from('email_sequences')
            .update({ total_enrolled: sequence.total_enrolled + newContactIds.length })
            .eq('id', sequence.id)

          console.log(`✅ Auto-enrolled ${newContactIds.length} contacts in "${sequence.name}" (tag: ${triggerTag})`)
        }
      }

      // ============ PART 2: Process scheduled emails ============
      // Reuse 'now' from PART 0

      // Get pending scheduled emails that are due
      const { data: scheduledEmails, error: fetchError } = await supabase
        .from('scheduled_emails')
        .select(`
          *,
          enrollment:sequence_enrollments(
            *,
            sequence:email_sequences(*),
            contact:contacts(*),
            trigger_campaign:salesforce_campaigns(id, name, type)
          ),
          step:sequence_steps(*)
        `)
        .eq('status', 'pending')
        .lte('scheduled_for', now)
        .limit(50)

      if (fetchError) {
        console.error('❌ Error fetching scheduled emails:', fetchError)
        return
      }

      if (!scheduledEmails || scheduledEmails.length === 0) {
        return // No emails to process
      }

      console.log(`📬 Processing ${scheduledEmails.length} scheduled sequence emails`)

      let sent = 0
      let failed = 0

      for (const scheduledEmail of scheduledEmails) {
        try {
          const { enrollment, step } = scheduledEmail
          const { sequence, contact } = enrollment

          // Skip if sequence is not active or contact is unsubscribed
          if (sequence.status !== 'active' || contact.unsubscribed) {
            await supabase
              .from('scheduled_emails')
              .update({ status: 'cancelled' })
              .eq('id', scheduledEmail.id)
            continue
          }

          // Skip if enrollment is not active
          if (enrollment.status !== 'active') {
            await supabase
              .from('scheduled_emails')
              .update({ status: 'cancelled' })
              .eq('id', scheduledEmail.id)
            continue
          }

          // Get client for API key
          const { data: client } = await supabase
            .from('clients')
            .select('*')
            .eq('id', sequence.client_id)
            .single()

          if (!client || !client.sendgrid_api_key) {
            throw new Error('Client or API key not found')
          }

          sgMail.setApiKey(client.sendgrid_api_key)

          // Get template content if specified
          let htmlContent = step.html_content || ''
          if (step.template_id && !htmlContent) {
            const { data: template } = await supabase
              .from('templates')
              .select('html_content')
              .eq('id', step.template_id)
              .single()
            htmlContent = template?.html_content || ''
          }

          // Personalize content
          const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
          const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}`
          const mailingAddress = client.mailing_address || 'No mailing address configured'

          let personalizedHtml = htmlContent
            .replace(/{{email}}/gi, contact.email)
            .replace(/{{first_name}}/gi, contact.first_name || '')
            .replace(/{{last_name}}/gi, contact.last_name || '')
            .replace(/{{unsubscribe_url}}/gi, unsubscribeUrl)
            .replace(/{{mailing_address}}/gi, mailingAddress)

          // Handle campaign_name merge tag (from Salesforce Campaign trigger)
          if (enrollment.trigger_campaign) {
            personalizedHtml = personalizedHtml.replace(/{{campaign_name}}/gi, enrollment.trigger_campaign.name || '')
          } else {
            personalizedHtml = personalizedHtml.replace(/{{campaign_name}}/gi, '')
          }

          // Handle industry_link merge tag (lookup from industry_links table)
          if (contact.industry) {
            const { data: industryLink } = await supabase
              .from('industry_links')
              .select('link_url')
              .eq('client_id', sequence.client_id)
              .eq('industry', contact.industry)
              .single()

            const industryUrl = industryLink?.link_url || 'https://alconox.com/industries/'
            personalizedHtml = personalizedHtml.replace(/{{industry_link}}/gi, industryUrl)
          } else {
            // Default fallback URL
            personalizedHtml = personalizedHtml.replace(/{{industry_link}}/gi, 'https://alconox.com/industries/')
          }

          // Send email
          const msg = {
            to: contact.email,
            from: {
              email: sequence.from_email,
              name: sequence.from_name,
            },
            replyTo: sequence.reply_to || undefined,
            subject: step.subject,
            html: personalizedHtml,
            customArgs: {
              sequence_id: sequence.id,
              step_id: step.id,
              enrollment_id: enrollment.id,
            },
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }

          await sgMail.send(msg)

          // Update scheduled email status
          await supabase
            .from('scheduled_emails')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
            })
            .eq('id', scheduledEmail.id)

          // Update step sent count
          await supabase
            .from('sequence_steps')
            .update({ sent_count: step.sent_count + 1 })
            .eq('id', step.id)

          // Update enrollment
          const nextStepOrder = step.step_order + 1

          // Check if there's a next step
          const { data: nextStep } = await supabase
            .from('sequence_steps')
            .select('*')
            .eq('sequence_id', sequence.id)
            .eq('step_order', nextStepOrder)
            .single()

          if (nextStep) {
            // Schedule next email
            const nextSendTime = new Date()
            nextSendTime.setDate(nextSendTime.getDate() + (nextStep.delay_days || 0))
            nextSendTime.setHours(nextSendTime.getHours() + (nextStep.delay_hours || 0))

            await supabase.from('scheduled_emails').insert({
              enrollment_id: enrollment.id,
              step_id: nextStep.id,
              contact_id: contact.id,
              scheduled_for: nextSendTime.toISOString(),
              status: 'pending',
            })

            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: nextSendTime.toISOString(),
              })
              .eq('id', enrollment.id)
          } else {
            // Sequence completed
            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                status: 'completed',
                completed_at: new Date().toISOString(),
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: null,
              })
              .eq('id', enrollment.id)

            // Update sequence completed count
            await supabase
              .from('email_sequences')
              .update({ total_completed: sequence.total_completed + 1 })
              .eq('id', sequence.id)
          }

          sent++
          console.log(`✅ Sent sequence email to ${contact.email} (step ${step.step_order})`)
        } catch (emailError) {
          console.error(`❌ Failed to send sequence email:`, emailError.message)

          // Update scheduled email with error
          await supabase
            .from('scheduled_emails')
            .update({
              status: 'failed',
              error_message: emailError.message,
              attempts: scheduledEmail.attempts + 1,
            })
            .eq('id', scheduledEmail.id)

          failed++
        }
      }

      if (sent > 0 || failed > 0) {
        console.log(`📊 Sequence processing complete: ${sent} sent, ${failed} failed`)
      }
    } catch (error) {
      console.error('❌ Cron job error:', error.message)
    }
  })

  console.log('✅ Cron job started (runs every minute) - processes scheduled campaigns and automation sequences')

  // Daily Salesforce sync at 6 AM UTC
  cron.schedule('0 6 * * *', async () => {
    console.log('🔄 Starting daily Salesforce sync...')
    try {
      // Find all clients with Salesforce connected
      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, name, salesforce_client_id')
        .not('salesforce_client_id', 'is', null)

      if (error) {
        console.error('❌ Error fetching clients for Salesforce sync:', error.message)
        return
      }

      if (!clients || clients.length === 0) {
        console.log('📭 No clients with Salesforce connected')
        return
      }

      console.log(`📋 Found ${clients.length} client(s) with Salesforce connected`)

      for (const client of clients) {
        console.log(`🔄 Syncing Salesforce for client: ${client.name} (${client.id})`)
        try {
          // Update sync status
          await supabase
            .from('clients')
            .update({ salesforce_sync_status: 'syncing', salesforce_sync_message: 'Daily auto-sync starting...' })
            .eq('id', client.id)

          const conn = await getSalesforceConnection(client.id)

          // Get last sync time for incremental sync
          const { data: clientData } = await supabase
            .from('clients')
            .select('last_salesforce_sync')
            .eq('id', client.id)
            .single()

          const lastSync = clientData?.last_salesforce_sync
          let totalSynced = 0
          const syncStartTime = new Date().toISOString()
          const BATCH_SIZE = 100

          // Sync Leads
          const leadsQuery = lastSync
            ? `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c FROM Lead WHERE Email != null AND LastModifiedDate > ${lastSync}`
            : `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c FROM Lead WHERE Email != null`

          let leads = await conn.query(leadsQuery)
          console.log(`  📥 Found ${leads.totalSize} leads to sync`)

          while (true) {
            const batchRecords = []
            for (const lead of leads.records) {
              if (!lead.Email) continue
              batchRecords.push({
                client_id: client.id,
                email: lead.Email.toLowerCase().trim(),
                first_name: lead.FirstName || null,
                last_name: lead.LastName || null,
                company: lead.Company || null,
                salesforce_id: lead.Id,
                record_type: 'lead',
                industry: lead.Industry || null,
                source_code: lead.Source_code__c || null,
                source_code_history: lead.Source_Code_History__c || null,
                updated_at: new Date().toISOString(),
              })
            }

            for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
              const chunk = batchRecords.slice(i, i + BATCH_SIZE)
              const { error: upsertError } = await supabase
                .from('contacts')
                .upsert(chunk, { onConflict: 'salesforce_id', ignoreDuplicates: false })
              if (upsertError) {
                await supabase.from('contacts').upsert(chunk, { onConflict: 'email,client_id', ignoreDuplicates: false })
              }
            }
            totalSynced += batchRecords.length

            if (!leads.done && leads.nextRecordsUrl) {
              leads = await conn.queryMore(leads.nextRecordsUrl)
            } else {
              break
            }
          }

          // Sync Contacts
          const contactsQuery = lastSync
            ? `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c FROM Contact WHERE Email != null AND LastModifiedDate > ${lastSync}`
            : `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c FROM Contact WHERE Email != null`

          let contacts = await conn.query(contactsQuery)
          console.log(`  📥 Found ${contacts.totalSize} contacts to sync`)

          while (true) {
            const batchRecords = []
            for (const contact of contacts.records) {
              if (!contact.Email) continue
              batchRecords.push({
                client_id: client.id,
                email: contact.Email.toLowerCase().trim(),
                first_name: contact.FirstName || null,
                last_name: contact.LastName || null,
                salesforce_id: contact.Id,
                record_type: 'contact',
                industry: contact.Industry__c || null,
                source_code: contact.Source_Code1__c || null,
                source_code_history: contact.Source_Code_History__c || null,
                updated_at: new Date().toISOString(),
              })
            }

            for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
              const chunk = batchRecords.slice(i, i + BATCH_SIZE)
              const { error: upsertError } = await supabase
                .from('contacts')
                .upsert(chunk, { onConflict: 'salesforce_id', ignoreDuplicates: false })
              if (upsertError) {
                await supabase.from('contacts').upsert(chunk, { onConflict: 'email,client_id', ignoreDuplicates: false })
              }
            }
            totalSynced += batchRecords.length

            if (!contacts.done && contacts.nextRecordsUrl) {
              contacts = await conn.queryMore(contacts.nextRecordsUrl)
            } else {
              break
            }
          }

          // Update sync status
          await supabase
            .from('clients')
            .update({
              salesforce_sync_status: 'success',
              salesforce_sync_message: `Auto-synced ${totalSynced} records`,
              salesforce_sync_count: totalSynced,
              last_salesforce_sync: syncStartTime,
            })
            .eq('id', client.id)

          console.log(`  ✅ Synced ${totalSynced} records for ${client.name}`)

          // Also sync Salesforce Campaigns
          console.log(`  🔄 Syncing Salesforce Campaigns for ${client.name}...`)
          try {
            const campaignsQuery = `SELECT Id, Name, Type, Status, StartDate, EndDate FROM Campaign ORDER BY StartDate DESC`
            const campaignsResult = await conn.query(campaignsQuery)
            let campaignsSynced = 0
            let membersSynced = 0
            let newEnrollments = 0

            for (const sfCampaign of campaignsResult.records) {
              const { data: campaign, error: campaignError } = await supabase
                .from('salesforce_campaigns')
                .upsert({
                  salesforce_id: sfCampaign.Id,
                  name: sfCampaign.Name,
                  type: sfCampaign.Type || null,
                  status: sfCampaign.Status || null,
                  start_date: sfCampaign.StartDate || null,
                  end_date: sfCampaign.EndDate || null,
                  client_id: client.id,
                }, { onConflict: 'salesforce_id,client_id' })
                .select()
                .single()

              if (campaignError) continue
              campaignsSynced++

              // Get Campaign Members - ONLY Leads
              const membersQuery = `SELECT Id, LeadId, Status FROM CampaignMember WHERE CampaignId = '${sfCampaign.Id}' AND LeadId != null`
              const membersResult = await conn.query(membersQuery)

              if (membersResult.records.length === 0) continue

              const leadIds = membersResult.records.map(m => m.LeadId)
              const { data: contacts } = await supabase
                .from('contacts')
                .select('id, salesforce_id')
                .eq('client_id', client.id)
                .in('salesforce_id', leadIds)

              const contactMap = new Map(contacts?.map(c => [c.salesforce_id, c.id]) || [])

              const memberSfIds = membersResult.records.map(m => m.Id)
              const { data: existingMembers } = await supabase
                .from('salesforce_campaign_members')
                .select('salesforce_id')
                .eq('client_id', client.id)
                .in('salesforce_id', memberSfIds)

              const existingMemberSet = new Set(existingMembers?.map(m => m.salesforce_id) || [])

              const membersToUpsert = []
              const newMemberContactIds = []

              for (const member of membersResult.records) {
                const contactId = contactMap.get(member.LeadId)
                if (!contactId) continue

                membersToUpsert.push({
                  salesforce_id: member.Id,
                  salesforce_campaign_id: campaign.id,
                  contact_id: contactId,
                  status: member.Status || null,
                  client_id: client.id,
                  synced_at: new Date().toISOString(),
                })

                if (!existingMemberSet.has(member.Id)) {
                  newMemberContactIds.push(contactId)
                }
              }

              if (membersToUpsert.length > 0) {
                await supabase
                  .from('salesforce_campaign_members')
                  .upsert(membersToUpsert, { onConflict: 'salesforce_id,client_id' })
                membersSynced += membersToUpsert.length
              }

              // Auto-enroll new members in matching sequences
              if (newMemberContactIds.length > 0) {
                const { data: sequences } = await supabase
                  .from('email_sequences')
                  .select('*')
                  .eq('client_id', client.id)
                  .eq('status', 'active')
                  .eq('trigger_type', 'salesforce_campaign')
                  .contains('trigger_salesforce_campaign_ids', [campaign.id])

                if (sequences && sequences.length > 0) {
                  for (const sequence of sequences) {
                    const { data: firstStep } = await supabase
                      .from('sequence_steps')
                      .select('*')
                      .eq('sequence_id', sequence.id)
                      .eq('step_order', 1)
                      .single()

                    if (!firstStep) continue

                    const { data: existingEnrollments } = await supabase
                      .from('sequence_enrollments')
                      .select('contact_id')
                      .eq('sequence_id', sequence.id)
                      .in('contact_id', newMemberContactIds)

                    const enrolledSet = new Set(existingEnrollments?.map(e => e.contact_id) || [])
                    const contactsToEnroll = newMemberContactIds.filter(id => !enrolledSet.has(id))

                    if (contactsToEnroll.length === 0) continue

                    const now = new Date().toISOString()
                    const enrollmentsToCreate = contactsToEnroll.map(contactId => ({
                      sequence_id: sequence.id,
                      contact_id: contactId,
                      status: 'active',
                      current_step: 0,
                      trigger_campaign_id: campaign.id,
                      next_email_scheduled_at: now,
                    }))

                    const { data: createdEnrollments } = await supabase
                      .from('sequence_enrollments')
                      .insert(enrollmentsToCreate)
                      .select('id, contact_id')

                    if (createdEnrollments) {
                      const emailsToSchedule = createdEnrollments.map(enrollment => ({
                        enrollment_id: enrollment.id,
                        step_id: firstStep.id,
                        contact_id: enrollment.contact_id,
                        scheduled_for: now,
                        status: 'pending',
                      }))

                      await supabase.from('scheduled_emails').insert(emailsToSchedule)

                      await supabase
                        .from('email_sequences')
                        .update({ total_enrolled: sequence.total_enrolled + createdEnrollments.length })
                        .eq('id', sequence.id)

                      newEnrollments += createdEnrollments.length
                    }
                  }
                }
              }
            }
            console.log(`  ✅ Campaigns: ${campaignsSynced} synced, ${membersSynced} members, ${newEnrollments} new enrollments`)
          } catch (campaignError) {
            console.error(`  ⚠️ Campaign sync error for ${client.name}:`, campaignError.message)
          }

        } catch (clientError) {
          console.error(`  ❌ Error syncing ${client.name}:`, clientError.message)
          await supabase
            .from('clients')
            .update({
              salesforce_sync_status: 'error',
              salesforce_sync_message: clientError.message,
            })
            .eq('id', client.id)
        }
      }

      console.log('✅ Daily Salesforce sync complete')
    } catch (error) {
      console.error('❌ Daily Salesforce sync error:', error.message)
    }
  })

  console.log('✅ Daily Salesforce sync cron job started (runs at 6 AM UTC)')
})

