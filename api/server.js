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
 * Send a test email
 */
app.post('/api/send-test-email', async (req, res) => {
  try {
    const { campaignId, testEmail } = req.body

    console.log('📧 Test email request:', { campaignId, testEmail })

    if (!testEmail) {
      return res.status(400).json({ error: 'Test email address is required' })
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

    console.log('✅ Client found:', client.name)

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

    // Replace merge tags with test data
    const mailingAddress = client.mailing_address || 'No mailing address configured'
    let personalizedHtml = htmlContent
      .replace(/{{email}}/gi, testEmail)
      .replace(/{{first_name}}/gi, 'John')
      .replace(/{{last_name}}/gi, 'Doe')
      .replace(/{{unsubscribe_url}}/gi, testUnsubscribeUrl)
      .replace(/{{mailing_address}}/gi, mailingAddress)

    const msg = {
      to: testEmail,
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

    console.log('📤 Sending test email to:', testEmail)
    await sgMail.send(msg)

    console.log('✅ Test email sent successfully')
    res.json({ success: true, message: `Test email sent to ${testEmail}` })
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

    // 4. Fetch ALL contacts (paginated to handle large lists)
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

    // Filter by tags if specified
    let contacts = allContacts
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
    const mailingAddress = client.mailing_address || 'No mailing address configured'

    const emailPromises = contacts.map((contact) => {
      // Generate unsubscribe URL
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}`

      // Replace merge tags in HTML
      let personalizedHtml = htmlContent
        .replace(/{{email}}/gi, contact.email)
        .replace(/{{first_name}}/gi, contact.first_name || '')
        .replace(/{{last_name}}/gi, contact.last_name || '')
        .replace(/{{unsubscribe_url}}/gi, unsubscribeUrl)
        .replace(/{{mailing_address}}/gi, mailingAddress)

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
          contact:contacts(*)
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

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`)

  // Start cron job to process sequence emails every minute
  cron.schedule('* * * * *', async () => {
    try {
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
      const now = new Date().toISOString()

      // Get pending scheduled emails that are due
      const { data: scheduledEmails, error: fetchError } = await supabase
        .from('scheduled_emails')
        .select(`
          *,
          enrollment:sequence_enrollments(
            *,
            sequence:email_sequences(*),
            contact:contacts(*)
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

  console.log('✅ Sequence processor cron job started (runs every minute)')

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
