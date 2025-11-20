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
      ipPoolName: campaign.ip_pool || undefined,
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

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`)

  // Start cron job to process sequence emails every minute
  cron.schedule('* * * * *', async () => {
    console.log('⏰ Running sequence processor...')
    try {
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
})
