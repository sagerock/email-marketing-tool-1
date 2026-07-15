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
const { computeNextSendTime } = require('./sequence-scheduler')
const { createClient } = require('@supabase/supabase-js')
const jsforce = require('jsforce')
const puppeteer = require('puppeteer')
require('dotenv').config()
const { encrypt: encryptValue, decrypt: decryptValue } = require('./crypto-utils')
const { webhookLimiter, upsertLimiter } = require('./rate-limiters')
const { ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const { s3, BUCKET, publicUrlForKey } = require('./s3-client')
const { filenameFromUrl, scanClientHtml } = require('./media-scan')

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY

function decryptClient(client) {
  if (!client) return client
  if (!ENCRYPTION_KEY) {
    console.error('⚠️  ENCRYPTION_KEY not set - credentials will not be decrypted')
    return client
  }
  const FIELDS = ['sendgrid_api_key', 'salesforce_client_id', 'salesforce_client_secret',
                  'woocommerce_consumer_key', 'woocommerce_consumer_secret']
  const result = { ...client }
  for (const field of FIELDS) {
    if (result[field]) {
      try {
        result[field] = decryptValue(result[field], ENCRYPTION_KEY)
      } catch (e) {
        console.error(`⚠️  Failed to decrypt ${field} for client ${client.id}: ${e.message}`)
      }
    }
  }
  return result
}

// Per-client SendGrid category, e.g. `client-cfa`. Lets us pull one client's
// open/click rate in a single /v3/categories/stats call instead of summing
// per-campaign categories. Prefers the human-readable s3_prefix slug; falls
// back to the client UUID when no slug is set so every send is still tagged.
function clientCategory(client) {
  if (!client) return null
  const slug = client.s3_prefix || client.id
  return slug ? `client-${slug}` : null
}

// Run a PostgREST `.in(column, ids)` query in bounded chunks and concatenate
// the rows. A long id list goes into the request URL as `id=in.(...)`, and at
// ~36 chars per UUID a few hundred ids blow past undici's 16 KB max header size
// (UND_ERR_HEADERS_OVERFLOW). `runBatch(idsChunk)` must return a Supabase query
// promise. Mirrors the `{ data, error }` shape and stops on the first error.
async function inChunks(ids, chunkSize, runBatch) {
  const out = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await runBatch(ids.slice(i, i + chunkSize))
    if (error) return { data: null, error }
    if (data) out.push(...data)
  }
  return { data: out, error: null }
}

// Retry helper for transient network errors (e.g. TLS connection resets)
async function withRetry(fn, { retries = 3, delay = 1000, label = 'operation' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isTransient = err.message?.includes('terminated') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('socket hang up') ||
        err.message?.includes('ETIMEDOUT')
      if (!isTransient || attempt === retries) throw err
      console.warn(`⚠️ ${label} failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay * attempt))
    }
  }
}

const app = express()
const PORT = process.env.PORT || 3001

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173', // Local development
      'http://localhost:3000',
      'https://mail.sagerock.com', // Production frontend
      'https://sagerock.com',      // WordPress site (public signup form)
      'https://www.sagerock.com',  // WordPress site (www variant)
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
app.use(express.json({ limit: '5mb' }))

// Retrying fetch for Supabase.
//
// Node's global fetch throws `TypeError: fetch failed` for any low-level
// transport problem and postgrest-js then masks it as a bare error with no
// cause, so we retry genuinely transient connection failures (reset/closed
// socket, DNS blip) before giving up. Deterministic failures — aborts, and
// header/URL overflow (UND_ERR_HEADERS_OVERFLOW) — are NOT retried; retrying
// can't help and only delays the real error. We log the cause + request URL
// length once on give-up, since urlLen is the canary for an overflow regression.
const fetchWithRetry = async (url, options = {}) => {
  const maxAttempts = 4
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, options)
    } catch (err) {
      lastErr = err
      const causeCode = err?.cause?.code || ''
      const haystack = [err?.name, err?.message, causeCode, err?.cause?.message].filter(Boolean).join(' ')
      const isTransient =
        err?.name !== 'AbortError' &&
        !/OVERFLOW/i.test(causeCode) &&
        /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|other side closed|UND_ERR/i.test(haystack)
      if (!isTransient || attempt === maxAttempts) {
        const reqUrl = typeof url === 'string' ? url : (url?.url || '')
        console.error(
          `[supabase-fetch] giving up after ${attempt} attempt(s): ${err?.message}` +
          ` (cause=${causeCode || 'n/a'}, method=${options?.method || 'GET'}, urlLen=${reqUrl.length})`
        )
        break
      }
      await new Promise(r => setTimeout(r, 150 * attempt))
    }
  }
  throw lastErr
}

// Initialize Supabase
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // Use service key for backend
  { global: { fetch: fetchWithRetry } }
)

// ---- Auth Middleware ----

async function authenticateUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Missing authorization token' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' })

    const { data: adminUser } = await supabase
      .from('admin_users')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!adminUser) return res.status(403).json({ error: 'Access denied' })

    req.user = user
    req.adminUser = adminUser
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' })
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.adminUser?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' })
  }
  next()
}

function validateClientAccess(req, res, next) {
  const { role, client_id } = req.adminUser

  // Super admins and admins can access any client
  if (role === 'super_admin' || role === 'admin') return next()

  // Client admins: enforce their assigned client_id
  if (role === 'client_admin') {
    const requestedClientId = req.body?.clientId || req.query?.clientId
    if (requestedClientId && requestedClientId !== client_id) {
      return res.status(403).json({ error: 'Access denied to this client' })
    }
    // Inject assigned client_id so endpoints always have it
    if (!req.body) req.body = {}
    req.body.clientId = client_id
    if (!req.query) req.query = {}
    req.query.clientId = client_id
    return next()
  }

  return res.status(403).json({ error: 'Access denied: unknown role' })
}

// Apply auth middleware to all /api/* routes except webhooks and health
app.use('/api', (req, res, next) => {
  // Skip auth for webhook endpoints (they have their own auth)
  if (req.path.startsWith('/webhook/')) return next()
  // Skip auth for contacts/upsert (uses API key auth)
  if (req.path === '/contacts/upsert') return next()
  // Skip auth for public signup (rate-limited, no sensitive data)
  if (req.path === '/public/signup') return next()
  // Skip auth for AWSNA 2026 booth resource signup (rate-limited, no sensitive data)
  if (req.path === '/public/awsna-signup') return next()
  // Skip auth for ip-pools (public)
  if (req.path.startsWith('/ip-pools')) return next()
  // Skip auth for accept-invite (user doesn't have an account yet)
  if (req.path === '/auth/accept-invite') return next()
  // Skip auth for internal server-to-server calls (cron → generate, reject → regenerate)
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
  if (req.path === '/ai-followup/generate' && isLocalhost) return next()
  if (req.path === '/salesforce/backfill' && isLocalhost) return next()
  if (req.path === '/salesforce/backfill' && req.headers.authorization === `Bearer ${process.env.SUPABASE_SERVICE_KEY}`) return next()

  authenticateUser(req, res, (err) => {
    if (err) return // authenticateUser already sent the response
    validateClientAccess(req, res, next)
  })
})

// ---- Admin User Management Endpoints ----

// Invite a new user (custom token flow — avoids SendGrid click tracking consuming Supabase OTPs)
app.post('/api/admin/invite-user', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const { email, role, clientId } = req.body
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' })
    }
    if (role === 'client_admin' && !clientId) {
      return res.status(400).json({ error: 'clientId is required for client_admin role' })
    }

    const normalizedEmail = email.toLowerCase()

    // Check if already an admin
    const { data: existing } = await supabase
      .from('admin_users')
      .select('id')
      .eq('email', normalizedEmail)
      .single()
    if (existing) {
      return res.status(400).json({ error: 'This email already has admin access' })
    }

    // Check if there's already a pending invite
    const { data: existingInvite } = await supabase
      .from('invite_tokens')
      .select('id')
      .eq('email', normalizedEmail)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .single()
    if (existingInvite) {
      return res.status(400).json({ error: 'A pending invite already exists for this email' })
    }

    // Generate secure invite token
    const crypto = require('crypto')
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    // Store invite token
    const { error: tokenError } = await supabase
      .from('invite_tokens')
      .insert({
        token,
        email: normalizedEmail,
        role,
        client_id: role === 'client_admin' ? clientId : null,
        created_by: req.user.id,
        expires_at: expiresAt.toISOString(),
      })
    if (tokenError) throw tokenError

    // Send invite email via SendGrid
    const apiKey = process.env.CONTACT_SENDGRID_API_KEY
    if (!apiKey) {
      throw new Error('CONTACT_SENDGRID_API_KEY not configured')
    }

    const baseUrl = process.env.BASE_URL || 'https://mail.sagerock.com'
    const inviteUrl = `${baseUrl}/set-password?token=${token}`

    sgMail.setApiKey(apiKey)
    await sgMail.send({
      to: normalizedEmail,
      from: { email: 'sage@sagerock.com', name: 'SageRock Email Marketing' },
      subject: 'You\'ve been invited to SageRock Email Marketing',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #1e293b; margin-bottom: 8px;">You're Invited!</h2>
          <p style="color: #475569; line-height: 1.6;">
            You've been invited to join the SageRock Email Marketing platform. Click the button below to set your password and get started.
          </p>
          <div style="margin: 32px 0;">
            <a href="${inviteUrl}" style="background-color: #f59e0b; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
              Set Your Password
            </a>
          </div>
          <p style="color: #94a3b8; font-size: 13px;">
            This link expires in 7 days. If you didn't expect this invite, you can safely ignore this email.
          </p>
        </div>
      `,
    })

    console.log(`✅ Invited ${normalizedEmail} as ${role}${clientId ? ` for client ${clientId}` : ''}`)
    res.json({ success: true, email: normalizedEmail, role })
  } catch (error) {
    console.error('Error inviting user:', error)
    res.status(500).json({ error: error.message })
  }
})

// Accept an invite — verify token, create auth user + admin record
app.post('/api/auth/accept-invite', async (req, res) => {
  try {
    const { token, password } = req.body
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' })
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    // Look up and validate the token
    const { data: invite, error: lookupError } = await supabase
      .from('invite_tokens')
      .select('*')
      .eq('token', token)
      .single()

    if (lookupError || !invite) {
      return res.status(400).json({ error: 'Invalid invite token' })
    }
    if (invite.accepted_at) {
      return res.status(400).json({ error: 'This invite has already been used' })
    }
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This invite has expired. Please ask your administrator to send a new one.' })
    }

    // Create the Supabase auth user with the password
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: invite.email,
      password,
      email_confirm: true,
    })
    if (authError) throw authError

    // Create admin_users record
    const { error: adminError } = await supabase
      .from('admin_users')
      .insert({
        user_id: authData.user.id,
        email: invite.email,
        role: invite.role,
        client_id: invite.client_id,
        created_by: invite.created_by,
      })
    if (adminError) {
      // Clean up auth user if admin record fails
      await supabase.auth.admin.deleteUser(authData.user.id)
      throw adminError
    }

    // Mark token as accepted
    await supabase
      .from('invite_tokens')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)

    console.log(`✅ ${invite.email} accepted invite as ${invite.role}`)
    res.json({ success: true, email: invite.email })
  } catch (error) {
    console.error('Error accepting invite:', error)
    res.status(500).json({ error: error.message })
  }
})

// List all admin users
app.get('/api/admin/users', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select(`*, clients (name)`)
      .order('created_at', { ascending: false })

    if (error) throw error

    const users = data.map(u => ({
      ...u,
      client_name: u.clients?.name || null,
    }))

    res.json(users)
  } catch (error) {
    console.error('Error fetching admin users:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete an admin user
app.delete('/api/admin/users/:id', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Look up the admin record to get user_id before deleting
    const { data: adminRecord, error: lookupError } = await supabase
      .from('admin_users')
      .select('user_id, email')
      .eq('id', id)
      .single()
    if (lookupError) throw lookupError

    // Delete from admin_users
    const { error } = await supabase.from('admin_users').delete().eq('id', id)
    if (error) throw error

    // Also delete from auth.users so the email can be re-invited
    if (adminRecord?.user_id) {
      const { error: authDeleteError } = await supabase.auth.admin.deleteUser(adminRecord.user_id)
      if (authDeleteError) {
        console.warn(`Admin record deleted but failed to remove auth user for ${adminRecord.email}:`, authDeleteError.message)
      }
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting admin user:', error)
    res.status(500).json({ error: error.message })
  }
})

// Freemail domains whose senders get auto-captured by Email-to-Salesforce style
// mailbox rules. Used by the spam-capture safety net below.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'live.com', 'msn.com', 'ymail.com', 'qq.com', '163.com', 'gmx.com', 'mail.com',
  'protonmail.com', 'proton.me'
])

/**
 * Detects the "spam-captured contact" pattern: a freemail address that Salesforce
 * auto-created from an inbound email sender, with no real data attached.
 *
 * Signature (all must hold):
 *  - record_type 'contact' — the auto-captured junk lands as Contacts; real new
 *    freemail signups arrive as Leads, so this spares genuine inbound leads
 *  - freemail domain
 *  - no source code (current OR history) — real leads/forms carry one
 *  - the name is exactly the email local-part (e.g. aaronbanks@gmail.com -> "Aaron Banks"),
 *    i.e. the name was parsed straight from the address rather than entered by a human
 *
 * This is deliberately tight so it never flags a real person: a genuine gmail
 * contact (john.smith@, jsmith1980@) won't have name === local-part.
 * Background: Alconox's po@alconox.com purchase-order mailbox auto-created ~6,500 of
 * these in April 2026 from a spam wave; this net stops any repeat before it can be mailed.
 */
function isLikelySpamCapturedContact(record) {
  if (!record || !record.email) return false
  if (record.record_type !== 'contact') return false
  const email = String(record.email).toLowerCase().trim()
  const at = email.indexOf('@')
  if (at < 1) return false
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (!FREEMAIL_DOMAINS.has(domain)) return false
  if (record.source_code || record.source_code_history) return false
  const name = `${(record.first_name || '').trim()}${(record.last_name || '').trim()}`.toLowerCase()
  if (!name) return false
  return name === local
}

/**
 * Safety net: after a sync batch is upserted, auto-suppress any records matching the
 * spam-capture pattern so they can never reach a send, even if the upstream Salesforce
 * source is never cleaned. Only flips contacts currently unsubscribed=false (idempotent),
 * and chunks the id filter to keep request URLs small.
 */
async function suppressSpamCapturedContacts(chunk, clientId) {
  const junk = chunk.filter(isLikelySpamCapturedContact)
  if (junk.length === 0) return 0

  const sfIds = [...new Set(junk.map(r => r.salesforce_id).filter(Boolean))]
  const emailsWithoutSfId = [...new Set(
    junk.filter(r => !r.salesforce_id).map(r => String(r.email).toLowerCase().trim()).filter(Boolean)
  )]

  let suppressed = 0
  const ID_CHUNK = 150

  const runUpdate = async (column, values) => {
    for (let i = 0; i < values.length; i += ID_CHUNK) {
      const slice = values.slice(i, i + ID_CHUNK)
      const { data, error } = await supabase
        .from('contacts')
        .update({ unsubscribed: true, updated_at: new Date().toISOString() })
        .eq('client_id', clientId)
        .eq('unsubscribed', false)
        .in(column, slice)
        .select('id')
      if (error) {
        console.error(`Spam-capture auto-suppress failed (${column}, ${slice.length}): ${error.message}`)
        continue
      }
      suppressed += data ? data.length : 0
    }
  }

  if (sfIds.length) await runUpdate('salesforce_id', sfIds)
  if (emailsWithoutSfId.length) await runUpdate('email', emailsWithoutSfId)

  if (suppressed > 0) {
    console.log(`🛡️  Auto-suppressed ${suppressed} likely spam-captured freemail contact(s) during sync (Email-to-Salesforce junk pattern)`)
  }
  return suppressed
}

/**
 * Upsert a batch of contact records with individual retry fallback, then run the
 * spam-capture safety net over the same batch.
 */
async function upsertContactBatch(chunk, clientId) {
  const result = await upsertContactBatchRaw(chunk, clientId)
  try {
    await suppressSpamCapturedContacts(chunk, clientId)
  } catch (err) {
    console.error(`Spam-capture auto-suppress error: ${err.message}`)
  }
  return result
}

/**
 * Upsert a batch of contact records with individual retry fallback.
 * First tries batch upsert by salesforce_id. If that fails, retries each record
 * individually so a single bad record doesn't silently drop the entire batch.
 */
async function upsertContactBatchRaw(chunk, clientId) {
  const { error: batchError } = await supabase
    .from('contacts')
    .upsert(chunk, { onConflict: 'salesforce_id', ignoreDuplicates: false })

  if (!batchError) return { succeeded: chunk.length, failed: 0 }

  console.warn(`Batch upsert by salesforce_id failed (${chunk.length} records): ${batchError.message}. Retrying individually...`)

  let succeeded = 0
  let failed = 0

  for (const record of chunk) {
    // Try by salesforce_id first
    const { error: sfError } = await supabase
      .from('contacts')
      .upsert(record, { onConflict: 'salesforce_id', ignoreDuplicates: false })

    if (!sfError) {
      succeeded++
      continue
    }

    // Fall back to email,client_id
    const { error: emailError } = await supabase
      .from('contacts')
      .upsert(record, { onConflict: 'email,client_id', ignoreDuplicates: false })

    if (!emailError) {
      succeeded++
    } else {
      failed++
      console.error(`Failed to upsert contact ${record.email} (sf_id: ${record.salesforce_id}): ${emailError.message}`)
    }
  }

  console.log(`Individual retry results: ${succeeded} succeeded, ${failed} failed`)
  return { succeeded, failed }
}

/**
 * Add source code tags to contacts during Salesforce sync.
 * Groups records by source_code and source_code_history, prefixes with LSC: (leads) or CSC: (contacts),
 * appends the tag to each contact's tags array, and upserts the tag to the tags table.
 */
async function addSourceCodeTags(batchRecords, clientId, recordType) {
  try {
    const suffix = recordType === 'lead' ? ':LSC' : ':CSC'
    // Group emails by source_code value (current + history)
    const sourceCodeMap = {}
    for (const record of batchRecords) {
      if (!record.email) continue

      // Collect all source codes: current + history entries
      const codes = new Set()
      if (record.source_code) codes.add(record.source_code)
      if (record.source_code_history) {
        for (const line of record.source_code_history.split('\n')) {
          const code = line.split(' @ ')[0].trim()
          if (code) codes.add(code)
        }
      }

      for (const code of codes) {
        const tag = code + suffix
        if (!sourceCodeMap[tag]) sourceCodeMap[tag] = []
        sourceCodeMap[tag].push(record.email)
      }
    }

    for (const [tagName, emails] of Object.entries(sourceCodeMap)) {
      // Append tag to contacts that don't already have it
      const { data: affected, error: rpcError } = await supabase.rpc('append_tag_to_contacts', {
        p_client_id: clientId,
        p_tag_name: tagName,
        p_emails: emails,
      })

      if (rpcError) {
        console.error(`Error appending tag "${tagName}":`, rpcError.message)
        continue
      }

      // Upsert tag to tags table with accurate contact_count
      const { count } = await supabase
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .filter('tags', 'cs', `{"${tagName}"}`)

      await supabase
        .from('tags')
        .upsert(
          { name: tagName, client_id: clientId, contact_count: count ?? 0 },
          { onConflict: 'name,client_id' }
        )

      console.log(`🏷️  Tag "${tagName}": ${affected ?? 0} contacts updated, ${count ?? 0} total`)
    }
  } catch (err) {
    console.error('Error adding source code tags:', err.message)
    // Don't throw - tag failures should not break the sync
  }
}

/**
 * Add a "Campaign: <name>" tag to contacts during Salesforce Campaign sync.
 * Uses the same append_tag_to_contacts RPC as addSourceCodeTags.
 */
async function addCampaignTag(campaignName, emails, clientId) {
  try {
    if (!emails || emails.length === 0) return

    const tagName = `Campaign: ${campaignName}`

    const { data: affected, error: rpcError } = await supabase.rpc('append_tag_to_contacts', {
      p_client_id: clientId,
      p_tag_name: tagName,
      p_emails: emails,
    })

    if (rpcError) {
      console.error(`Error appending tag "${tagName}":`, rpcError.message)
      return
    }

    // Upsert tag to tags table with accurate contact_count
    const { count } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .filter('tags', 'cs', `{"${tagName}"}`)

    await supabase
      .from('tags')
      .upsert(
        { name: tagName, client_id: clientId, contact_count: count ?? 0 },
        { onConflict: 'name,client_id' }
      )

    console.log(`🏷️  Tag "${tagName}": ${affected ?? 0} contacts updated, ${count ?? 0} total`)
  } catch (err) {
    console.error(`Error adding campaign tag for "${campaignName}":`, err.message)
    // Don't throw - tag failures should not break the sync
  }
}

/**
 * Bot Click Detection
 * Tracks recent clicks to detect security scanner bots.
 * Rule: 3+ unique URLs clicked within 10 seconds = bot
 */
const clickTracker = new Map() // Key: "campaignId:email", Value: [{ url, timestamp }]
const knownBots = new Set() // Key: "campaignId:email" - emails already flagged as bots

// Clean up old click tracking data every 30 seconds
setInterval(() => {
  const now = Date.now()
  const TTL = 60000 // 60 seconds - keep data a bit longer than detection window

  for (const [key, clicks] of clickTracker.entries()) {
    // Remove clicks older than TTL
    const recentClicks = clicks.filter(c => now - c.timestamp < TTL)
    if (recentClicks.length === 0) {
      clickTracker.delete(key)
    } else {
      clickTracker.set(key, recentClicks)
    }
  }

  // Clean up known bots after 5 minutes (they won't click again anyway)
  // This is handled separately to avoid memory growth
}, 30000)

// Clean up known bots every 5 minutes
setInterval(() => {
  knownBots.clear()
}, 300000)

/**
 * Check if a click is from a bot based on click patterns.
 * Returns true if this click should be filtered out.
 */
function isClickFromBot(campaignId, email, url, timestampMs) {
  const key = `${campaignId}:${email}`

  // Already flagged as bot - skip all their clicks
  if (knownBots.has(key)) {
    return true
  }

  // Get or create click history
  let clicks = clickTracker.get(key) || []

  // Add current click
  clicks.push({ url, timestamp: timestampMs })
  clickTracker.set(key, clicks)

  // Check for bot pattern: 3+ unique URLs within 10 seconds
  const tenSecondsAgo = timestampMs - 10000
  const recentClicks = clicks.filter(c => c.timestamp >= tenSecondsAgo)
  const uniqueUrls = new Set(recentClicks.map(c => c.url))

  if (uniqueUrls.size >= 3) {
    // This is a bot - flag for future clicks
    knownBots.add(key)
    console.log(`Bot detected: ${email} clicked ${uniqueUrls.size} unique URLs in 10s for campaign ${campaignId}`)
    return true
  }

  return false
}

/**
 * Helper function to send a campaign by ID
 * Used by both the API endpoint and the scheduled campaign cron job
 *
 * Designed for large sends (47K+ contacts):
 * - Uses SendGrid personalizations API (up to 1000 recipients per API call)
 * - Processes contacts in pages to limit memory usage
 * - Tracks progress via sent_count/failed_count columns for live UI updates
 * - Creates a dedicated SendGrid client instance to avoid API key conflicts
 */
async function sendCampaignById(campaignId) {
  // 1. Fetch campaign
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single()

  if (campaignError) throw campaignError

  // Guard against double-sending with atomic status update
  // Only proceed if status is 'draft' or 'scheduled'
  if (campaign.status === 'sending') {
    throw new Error('Campaign is already being sent')
  }
  if (campaign.status === 'sent') {
    throw new Error('Campaign has already been sent')
  }

  // Atomically claim the campaign by setting status to 'sending'
  // This prevents race conditions if send is triggered twice
  const { data: claimResult, error: claimError } = await supabase
    .from('campaigns')
    .update({ status: 'sending', sent_count: 0, failed_count: 0, send_error: null })
    .eq('id', campaignId)
    .in('status', ['draft', 'scheduled'])
    .select('id')

  if (claimError) throw claimError
  if (!claimResult || claimResult.length === 0) {
    throw new Error('Campaign is already being sent or has been sent')
  }

  // 2. Fetch client to get API key
  const { data: clientRaw, error: clientError } = await withRetry(
    () => supabase.from('clients').select('*').eq('id', campaign.client_id).single(),
    { label: 'Fetch client' }
  )

  if (clientError) throw clientError

  const client = decryptClient(clientRaw)
  console.log('📧 Sending campaign for client:', client.name, '| IP Pool:', client.ip_pool || '(none)')

  // Create a dedicated SendGrid client instance for this send
  // (avoids API key conflicts if multiple campaigns send concurrently)
  const SendGridClient = sgClient.constructor
  const campaignSgClient = new SendGridClient()
  campaignSgClient.setApiKey(client.sendgrid_api_key)

  // 3. Fetch template if specified
  let htmlContent = ''
  if (campaign.template_id) {
    const { data: template } = await withRetry(
      () => supabase.from('templates').select('html_content').eq('id', campaign.template_id).single(),
      { label: 'Fetch template' }
    )

    htmlContent = template?.html_content || ''
  }

  // 4. Get contact IDs from Salesforce Campaign if specified
  let sfCampaignContactIds = null
  if (campaign.salesforce_campaign_id) {
    const { data: members, error: membersError } = await withRetry(
      () => supabase.from('salesforce_campaign_members').select('contact_id')
        .eq('salesforce_campaign_id', campaign.salesforce_campaign_id)
        .eq('client_id', campaign.client_id),
      { label: 'Fetch SF campaign members' }
    )

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

  // 4a. Purchase filter setup (WooCommerce-derived). Spend/orders/recency are
  // applied as contact-column predicates in the page query; product purchase is
  // resolved here into an email set and applied in-memory (like the SF filter).
  const purchaseFilter = campaign.purchase_filter || null
  let purchaseRecencyCutoff = null
  if (purchaseFilter?.recency_mode && purchaseFilter.recency_mode !== 'any' && purchaseFilter.recency_days) {
    purchaseRecencyCutoff = new Date(Date.now() - Number(purchaseFilter.recency_days) * 86400000).toISOString()
  }
  let productBuyerEmails = null   // Set<lowercased email> when product filter active
  let productMode = null          // 'purchased' | 'not_purchased'
  if (purchaseFilter?.product_mode && purchaseFilter.product_mode !== 'any'
      && Array.isArray(purchaseFilter.product_skus) && purchaseFilter.product_skus.length > 0) {
    productMode = purchaseFilter.product_mode
    productBuyerEmails = await getProductBuyerEmailSet(campaign.client_id, purchaseFilter.product_skus)
    console.log(`📧 Product filter (${productMode}): ${productBuyerEmails.size} buyer email(s) across ${purchaseFilter.product_skus.length} SKU(s)`)
    // "purchased" with no buyers means nobody qualifies — finish empty.
    if (productMode === 'purchased' && productBuyerEmails.size === 0) {
      await supabase
        .from('campaigns')
        .update({ status: 'sent', sent_at: new Date().toISOString(), recipient_count: 0 })
        .eq('id', campaignId)
      return { sent: 0, failed: 0 }
    }
  }

  // 4b. Count contacts excluded by each filter for the send breakdown
  const breakdown = { total_contacts: 0, excluded_unsubscribed: 0, excluded_hard_bounced: 0, final_recipients: 0 }

  // Total contacts for this client
  const { count: totalCount } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', campaign.client_id)
  breakdown.total_contacts = totalCount || 0

  // Unsubscribed contacts
  const { count: unsubCount } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', campaign.client_id)
    .eq('unsubscribed', true)
  breakdown.excluded_unsubscribed = unsubCount || 0

  // Hard bounced contacts
  const { count: bounceCount } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', campaign.client_id)
    .eq('bounce_status', 'hard')
  breakdown.excluded_hard_bounced = bounceCount || 0

  // SF campaign filter exclusions (contacts not in the SF campaign)
  if (sfCampaignContactIds) {
    const eligibleAfterBounceUnsub = breakdown.total_contacts - breakdown.excluded_unsubscribed - breakdown.excluded_hard_bounced
    breakdown.excluded_sf_campaign_filter = eligibleAfterBounceUnsub - sfCampaignContactIds.size
  }

  // Audience filter exclusions (contacts not in any selected segment)
  if (Array.isArray(campaign.audience_filter) && campaign.audience_filter.length > 0 && campaign.audience_filter.length < 3) {
    const orClauses = []
    if (campaign.audience_filter.includes('lead')) orClauses.push('record_type.eq.lead')
    if (campaign.audience_filter.includes('customer')) orClauses.push('and(record_type.eq.contact,contact_type.eq.Customer,or(account_type.is.null,account_type.neq.Dealer))')
    if (campaign.audience_filter.includes('dealer')) orClauses.push('and(record_type.eq.contact,or(account_type.eq.Dealer,contact_type.eq.Dealer))')
    if (orClauses.length > 0) {
      const { count: audienceCount } = await supabase.from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', campaign.client_id)
        .eq('unsubscribed', false)
        .neq('bounce_status', 'hard')
        .or(orClauses.join(','))
      const eligibleAfterBounceUnsub = breakdown.total_contacts - breakdown.excluded_unsubscribed - breakdown.excluded_hard_bounced
      breakdown.excluded_audience_filter = eligibleAfterBounceUnsub - (audienceCount || 0)
    }
  }

  // Tag filter - we'll calculate after the send loop since it's interleaved with pagination

  console.log(`📧 Send breakdown: ${JSON.stringify(breakdown)}`)

  // 5. Prepare template and shared data before fetching contacts
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
    return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
      if (url.includes('unsubscribe')) return match
      const separator = url.includes('?') ? '&' : '?'
      return `href="${url}${separator}${params}"`
    })
  }

  // Helper to append UTM to a single URL string
  const appendUtmToUrl = (url, params) => {
    if (!params || !url) return url
    if (url.includes('unsubscribe')) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}${params}`
  }

  // Pre-process the shared HTML template:
  // 1. Replace merge tags that are the same for all contacts
  let processedTemplate = htmlContent
    .replace(/{{mailing_address}}/gi, mailingAddress)
    .replace(/{{campaign_name}}/gi, sfCampaignName)

  // 2. Apply UTM params to all static URLs in the template
  //    (merge tag placeholders like {{unsubscribe_url}} are not real URLs so they're skipped)
  processedTemplate = appendUtmParams(processedTemplate, utmParams)

  // 6. Fetch contacts in pages, filter, and send — without accumulating all in memory
  const PERSONALIZATIONS_BATCH_SIZE = 1000 // SendGrid max per API call
  const PAGE_SIZE = 1000
  let sentCount = 0
  let failedCount = 0
  let failedRecipients = [] // Email addresses from failed batches
  let totalRecipients = 0
  let page = 0
  let pendingPersonalizations = [] // Buffer for building up to PERSONALIZATIONS_BATCH_SIZE

  // Helper: flush a batch of personalizations to SendGrid
  const flushBatch = async (personalizations, batchLabel) => {
    const requestBody = {
      personalizations,
      from: { email: campaign.from_email, name: campaign.from_name },
      subject: campaign.subject,
      content: [{ type: 'text/html', value: processedTemplate }],
      categories: [`campaign-${campaignId}`, clientCategory(client)].filter(Boolean),
      custom_args: { campaign_id: campaignId },
    }
    if (campaign.reply_to) requestBody.reply_to = { email: campaign.reply_to }
    if (client.ip_pool) requestBody.ip_pool_name = client.ip_pool

    try {
      // No retry on sends — retrying risks duplicate emails if SendGrid
      // processed the request but the response was lost (e.g. connection reset).
      // Failed batches are counted and can be investigated after.
      await campaignSgClient.request({ method: 'POST', url: '/v3/mail/send', body: requestBody })
      sentCount += personalizations.length
      console.log(`📧 ${batchLabel}: sent ${personalizations.length} emails`)
    } catch (err) {
      failedCount += personalizations.length
      const batchEmails = personalizations.map(p => p.to[0].email)
      failedRecipients = failedRecipients.concat(batchEmails)
      console.error(`📧 ${batchLabel} FAILED (${personalizations.length} emails):`, err.message || err)
    }

    // Update progress in DB after each batch
    await supabase.from('campaigns').update({
      sent_count: sentCount,
      failed_count: failedCount,
      failed_recipients: failedRecipients,
    }).eq('id', campaignId)
  }

  console.log(`📧 Starting paginated send with ${PERSONALIZATIONS_BATCH_SIZE}-recipient batches`)

  // Audience filter: subset of ['lead', 'customer', 'dealer']. Empty/null = all.
  const audienceFilter = Array.isArray(campaign.audience_filter) ? campaign.audience_filter : []
  const audienceActive = audienceFilter.length > 0 && audienceFilter.length < 3

  while (true) {
    let baseQuery = supabase.from('contacts')
      .select('id, email, first_name, last_name, unsubscribe_token, industry, tags, bounce_status')
      .eq('unsubscribed', false)
      .eq('client_id', campaign.client_id)
      .neq('bounce_status', 'hard')

    // Purchase filter: spend / order-count / recency predicates (null total_spent
    // and last_order_date — i.e. non-buyers — are excluded by these comparisons).
    if (purchaseFilter) {
      if (purchaseFilter.min_spend != null && purchaseFilter.min_spend !== '') {
        baseQuery = baseQuery.gte('total_spent', purchaseFilter.min_spend)
      }
      if (purchaseFilter.min_orders != null && purchaseFilter.min_orders !== '') {
        baseQuery = baseQuery.gte('order_count', purchaseFilter.min_orders)
      }
      if (purchaseRecencyCutoff) {
        if (purchaseFilter.recency_mode === 'within') baseQuery = baseQuery.gte('last_order_date', purchaseRecencyCutoff)
        else if (purchaseFilter.recency_mode === 'lapsed') baseQuery = baseQuery.lt('last_order_date', purchaseRecencyCutoff)
      }
    }

    if (audienceActive) {
      const orClauses = []
      if (audienceFilter.includes('lead')) orClauses.push('record_type.eq.lead')
      if (audienceFilter.includes('customer')) orClauses.push('and(record_type.eq.contact,contact_type.eq.Customer,or(account_type.is.null,account_type.neq.Dealer))')
      if (audienceFilter.includes('dealer')) orClauses.push('and(record_type.eq.contact,or(account_type.eq.Dealer,contact_type.eq.Dealer))')
      if (orClauses.length > 0) baseQuery = baseQuery.or(orClauses.join(','))
    }

    const { data: pageContacts, error } = await withRetry(
      () => baseQuery.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
      { label: `Fetch contacts page ${page + 1}` }
    )

    if (error) throw error
    if (!pageContacts || pageContacts.length === 0) break

    // Filter this page
    let filtered = pageContacts
    if (sfCampaignContactIds) {
      filtered = filtered.filter(c => sfCampaignContactIds.has(c.id))
    }
    if (campaign.filter_tags && campaign.filter_tags.length > 0) {
      const beforeTagFilter = filtered.length
      filtered = filtered.filter(c =>
        campaign.filter_tags.some(tag => c.tags?.includes(tag))
      )
      breakdown.excluded_tag_filter = (breakdown.excluded_tag_filter || 0) + (beforeTagFilter - filtered.length)
    }
    // Product purchase filter (AND logic): keep buyers / non-buyers of the SKUs.
    if (productBuyerEmails) {
      const beforeProductFilter = filtered.length
      filtered = productMode === 'purchased'
        ? filtered.filter(c => c.email && productBuyerEmails.has(c.email.toLowerCase()))
        : filtered.filter(c => !c.email || !productBuyerEmails.has(c.email.toLowerCase()))
      breakdown.excluded_product_filter = (breakdown.excluded_product_filter || 0) + (beforeProductFilter - filtered.length)
    }

    totalRecipients += filtered.length

    // Build personalizations for each contact
    for (const contact of filtered) {
      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}&campaign_id=${campaignId}`
      const rawIndustryLink = contact.industry
        ? (industryLinkMap.get(contact.industry) || defaultIndustryUrl)
        : defaultIndustryUrl
      const industryLink = appendUtmToUrl(rawIndustryLink, utmParams)

      pendingPersonalizations.push({
        to: [{ email: contact.email }],
        substitutions: {
          '{{email}}': contact.email,
          '{{first_name}}': contact.first_name || '',
          '{{last_name}}': contact.last_name || '',
          '{{unsubscribe_url}}': unsubscribeUrl,
          '{{industry_link}}': industryLink,
        },
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      })

      // Flush when we hit the batch size
      if (pendingPersonalizations.length >= PERSONALIZATIONS_BATCH_SIZE) {
        const batchNum = Math.floor((sentCount + failedCount) / PERSONALIZATIONS_BATCH_SIZE) + 1
        await flushBatch(pendingPersonalizations, `Batch ${batchNum}`)
        pendingPersonalizations = []
      }
    }

    page++
    if (pageContacts.length < PAGE_SIZE) break
  }

  // Flush any remaining personalizations
  if (pendingPersonalizations.length > 0) {
    const batchNum = Math.floor((sentCount + failedCount) / PERSONALIZATIONS_BATCH_SIZE) + 1
    await flushBatch(pendingPersonalizations, `Batch ${batchNum} (final)`)
    pendingPersonalizations = []
  }

  // Finalize breakdown
  breakdown.final_recipients = totalRecipients
  console.log(`📧 Campaign send complete: ${sentCount} sent, ${failedCount} failed out of ${totalRecipients} recipients`)
  console.log(`📧 Send breakdown: ${JSON.stringify(breakdown)}`)

  // 7. Update campaign to sent with final counts
  await supabase
    .from('campaigns')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      recipient_count: totalRecipients,
      sent_count: sentCount,
      failed_count: failedCount,
      failed_recipients: failedRecipients,
      send_breakdown: breakdown,
    })
    .eq('id', campaignId)

  return { success: true, sent: sentCount, failed: failedCount }
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
    const { data: clientRaw, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', campaign.client_id)
      .single()

    if (clientError) {
      console.error('❌ Client fetch error:', clientError)
      throw new Error(`Client not found: ${clientError.message}`)
    }

    const client = decryptClient(clientRaw)
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
        .replace(/{{campaign_name}}/gi, campaign.name || '')
        .replace(/{{industry_link}}/gi, 'https://alconox.com/industries/')

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
        customArgs: {
          campaign_id: campaignId,
        },
        categories: [`campaign-${campaignId}`, clientCategory(client)].filter(Boolean),
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
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required' })

    // Validate campaign exists and is sendable
    const { data: campaign, error } = await supabase
      .from('campaigns').select('id, status').eq('id', campaignId).single()
    if (error || !campaign) return res.status(404).json({ error: 'Campaign not found' })
    if (campaign.status === 'sending') return res.status(409).json({ error: 'Campaign is already sending' })
    if (campaign.status === 'sent') return res.status(409).json({ error: 'Campaign has already been sent' })

    // Return 202 immediately — send runs in the background
    res.status(202).json({ message: 'Campaign send started', campaignId })

    // Fire-and-forget: run send in background
    sendCampaignById(campaignId).catch(async (err) => {
      console.error(`Background campaign send failed for ${campaignId}:`, err)
      await supabase.from('campaigns')
        .update({ status: 'failed', send_error: err.message })
        .eq('id', campaignId)
    })
  } catch (error) {
    console.error('Error initiating campaign send:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: error.message })
    }
  }
})

/**
 * Campaign progress endpoint for polling during large sends
 */
app.get('/api/campaign-progress/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, status, recipient_count, sent_count, failed_count, send_error, failed_recipients')
      .eq('id', req.params.id)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Campaign not found' })
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * SendGrid webhook endpoint for event tracking
 * Configure this URL in SendGrid: https://your-domain.com/api/webhook/sendgrid
 */
app.post('/api/webhook/sendgrid', webhookLimiter, async (req, res) => {
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

    // Cache campaign lookups to avoid repeated queries
    const campaignCache = new Map()

    // Process each event
    // Event type mapping (shared by campaign and AI followup handlers)
    const eventTypeMap = {
      delivered: 'delivered',
      open: 'open',
      click: 'click',
      bounce: 'bounce',
      dropped: 'bounce',
      blocked: 'block',
      spamreport: 'spam',
      unsubscribe: 'unsubscribe',
    }

    for (const event of events) {
      // ---- AI Follow-up email events ----
      const aiDraftId = event.custom_args?.ai_followup_draft_id
      if (aiDraftId) {
        const eventType = eventTypeMap[event.event]
        if (!eventType) { skipped++; continue }

        // Bot detection for clicks
        if (eventType === 'click' && event.email && event.url) {
          const clickTimestamp = event.timestamp * 1000
          if (isClickFromBot(aiDraftId, event.email, event.url, clickTimestamp)) {
            skipped++; continue
          }
          // Click-to-open ratio check
          const { data: emailStats } = await supabase
            .from('ai_followup_analytics')
            .select('event_type')
            .eq('draft_id', aiDraftId)
            .eq('email', event.email)
            .in('event_type', ['open', 'click'])
          if (emailStats) {
            const opens = emailStats.filter(e => e.event_type === 'open').length
            const clicks = emailStats.filter(e => e.event_type === 'click').length
            if (opens === 0) { skipped++; continue }
            if (clicks >= opens * 10) { skipped++; continue }
          }
        }

        // Insert into ai_followup_analytics
        const { error: aiInsertError } = await supabase.from('ai_followup_analytics').insert({
          draft_id: aiDraftId,
          email: event.email,
          event_type: eventType,
          timestamp: new Date(event.timestamp * 1000).toISOString(),
          url: event.url || null,
          user_agent: event.useragent || null,
          ip_address: event.ip || null,
          sg_event_id: event.sg_event_id,
        })

        if (aiInsertError && !aiInsertError.message?.includes('duplicate key')) {
          errors++
        } else {
          processed++
        }

        // Handle unsubscribe/bounce for AI emails
        if ((eventType === 'unsubscribe' || eventType === 'bounce') && event.email) {
          const { data: draft } = await supabase.from('ai_followup_drafts').select('client_id').eq('id', aiDraftId).single()
          if (draft) {
            if (eventType === 'unsubscribe') {
              await supabase.from('contacts').update({
                unsubscribed: true,
                unsubscribed_at: new Date(event.timestamp * 1000).toISOString(),
              }).eq('email', event.email).eq('client_id', draft.client_id)
            }
            if (eventType === 'bounce') {
              const isHardBounce = ['invalid', 'bounce', 'blocked'].includes(event.type) ||
                event.reason?.toLowerCase().includes('invalid') ||
                event.reason?.toLowerCase().includes('does not exist')
              await supabase.from('contacts').update({
                bounce_status: isHardBounce ? 'hard' : 'soft',
                bounced_at: new Date(event.timestamp * 1000).toISOString(),
              }).eq('email', event.email).eq('client_id', draft.client_id)
            }
          }
        }

        continue // Skip campaign processing
      }

      // ---- Regular campaign events ----
      // Extract campaign_id from custom args
      const campaignId = event.campaign_id || event.custom_args?.campaign_id

      if (!campaignId) {
        // Not a campaign or AI event — skip silently
        skipped++
        continue
      }

      // Get client_id from campaign (with caching)
      let clientId = campaignCache.get(campaignId)
      if (!clientId) {
        const { data: campaign } = await supabase
          .from('campaigns')
          .select('client_id')
          .eq('id', campaignId)
          .single()

        if (campaign?.client_id) {
          clientId = campaign.client_id
          campaignCache.set(campaignId, clientId)
        }
      }

      const eventType = eventTypeMap[event.event]
      if (!eventType) {
        console.log(`SendGrid webhook: Skipping unmapped event type: ${event.event}`)
        skipped++
        continue
      }

      // Bot detection for click events - filter before storing
      if (eventType === 'click' && event.email && event.url) {
        const clickTimestamp = event.timestamp * 1000 // Convert to milliseconds
        if (isClickFromBot(campaignId, event.email, event.url, clickTimestamp)) {
          skipped++
          continue
        }

        // Check click-to-open ratio - bots click without opening or have very high ratios
        // Only check within the current campaign to avoid filtering first-time clickers
        const { data: emailStats } = await supabase
          .from('analytics_events')
          .select('event_type')
          .eq('campaign_id', campaignId)
          .eq('email', event.email)
          .in('event_type', ['open', 'click'])

        if (emailStats) {
          const opens = emailStats.filter(e => e.event_type === 'open').length
          const clicks = emailStats.filter(e => e.event_type === 'click').length

          // No opens = bot (can't click without opening)
          if (opens === 0) {
            console.log(`Bot detected: ${event.email} clicked without any opens`)
            skipped++
            continue
          }

          // High ratio = bot (more than 10 clicks per open)
          if (clicks >= opens * 10) {
            console.log(`Bot detected: ${event.email} has ${clicks} clicks vs ${opens} opens (ratio ${(clicks/opens).toFixed(1)}:1)`)
            skipped++
            continue
          }
        }
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
      if (eventType === 'unsubscribe' && event.email && clientId) {
        await supabase
          .from('contacts')
          .update({
            unsubscribed: true,
            unsubscribed_at: new Date(event.timestamp * 1000).toISOString(),
          })
          .eq('email', event.email)
          .eq('client_id', clientId)
      }

      // If bounce event, flag contact as bounced
      if (eventType === 'bounce' && event.email && clientId) {
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
          .eq('client_id', clientId)

        console.log(`Bounce recorded for ${event.email}: ${isHardBounce ? 'hard' : 'soft'} bounce`)
      }

      // If open or click event, update engagement metrics
      if ((eventType === 'open' || eventType === 'click') && event.email && clientId) {
        const eventTimestamp = new Date(event.timestamp * 1000).toISOString()

        // Fetch current engagement values
        const { data: contact } = await supabase
          .from('contacts')
          .select('total_opens, total_clicks, engagement_score')
          .eq('email', event.email)
          .eq('client_id', clientId)
          .single()

        if (contact) {
          // Bot clicks are already filtered at ingestion, so all clicks here are human
          // Just increment engagement score for opens and clicks
          const newOpens = (contact.total_opens || 0) + (eventType === 'open' ? 1 : 0)
          const newClicks = (contact.total_clicks || 0) + (eventType === 'click' ? 1 : 0)
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
            .eq('client_id', clientId)
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
    const { data: clientRaw } = await supabase
      .from('clients')
      .select('sendgrid_api_key')
      .eq('id', clientId)
      .single()

    if (!clientRaw) {
      return res.status(404).json({ error: 'Client not found' })
    }

    const client = decryptClient(clientRaw)
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

    if (campaign.client) campaign.client = decryptClient(campaign.client)

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
 * Get campaign stats from SendGrid Category Stats API
 * Returns authoritative stats directly from SendGrid
 */
app.get('/api/campaigns/:id/sendgrid-stats', async (req, res) => {
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

    if (campaign.client) campaign.client = decryptClient(campaign.client)

    if (!campaign.client?.sendgrid_api_key) {
      return res.status(400).json({ error: 'No SendGrid API key configured for this client' })
    }

    if (!campaign.sent_at) {
      return res.status(400).json({ error: 'Campaign has not been sent yet' })
    }

    // 2. Calculate date range for stats
    const sentDate = new Date(campaign.sent_at)
    const startDate = sentDate.toISOString().split('T')[0] // YYYY-MM-DD format
    const endDate = new Date().toISOString().split('T')[0] // Today

    // 3. Fetch category stats from SendGrid
    const categoryName = `campaign-${campaignId}`
    const url = new URL(`https://api.sendgrid.com/v3/categories/stats`)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date', endDate)
    url.searchParams.set('categories', categoryName)
    url.searchParams.set('aggregated_by', 'day')

    console.log(`📊 Fetching SendGrid stats for campaign: ${campaign.name}`)
    console.log(`   Category: ${categoryName}`)
    console.log(`   Date range: ${startDate} to ${endDate}`)

    const fetchResponse = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${campaign.client.sendgrid_api_key}`,
      },
    })

    const response = await fetchResponse.json()

    if (!fetchResponse.ok) {
      const errorMessage = response.errors?.[0]?.message || 'SendGrid Stats API error'

      // Handle "category does not exist" - this is expected for campaigns sent before tracking was added
      if (errorMessage.includes('category does not exist')) {
        console.log(`   Category not found - campaign was sent before category tracking was enabled`)
        return res.status(404).json({
          error: 'Category stats not available - campaign was sent before SendGrid category tracking was enabled',
          reason: 'category_not_found'
        })
      }

      console.error('SendGrid Stats API error:', response)
      return res.status(fetchResponse.status).json({ error: errorMessage })
    }

    // 4. Aggregate stats across all days
    const aggregatedStats = {
      requests: 0,
      delivered: 0,
      opens: 0,
      unique_opens: 0,
      clicks: 0,
      unique_clicks: 0,
      bounces: 0,
      bounce_drops: 0,
      blocks: 0,
      spam_reports: 0,
      spam_report_drops: 0,
      unsubscribes: 0,
      unsubscribe_drops: 0,
      invalid_emails: 0,
      deferred: 0,
    }

    for (const day of response) {
      for (const stat of day.stats || []) {
        const m = stat.metrics || {}
        aggregatedStats.requests += m.requests || 0
        aggregatedStats.delivered += m.delivered || 0
        aggregatedStats.opens += m.opens || 0
        aggregatedStats.unique_opens += m.unique_opens || 0
        aggregatedStats.clicks += m.clicks || 0
        aggregatedStats.unique_clicks += m.unique_clicks || 0
        aggregatedStats.bounces += m.bounces || 0
        aggregatedStats.bounce_drops += m.bounce_drops || 0
        aggregatedStats.blocks += m.blocks || 0
        aggregatedStats.spam_reports += m.spam_reports || 0
        aggregatedStats.spam_report_drops += m.spam_report_drops || 0
        aggregatedStats.unsubscribes += m.unsubscribes || 0
        aggregatedStats.unsubscribe_drops += m.unsubscribe_drops || 0
        aggregatedStats.invalid_emails += m.invalid_emails || 0
        aggregatedStats.deferred += m.deferred || 0
      }
    }

    console.log(`   Stats retrieved:`, aggregatedStats)

    res.json({
      success: true,
      campaign_id: campaignId,
      category: categoryName,
      date_range: { start: startDate, end: endDate },
      stats: aggregatedStats,
      // Also return daily breakdown for charts
      daily: response,
    })
  } catch (error) {
    console.error('Error fetching SendGrid stats:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get link click statistics for a campaign
 * Calls the database function which handles aggregation efficiently
 */
app.get('/api/campaigns/:id/link-stats', async (req, res) => {
  try {
    const campaignId = req.params.id
    console.log(`📊 Fetching link stats for campaign: ${campaignId}`)

    // Call the database function - it handles aggregation in Postgres
    const { data, error } = await supabase.rpc('get_campaign_link_stats', {
      p_campaign_id: campaignId
    })

    if (error) {
      console.error('Error from database function:', error)
      throw error
    }

    console.log(`   Found ${data?.length || 0} unique URLs`)
    res.json(data || [])
  } catch (error) {
    console.error('Error fetching link stats:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get unique click counts for a campaign
 * Calls the database function which handles aggregation efficiently
 */
app.get('/api/campaigns/:id/unique-clicks', async (req, res) => {
  try {
    const campaignId = req.params.id
    console.log(`📊 Fetching unique clicks for campaign: ${campaignId}`)

    // Call the database function
    const { data, error } = await supabase.rpc('get_campaign_unique_clicks', {
      p_campaign_id: campaignId
    })

    if (error) {
      console.error('Error from database function:', error)
      throw error
    }

    const result = data?.[0] || { engaged_clicks: 0, unsub_clicks: 0 }
    console.log(`   Unique clicks - engaged: ${result.engaged_clicks}, unsub: ${result.unsub_clicks}`)

    res.json(result)
  } catch (error) {
    console.error('Error fetching unique clicks:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Generate a screenshot of HTML content (for heatmap PDF export)
 * Uses Puppeteer to render HTML with all images and styles
 */
app.post('/api/screenshot', async (req, res) => {
  let browser = null
  try {
    const { html, width = 800 } = req.body

    if (!html) {
      return res.status(400).json({ error: 'HTML content is required' })
    }

    console.log('📸 Generating screenshot...')

    // Launch Puppeteer (use system Chromium in production)
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })

    const page = await browser.newPage()

    // Set viewport
    await page.setViewport({ width: parseInt(width), height: 800 })

    // Set content and wait for images to load
    await page.setContent(html, {
      waitUntil: ['load', 'networkidle0'],
      timeout: 30000,
    })

    // Wait a bit more for any lazy-loaded content
    await new Promise(resolve => setTimeout(resolve, 500))

    // Get the full page height
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight)
    await page.setViewport({ width: parseInt(width), height: bodyHeight })

    // Take screenshot
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
      encoding: 'base64',
    })

    console.log('   Screenshot generated successfully')

    res.json({
      image: `data:image/png;base64,${screenshot}`,
      width: parseInt(width),
      height: bodyHeight,
    })
  } catch (error) {
    console.error('Error generating screenshot:', error)
    res.status(500).json({ error: error.message })
  } finally {
    if (browser) {
      await browser.close()
    }
  }
})

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

/**
 * AI Subscriber Analysis endpoint
 * Streams Claude's analysis of subscriber segments
 */
const analyzeRateLimit = { timestamps: [] }
app.post('/api/analyze-subscribers', async (req, res) => {
  // Simple rate limiting: 10 requests per minute
  const now = Date.now()
  analyzeRateLimit.timestamps = analyzeRateLimit.timestamps.filter(t => now - t < 60000)
  if (analyzeRateLimit.timestamps.length >= 10) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' })
  }
  analyzeRateLimit.timestamps.push(now)

  try {
    const { analysisType, contacts, totalContactCount } = req.body

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' })
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
    }

    const Anthropic = require('@anthropic-ai/sdk')
    const anthropic = new Anthropic()

    const systemPrompt = `You are an email marketing analyst. You are given subscriber data from an email marketing tool (PII has been removed). Provide concise, actionable insights in markdown format. Focus on patterns and recommendations. Use headers, bullet points, and bold text for readability. Keep your response under 500 words.`

    const typePrompts = {
      top_engaged: `Analyze these ${contacts.length} top-engaged email subscribers (out of ${totalContactCount || 'unknown'} total contacts). Look for commonalities in company, industry, tags, source codes, and engagement timing. What patterns distinguish high engagers? Provide 3-5 actionable insights for the marketing team.`,
      opened_and_clicked: `Analyze these ${contacts.length} subscribers who both opened AND clicked emails (out of ${totalContactCount || 'unknown'} total contacts). Look for commonalities in company, industry, tags, source codes, and engagement patterns. What makes these contacts more engaged than others? Provide 3-5 actionable insights.`,
      bounced: `Analyze these ${contacts.length} bounced email contacts. Look for patterns in bounce type (hard vs soft), industry, company domains, source codes, and timing. What might explain the bounces? Provide actionable recommendations to reduce bounce rates.`,
      unsubscribed: `Analyze these ${contacts.length} unsubscribed contacts. Look for patterns in when they unsubscribed, their prior engagement levels, industries, tags, and source codes. What might have caused them to leave? Provide actionable recommendations to reduce churn.`
    }

    const userPrompt = `${typePrompts[analysisType] || typePrompts.top_engaged}\n\nSubscriber data:\n${JSON.stringify(contacts.slice(0, 200), null, 2)}`

    // Set up SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`)
    })

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    })

    stream.on('error', (error) => {
      console.error('Claude streaming error:', error)
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Analysis failed' })}\n\n`)
      res.end()
    })

  } catch (error) {
    console.error('Analyze subscribers error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to analyze subscribers' })
    } else {
      res.end()
    }
  }
})

const { SHARED_HEAD_STYLES } = require('./email-templates')

// ─── AI Email Builder ──────────────────────────────────────────────────────
const emailBuilderRateLimit = { timestamps: [] }

// Get lightweight template index for AI context
app.get('/api/email-builder/templates', authenticateUser, async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const { data: templates, error: tErr } = await supabase
      .from('templates')
      .select('id, name, subject, preview_text, created_at')
      .eq('client_id', clientId)
      .order('updated_at', { ascending: false })
      .limit(50)

    if (tErr) throw tErr

    const { data: campaigns, error: cErr } = await supabase
      .from('campaigns')
      .select('name, sent_at, template_id, subject')
      .eq('client_id', clientId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(30)

    if (cErr) throw cErr

    res.json({ templates: templates || [], sentCampaigns: campaigns || [] })
  } catch (error) {
    console.error('Email builder templates error:', error)
    res.status(500).json({ error: 'Failed to fetch templates' })
  }
})

// Get full template HTML for reference
app.get('/api/email-builder/template/:id', authenticateUser, async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const { data: template, error } = await supabase
      .from('templates')
      .select('id, name, subject, preview_text, html_content')
      .eq('id', req.params.id)
      .eq('client_id', clientId)
      .single()

    if (error) throw error
    if (!template) return res.status(404).json({ error: 'Template not found' })

    res.json(template)
  } catch (error) {
    console.error('Email builder template detail error:', error)
    res.status(500).json({ error: 'Failed to fetch template' })
  }
})

// Chat endpoint with SSE streaming
app.post('/api/email-builder/chat', authenticateUser, async (req, res) => {
  // Rate limiting: 10 requests per minute
  const now = Date.now()
  emailBuilderRateLimit.timestamps = emailBuilderRateLimit.timestamps.filter(t => now - t < 60000)
  if (emailBuilderRateLimit.timestamps.length >= 10) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' })
  }
  emailBuilderRateLimit.timestamps.push(now)

  try {
    const { clientId, messages, referenceTemplateIds } = req.body

    if (!clientId || !messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'clientId and messages are required' })
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
    }

    const Anthropic = require('@anthropic-ai/sdk')
    const anthropic = new Anthropic()

    // Fetch template index for AI context
    const { data: templateIndex } = await supabase
      .from('templates')
      .select('id, name, subject')
      .eq('client_id', clientId)
      .order('updated_at', { ascending: false })
      .limit(30)

    // Fetch the client's brand reference template (if configured)
    let brandReferenceContext = ''
    const { data: clientRow } = await supabase
      .from('clients')
      .select('brand_reference_template_id')
      .eq('id', clientId)
      .single()

    if (clientRow?.brand_reference_template_id) {
      const { data: brandTemplate } = await supabase
        .from('templates')
        .select('name, subject, html_content')
        .eq('id', clientRow.brand_reference_template_id)
        .eq('client_id', clientId)
        .single()

      if (brandTemplate?.html_content) {
        brandReferenceContext = `<brand_reference name="${brandTemplate.name}" subject="${brandTemplate.subject || ''}">\n${brandTemplate.html_content}\n</brand_reference>`
      }
    }

    // Fetch reference templates if requested
    let referenceContext = ''
    if (referenceTemplateIds && referenceTemplateIds.length > 0) {
      const ids = referenceTemplateIds.slice(0, 2) // max 2
      const { data: refTemplates } = await supabase
        .from('templates')
        .select('name, subject, html_content')
        .in('id', ids)
        .eq('client_id', clientId)

      if (refTemplates && refTemplates.length > 0) {
        referenceContext = refTemplates.map(t =>
          `<reference_email name="${t.name}" subject="${t.subject}">\n${t.html_content}\n</reference_email>`
        ).join('\n\n')
      }
    }

    const templateListStr = (templateIndex || []).map(t =>
      `- "${t.name}" (subject: "${t.subject}", id: ${t.id})`
    ).join('\n')

    const systemPrompt = `You are an expert email HTML developer and design consultant. You help users iteratively build production-ready HTML emails through conversation.

ROLE:
- You are conversational and helpful. Discuss design choices, ask clarifying questions, suggest improvements.
- When the user asks you to create or modify an email, produce the complete HTML.
- When you produce or update HTML, ALWAYS include the full complete email HTML — never partial snippets.
- Learn the client's brand style from any reference emails provided. Match their colors, fonts, header/footer patterns, and overall aesthetic.

OUTPUT FORMAT:
- For conversational responses (questions, suggestions, no HTML changes): just respond normally with helpful text.
- When you generate or modify HTML, respond with your explanation FIRST, then include a JSON block fenced with triple backticks and "json" language tag:
\`\`\`json
{
  "subject": "the email subject line",
  "preview_text": "preview text for email clients (1-2 sentences)",
  "html_content": "the complete HTML email from <!DOCTYPE to </html>"
}
\`\`\`
- ALWAYS include the complete HTML from <!DOCTYPE> to </html> — never partial updates or diffs.

CRITICAL EMAIL HTML RULES FOR CROSS-CLIENT COMPATIBILITY:
- Use XHTML 1.0 Transitional doctype
- Table-based layout ONLY (no div-based layout for structure)
- ALL styles must be inline (style="...") — no external stylesheets
- Include MSO conditional comments for Outlook compatibility: <!--[if mso]> and <!--[if gte mso 9]>
- 600px max-width centered content body on a light background
- Font stacks: Arial, 'helvetica neue', helvetica, sans-serif (or similar web-safe stacks)
- All images must have: display:block, border:0, outline:none, text-decoration:none, and alt text
- Use cellpadding and cellspacing attributes on tables
- Every table should have: style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px"
- Include viewport meta tag: <meta content="width=device-width, initial-scale=1" name="viewport">
- Include <meta name="x-apple-disable-message-reformatting"> to prevent Apple Mail reformatting
- Use role="presentation" on layout tables, role="none" on structural tables
- For buttons: use table-based buttons with VML fallback for Outlook, or border-based padding trick
- Line heights: use px values, not unitless or em
- Background colors: set on <td> elements, not <table> or <tr>
- For responsive emails: include @media only screen and (max-width:600px) styles in a <style> block in <head>
- Use !important in media queries to override inline styles on mobile
- The <style> block in <head> is for responsive overrides only — primary styles must be inline

RESPONSIVE EMAIL CSS PATTERN (include in <head>):
${SHARED_HEAD_STYLES}

DOCUMENT HEAD PATTERN (adapt title as needed):
- Include proper XHTML doctype, charset UTF-8, viewport meta
- Include Outlook XML namespace: xmlns:o="urn:schemas-microsoft-com:office:office"
- Include MSO-specific noscript block for PixelsPerInch
- Include Word document XML to disable advanced typography

MERGE TAGS (the user's email platform supports these — use where appropriate):
- {{first_name}} — Recipient's first name
- {{last_name}} — Recipient's last name
- {{email}} — Recipient's email address
- {{unsubscribe_url}} — Unsubscribe link URL (use in href, required by CAN-SPAM)
- {{mailing_address}} — Sender's physical mailing address (required by CAN-SPAM)
- {{industry_link}} — Industry-specific URL based on contact's industry
- {{campaign_name}} — Campaign or Salesforce campaign name

CAN-SPAM COMPLIANCE:
Every email MUST include:
1. An unsubscribe link using {{unsubscribe_url}}
2. A physical mailing address using {{mailing_address}}
Remind the user if they ask you to remove these.

${brandReferenceContext ? `BRAND REFERENCE:
The user message may include a <brand_reference> block containing the client's current canonical brand template. Treat it as the default visual style: match its colors, fonts, header/footer, button styling, layout structure, and overall aesthetic in any email you produce, unless the user explicitly asks for a different style. The brand reference is a style guide, not the email content — copy its structure and styling, not its words.\n` : ''}${templateListStr ? `AVAILABLE PREVIOUS EMAILS (the user may reference these by name):\n${templateListStr}\n\nWhen the user references a previous email, they may provide its HTML as a <reference_email> block. Use it as a starting point or inspiration as directed.` : ''}

OUTLOOK / WORD-ENGINE HARD RULES (these bugs are INVISIBLE in browser preview — they only appear in classic desktop Outlook on Windows, which renders with Microsoft Word, not a browser engine. Follow these exactly):
- NEVER use a CSS border (border-top / border-bottom) as a section separator or horizontal rule. Word can render it doubled — the border plus a phantom seam show as two parallel lines.
- NEVER use a thin table row (1–3px tall) whose only content is whitespace/&nbsp; with a background-color as a divider. Word inflates short rows to a minimum height and renders the top AND bottom edges as two separate hairlines.
- NEVER put font-size:0 or line-height:0 on a <td> that contains an <img>. Word collapses the cell to zero height and the image DISAPPEARS entirely. (Safe in every other client — this one is Outlook-specific and silent.)
- Word paints faint ~1px seams of the page background color at nested-table / section boundaries on its own. Any additional visible separator line placed next to one reads as "doubled." The reliable rule: give classic Outlook NO visible separator lines at all — separate sections with padding/whitespace instead.
- When a visible divider line IS wanted for modern clients, hide it from Word with a downlevel-revealed conditional comment so Outlook falls back to clean whitespace. Canonical section divider (use this pattern; adjust color/padding to the brand):
  <!--[if !mso]><!-->
  <tr>
   <td style="padding:0 40px;Margin:0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">
     <tr><td style="height:1px;line-height:1px;font-size:1px;background-color:#E3E8EE">&nbsp;</td></tr>
    </table>
   </td>
  </tr>
  <!--<![endif]-->
- Prefer generous top/bottom padding on each section's <td> to define rhythm; reach for a visible line only when the design truly needs one, and then only via the conditional-comment pattern above.

DESIGN BEST PRACTICES:
- Keep email width at 600px for maximum compatibility
- Use web-safe fonts (Arial, Georgia, Verdana, Times New Roman)
- Minimum font size: 14px for body, 12px for fine print
- CTA buttons: minimum 44x44px touch target, high contrast colors
- Images: always include width/height attributes and meaningful alt text
- Preheader text: include as first hidden text in body for inbox preview
- Dark mode: use color-scheme and supported-color-schemes meta tags where possible
- Test with and without images — ensure content is readable with images blocked`

    // Build message array for Claude
    const claudeMessages = messages.slice(-10).map((msg, idx) => {
      let content = msg.content
      // Strip any cache_control markers on caller-provided content blocks —
      // the API allows max 4 breakpoints per request and ours are managed here
      if (Array.isArray(content)) {
        content = content.map(({ cache_control: _stray, ...block }) => block)
      }
      // Inject brand reference + paperclipped references into the first user message
      if (idx === 0 && msg.role === 'user') {
        const prefix = [brandReferenceContext, referenceContext].filter(Boolean).join('\n\n')
        if (prefix) content = `${prefix}\n\n${content}`
      }
      return { role: msg.role, content }
    })

    // Prompt caching: mark the newest turn so the next request in this
    // conversation reads the whole prior prefix (system + reference HTML +
    // earlier turns) at ~10% of input price. The frontend truncates to the
    // last 10 messages BEFORE sending (EmailBuilder.tsx), so the server can't
    // see the true conversation length — but a request with <= 8 messages is
    // guaranteed un-truncated, and since each turn adds 2 messages the NEXT
    // request (<= 10) is still un-truncated and can read this write. Beyond
    // that the window slides every turn and writes would never be read back.
    if (messages.length <= 8) {
      const last = claudeMessages[claudeMessages.length - 1]
      if (last && typeof last.content === 'string') {
        last.content = [{
          type: 'text',
          text: last.content,
          cache_control: { type: 'ephemeral' },
        }]
      }
    }

    // Set up SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      // Cached system block: gives every turn (even after the history window
      // slides) a stable read point covering the design-rules prompt.
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: claudeMessages,
    })

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`)
    })

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    })

    stream.on('error', (error) => {
      console.error('Email builder streaming error:', error)
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Generation failed' })}\n\n`)
      res.end()
    })

  } catch (error) {
    console.error('Email builder chat error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process chat: ' + (error.message || 'Unknown error') })
    } else {
      res.end()
    }
  }
})

/**
 * Gravity Forms webhook endpoint
 * Receives form submissions and adds email to contacts for Alconox client
 * Configure in Gravity Forms: Settings → Webhooks → Add New
 * URL: https://mail.sagerock.com/api/webhook/gravity-forms?key=YOUR_API_SECRET_KEY
 * Method: POST, Format: JSON
 * Map your email field to the key "email"
 * Optional: add &tag=yourtagname to specify a tag (defaults to "discountform")
 */
// New multi-tenant Gravity Forms webhook (routes by AI agent webhook key)
app.post('/api/webhook/gravity-forms/:webhookKey', webhookLimiter, async (req, res) => {
  try {
    const { webhookKey } = req.params
    console.log(`📥 Gravity Forms webhook hit: key=${webhookKey?.slice(0, 8)}… bodyKeys=[${Object.keys(req.body || {}).join(', ')}]`)

    // Look up AI agent config by webhook key
    const { data: config, error: configError } = await supabase
      .from('ai_followup_config')
      .select('*')
      .eq('webhook_key', webhookKey)
      .single()

    if (configError || !config) {
      console.error(`❌ Gravity Forms webhook: invalid/unknown webhook key (key=${webhookKey})`)
      return res.status(404).json({ error: 'Invalid webhook key' })
    }

    if (!config.enabled) {
      return res.status(400).json({ error: 'AI agent is disabled' })
    }

    // Extract contact fields. Gravity Forms sends field IDs ("2", "1.3", "16")
    // that vary per form, so honor the agent's field_map first, then fall back
    // to common named keys.
    const body = req.body
    const fmap = config.field_map || {}
    const pick = (logical, ...aliases) => {
      const keys = [fmap[logical], ...aliases].filter(Boolean)
      for (const k of keys) {
        const v = body[k]
        if (v != null && String(v).trim() !== '') return String(v).trim()
      }
      return null
    }

    // Email (required) - mapped key, common names, then a last-resort value scan
    let email = pick('email', 'email', 'Email', 'Work Email')
    if (!email) {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      for (const v of Object.values(body)) {
        if (typeof v === 'string' && emailRe.test(v.trim())) { email = v.trim(); break }
      }
    }
    if (!email) {
      console.error('❌ Gravity Forms webhook: no email field in payload', req.body)
      return res.status(400).json({ error: 'No email field in request body' })
    }

    const normalizedEmail = email.toLowerCase().trim()
    const clientId = config.client_id

    const firstName = pick('first_name', 'first_name', 'firstName', 'First Name')
    const lastName = pick('last_name', 'last_name', 'lastName', 'Last Name')
    const company = pick('company', 'company', 'Company', 'organization', 'Company Name')
    const industry = pick('industry', 'industry', 'Industry')

    // Build form submission record with all fields
    const formSubmission = {
      form_name: req.body.form_name || req.body.form_title || 'Web Form',
      submitted_at: new Date().toISOString(),
      fields: { ...req.body },
    }
    // Remove email from fields display (already captured as contact field)
    delete formSubmission.fields.email

    // Check if contact already exists
    const { data: existing } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, company, industry, form_submissions')
      .eq('client_id', clientId)
      .eq('email', normalizedEmail)
      .single()

    let contactId
    if (existing) {
      // Append form submission, fill in blank fields
      const updatedSubmissions = [...(existing.form_submissions || []), formSubmission]
      const updates = { form_submissions: updatedSubmissions }
      if (!existing.first_name && firstName) updates.first_name = firstName
      if (!existing.last_name && lastName) updates.last_name = lastName
      if (!existing.company && company) updates.company = company
      if (!existing.industry && industry) updates.industry = industry

      await supabase.from('contacts').update(updates).eq('id', existing.id)
      contactId = existing.id
      console.log(`📝 Gravity Forms webhook: updated contact ${normalizedEmail} with form submission (agent: ${config.name})`)
    } else {
      // Create new contact
      const { data: created, error: createError } = await supabase
        .from('contacts')
        .insert({
          client_id: clientId,
          email: normalizedEmail,
          first_name: firstName,
          last_name: lastName,
          company,
          industry,
          form_submissions: [formSubmission],
          unsubscribed: false,
        })
        .select('id')
        .single()

      if (createError) throw createError
      contactId = created.id
      console.log(`✅ Gravity Forms webhook: created contact ${normalizedEmail} (agent: ${config.name})`)
    }

    // Check if already enrolled in this AI agent
    const { data: existingEnrollment } = await supabase
      .from('ai_followup_contacts')
      .select('id')
      .eq('config_id', config.id)
      .eq('contact_id', contactId)
      .limit(1)

    if (existingEnrollment && existingEnrollment.length > 0) {
      return res.json({ success: true, action: 'already_enrolled', contact_id: contactId })
    }

    // Enroll contact with immediate follow-up
    const { error: enrollError } = await supabase
      .from('ai_followup_contacts')
      .upsert({
        config_id: config.id,
        contact_id: contactId,
        client_id: clientId,
        status: 'in_progress',
        current_step: 0,
        next_followup_at: new Date().toISOString(),
      }, { onConflict: 'config_id,contact_id' })

    if (enrollError) throw enrollError
    console.log(`🤖 Gravity Forms webhook: enrolled ${normalizedEmail} in AI agent "${config.name}"`)

    // Immediately generate AI draft
    try {
      const generateUrl = `http://localhost:${PORT}/api/ai-followup/generate`
      const generateRes = await fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, configId: config.id }),
      })
      if (!generateRes.ok) {
        const err = await generateRes.json()
        console.error(`⚠️ Immediate AI draft generation failed for ${normalizedEmail}:`, err.error)
      } else {
        console.log(`✅ AI draft generated immediately for ${normalizedEmail} (agent: ${config.name})`)
      }
    } catch (genError) {
      console.error(`⚠️ Immediate AI draft generation error:`, genError.message)
      // Don't fail the webhook - the cron will pick it up
    }

    res.json({ success: true, action: existing ? 'updated_and_enrolled' : 'created_and_enrolled', contact_id: contactId })
  } catch (error) {
    console.error('❌ Gravity Forms webhook error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Legacy Gravity Forms webhook (Alconox-specific, kept for backward compatibility)
app.post('/api/webhook/gravity-forms', webhookLimiter, async (req, res) => {
  try {
    console.log('⚠️ Deprecated: Using legacy Gravity Forms webhook. Migrate to /api/webhook/gravity-forms/:webhookKey')
    // Validate API key from query parameter
    const apiKey = process.env.API_SECRET_KEY
    if (!apiKey) {
      console.error('❌ API_SECRET_KEY not configured')
      return res.status(500).json({ error: 'API key not configured on server' })
    }

    const providedKey = req.query.key
    if (!providedKey || providedKey !== apiKey) {
      return res.status(401).json({ error: 'Invalid or missing API key' })
    }

    // Extract email from payload
    const email = req.body.email
    if (!email) {
      console.error('❌ Gravity Forms webhook: no email field in payload', req.body)
      return res.status(400).json({ error: 'No email field in request body' })
    }

    const normalizedEmail = email.toLowerCase().trim()
    const tag = (req.query.tag || 'discountform').toLowerCase().trim()

    // Look up Alconox client
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id')
      .ilike('name', '%alconox%')
      .single()

    if (clientError || !client) {
      console.error('❌ Could not find Alconox client:', clientError)
      return res.status(500).json({ error: 'Could not find Alconox client' })
    }

    // Check if contact already exists
    const { data: existing } = await supabase
      .from('contacts')
      .select('id, email, tags')
      .eq('client_id', client.id)
      .eq('email', normalizedEmail)
      .single()

    if (existing) {
      // Add tag if not already present
      const existingTags = existing.tags || []
      if (!existingTags.includes(tag)) {
        await supabase
          .from('contacts')
          .update({ tags: [...existingTags, tag] })
          .eq('id', existing.id)
        console.log(`📝 Gravity Forms: added ${tag} tag to existing contact ${normalizedEmail}`)
        return res.json({ success: true, action: 'tagged', email: normalizedEmail, tag })
      }
      console.log(`ℹ️ Gravity Forms: contact ${normalizedEmail} already exists with tag ${tag}, skipping`)
      return res.json({ success: true, action: 'exists', email: normalizedEmail, tag })
    }

    // Create new contact
    const { data: created, error: createError } = await supabase
      .from('contacts')
      .insert({
        client_id: client.id,
        email: normalizedEmail,
        first_name: null,
        last_name: null,
        tags: [tag],
        unsubscribed: false,
      })
      .select()
      .single()

    if (createError) throw createError

    // Ensure tag exists in tags table
    await supabase.from('tags').upsert(
      { name: tag, client_id: client.id },
      { onConflict: 'name,client_id' }
    )

    console.log(`✅ Gravity Forms: created contact ${normalizedEmail} with tag: ${tag}`)
    res.json({ success: true, action: 'created', email: normalizedEmail, contact_id: created.id, tag })
  } catch (error) {
    console.error('❌ Gravity Forms webhook error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Upsert contact endpoint
 * Creates or updates a contact and merges tags
 * Used by external integrations (Make.com, Zapier, etc.)
 */
app.post('/api/contacts/upsert', upsertLimiter, async (req, res) => {
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
// NOTE: This endpoint is dead code — the cron handler (cron PART 2) handles all
// sequence email processing. This endpoint is kept for reference only and does not
// implement the full skip-chain logic. Do not call directly.
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
        const { data: clientRaw } = await supabase
          .from('clients')
          .select('*')
          .eq('id', sequence.client_id)
          .single()

        const client = decryptClient(clientRaw)
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
          categories: [
            `sequence-${sequence.id}`,
            `sequence-step-${step.id}`,
            clientCategory(client),
          ].filter(Boolean),
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
          const scheduledFor = computeNextSendTime(nextStep, new Date())

          if (scheduledFor !== null) {
            await supabase.from('scheduled_emails').upsert({
              enrollment_id: enrollment.id,
              step_id: nextStep.id,
              contact_id: contact.id,
              scheduled_for: scheduledFor.toISOString(),
              status: 'pending',
            }, {
              onConflict: 'enrollment_id,step_id',
              ignoreDuplicates: true
            })

            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: scheduledFor.toISOString(),
              })
              .eq('id', enrollment.id)
          }
          // null: fixed-date step skipped — enrollment stays active, no scheduled_email created
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
app.post('/api/webhook/sequence', webhookLimiter, async (req, res) => {
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
        blocked: 'block',
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

// ============ INBOUND EMAIL (AI Reply-via-Email) ============
// Processes replies to AI-generated emails via SendGrid Inbound Parse
// MX record: reply.sagerock.com → mx.sendgrid.net
// SendGrid Inbound Parse posts to this endpoint

const multer = require('multer')
const inboundUpload = multer() // memory storage, we only need the text fields

app.post('/api/webhook/inbound-email', webhookLimiter, inboundUpload.any(), async (req, res) => {
  try {
    // SendGrid Inbound Parse sends multipart form data
    const {
      from: rawFrom,
      to: rawTo,
      subject,
      text: bodyText,
      html: bodyHtml,
    } = req.body

    console.log(`📨 Inbound email from: ${rawFrom}, to: ${rawTo}, subject: ${subject}`)

    // Extract the sender's email from the "From" field (e.g., "Sage Lewis <sage@example.com>")
    const fromEmailMatch = rawFrom?.match(/<([^>]+)>/) || [null, rawFrom?.trim()]
    const senderEmail = fromEmailMatch[1]?.toLowerCase()?.trim()

    if (!senderEmail) {
      console.error('❌ Inbound email: could not parse sender email from:', rawFrom)
      return res.status(200).send('OK') // Always 200 to SendGrid so it doesn't retry
    }

    // Extract contact ID from the "To" address (e.g., "ai+<uuid>@reply.sagerock.com")
    const contactIdMatch = rawTo?.match(/ai\+([a-f0-9-]+)@reply\.sagerock\.com/i)
    const contactId = contactIdMatch?.[1]

    if (!contactId) {
      console.log('📨 General chatbot: no +uuid in To address, using general chatbot path')
      // Handle as general chatbot email (async, respond to SendGrid immediately)
      handleGeneralChatbotEmail(senderEmail, rawFrom, subject, bodyText, bodyHtml).catch(err => {
        console.error('❌ General chatbot error:', err)
      })
      return res.status(200).send('OK')
    }

    // Look up the contact
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single()

    if (contactError || !contact) {
      console.error('❌ Inbound email: contact not found for ID:', contactId)
      return res.status(200).send('OK')
    }

    // Verify the sender matches the contact (security check)
    if (contact.email !== senderEmail) {
      console.warn(`⚠️ Inbound email: sender ${senderEmail} doesn't match contact ${contact.email}`)
      return res.status(200).send('OK')
    }

    // Use the plain text body, fall back to stripping HTML
    const messageBody = bodyText?.trim() || bodyHtml?.replace(/<[^>]*>/g, ' ').trim() || ''

    if (!messageBody) {
      console.warn('⚠️ Inbound email: empty message body from:', senderEmail)
      return res.status(200).send('OK')
    }

    // Strip quoted reply text (lines starting with > or "On ... wrote:")
    const cleanBody = messageBody
      .split(/\n/)
      .filter(line => !line.startsWith('>'))
      .join('\n')
      .split(/On .+ wrote:/)[0]
      .trim()

    if (!cleanBody) {
      console.warn('⚠️ Inbound email: only quoted text, no new content from:', senderEmail)
      return res.status(200).send('OK')
    }

    // Log the inbound message
    await supabase.from('email_conversations').insert({
      client_id: contact.client_id,
      contact_id: contact.id,
      direction: 'inbound',
      subject: subject || '(no subject)',
      body: cleanBody,
      ai_generated: false,
      escalated: false,
    })

    console.log(`📝 Logged inbound email from ${senderEmail}: "${cleanBody.substring(0, 100)}..."`)

    // Forward inbound message to Sage for visibility
    try {
      const fwdApiKey = process.env.CONTACT_SENDGRID_API_KEY
      if (fwdApiKey) {
        sgMail.setApiKey(fwdApiKey)
        await sgMail.send({
          to: 'sage@sagerock.com',
          from: { email: 'ai@sagerock.com', name: 'SageRock AI Assistant' },
          subject: `📩 ${contact.first_name || senderEmail} replied: ${subject || '(no subject)'}`,
          text: `From: ${contact.first_name || ''} (${senderEmail})\n\n${cleanBody}`,
          html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">
            <p><strong>From:</strong> ${contact.first_name || ''} (${senderEmail})</p>
            <hr>
            <p>${cleanBody.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
          </div>`,
        })
      }
    } catch (fwdErr) {
      console.warn('⚠️ Failed to forward inbound email to Sage:', fwdErr.message)
    }

    // Generate AI reply (async, respond to SendGrid immediately)
    generateAndSendAiReply(contact, cleanBody, subject).catch(err => {
      console.error('❌ Failed to generate AI reply:', err)
    })

    res.status(200).send('OK')
  } catch (error) {
    console.error('❌ Inbound email webhook error:', error)
    res.status(200).send('OK') // Always 200 so SendGrid doesn't retry
  }
})

/**
 * Load the active knowledge base for a client.
 * Checks the database first, falls back to the file on disk.
 */
async function loadKnowledgeBase(clientId) {
  // Try database first
  if (clientId) {
    try {
      const { data } = await supabase
        .from('knowledge_bases')
        .select('content')
        .eq('client_id', clientId)
        .eq('is_active', true)
        .single()

      if (data?.content) {
        console.log('📚 Loaded knowledge base from database')
        return data.content
      }
    } catch (err) {
      // Table might not exist yet or no active KB — fall through to file
    }
  }

  // Fall back to file on disk
  const fs = require('fs')
  const knowledgeBasePath = path.join(__dirname, '..', 'knowledge', 'ai-for-business.md')
  try {
    const content = fs.readFileSync(knowledgeBasePath, 'utf-8')
    console.log('📚 Loaded knowledge base from file')
    return content
  } catch (err) {
    console.warn('⚠️ No knowledge base found, using defaults')
    return 'AI for Business video series by Sage at SageRock. Helps business owners learn to automate their business with AI.'
  }
}

/**
 * Handle inbound emails to ai@reply.sagerock.com (no +uuid).
 * Resolves or creates the sender as a contact, generates an AI reply,
 * and routes future replies through the UUID-based handler.
 */
async function handleGeneralChatbotEmail(senderEmail, rawFrom, subject, bodyText, bodyHtml) {
  const clientId = process.env.PUBLIC_SIGNUP_CLIENT_ID
  if (!clientId) {
    console.error('❌ General chatbot: PUBLIC_SIGNUP_CLIENT_ID not configured')
    return
  }

  // Parse display name from From header (e.g., "John Smith <john@example.com>")
  const nameMatch = rawFrom?.match(/^"?([^"<]+)"?\s*</)
  const displayName = nameMatch?.[1]?.trim() || ''
  const nameParts = displayName.split(/\s+/)
  const firstName = nameParts[0] || null
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null

  // Use the plain text body, fall back to stripping HTML
  const messageBody = bodyText?.trim() || bodyHtml?.replace(/<[^>]*>/g, ' ').trim() || ''
  if (!messageBody) {
    console.warn('⚠️ General chatbot: empty message body from:', senderEmail)
    return
  }

  // Strip quoted reply text
  const cleanBody = messageBody
    .split(/\n/)
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .split(/On .+ wrote:/)[0]
    .trim()

  if (!cleanBody) {
    console.warn('⚠️ General chatbot: only quoted text from:', senderEmail)
    return
  }

  // Look up or create contact
  let contact
  const { data: existing } = await supabase
    .from('contacts')
    .select('*')
    .eq('client_id', clientId)
    .eq('email', senderEmail)
    .single()

  if (existing) {
    contact = existing
    console.log(`📇 General chatbot: found existing contact ${senderEmail}`)
  } else {
    const { data: created, error: createError } = await supabase
      .from('contacts')
      .insert({
        client_id: clientId,
        email: senderEmail,
        first_name: firstName,
        last_name: lastName,
        tags: ['ai-chatbot'],
        unsubscribed: false,
      })
      .select()
      .single()

    if (createError) {
      console.error('❌ General chatbot: failed to create contact:', createError.message)
      return
    }
    contact = created
    console.log(`✅ General chatbot: created contact ${senderEmail} with tag ai-chatbot`)
  }

  // Log the inbound message
  const { error: logError } = await supabase.from('email_conversations').insert({
    client_id: contact.client_id,
    contact_id: contact.id,
    direction: 'inbound',
    subject: subject || '(no subject)',
    body: cleanBody,
    ai_generated: false,
    escalated: false,
  })
  if (logError) console.error('⚠️ General chatbot: failed to log inbound message:', logError.message)

  console.log(`📝 General chatbot: logged inbound from ${senderEmail}: "${cleanBody.substring(0, 100)}..."`)

  // Forward inbound message to Sage for visibility
  try {
    const fwdApiKey = process.env.CONTACT_SENDGRID_API_KEY
    if (fwdApiKey) {
      sgMail.setApiKey(fwdApiKey)
      await sgMail.send({
        to: 'sage@sagerock.com',
        from: { email: 'ai@sagerock.com', name: 'SageRock AI Assistant' },
        subject: `📩 ${contact.first_name || senderEmail} emailed the AI chatbot: ${subject || '(no subject)'}`,
        text: `From: ${contact.first_name || ''} ${contact.last_name || ''} (${senderEmail})\n\n${cleanBody}`,
        html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">
          <p><strong>From:</strong> ${contact.first_name || ''} ${contact.last_name || ''} (${senderEmail})</p>
          <p><small>New contact: ${!existing ? 'Yes (created with ai-chatbot tag)' : 'No (existing contact)'}</small></p>
          <hr>
          <p>${cleanBody.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
        </div>`,
      })
    }
  } catch (fwdErr) {
    console.warn('⚠️ General chatbot: failed to forward to Sage:', fwdErr.message)
  }

  // Generate and send AI reply (reuses existing function which handles
  // knowledge base loading, conversation history, Claude, SendGrid, escalation)
  await generateAndSendAiReply(contact, cleanBody, subject)
}

/**
 * Generate an AI reply to an inbound email and send it, or escalate to Sage
 */
async function generateAndSendAiReply(contact, inboundMessage, originalSubject) {
  const knowledgeBase = await loadKnowledgeBase(contact.client_id)

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not configured, cannot generate AI reply')
    return
  }

  // Load conversation history for context
  const { data: history } = await supabase
    .from('email_conversations')
    .select('direction, body, created_at')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(20)

  const conversationContext = (history || [])
    .map(msg => `[${msg.direction === 'outbound' ? 'AI Assistant' : contact.first_name || 'Contact'}]: ${msg.body}`)
    .join('\n\n')

  const Anthropic = require('@anthropic-ai/sdk')
  const anthropic = new Anthropic()

  const systemPrompt = `You are Sage's AI assistant at SageRock. You're having an email conversation with ${contact.first_name || 'someone'} (${contact.email}).

Your job is to be helpful, answer their questions using the knowledge base, and be a genuinely useful resource. Be conversational, warm, and genuine — like a helpful colleague, not a chatbot.

IMPORTANT RULES:
- Return ONLY a JSON object with "subject", "body", and "escalate" fields
- "body" should be plain text (no HTML)
- "escalate" should be true if you genuinely cannot answer their question or they're asking for something that requires Sage personally (custom consulting, pricing for services, technical issues with their account, complaints, or anything outside the knowledge base)
- If escalating, still write a friendly reply letting them know Sage will follow up personally
- Keep responses concise: 2-3 paragraphs max
- Do NOT make up information not in the knowledge base
- Do NOT invent links, prices, or promises
- Sign off casually — no need for a formal signature every time

KNOWLEDGE BASE:
${knowledgeBase}`

  const userPrompt = `Conversation so far:
${conversationContext}

New message from ${contact.first_name || 'the contact'}:
${inboundMessage}

Write a reply. Return JSON with "subject", "body", and "escalate" fields.`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const aiText = response.content[0].text
  let parsed
  try {
    const jsonMatch = aiText.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiText)
  } catch (e) {
    console.error('❌ Failed to parse AI reply response:', aiText)
    return
  }

  const replySubject = parsed.subject || `Re: ${originalSubject || 'AI for Business'}`
  const shouldEscalate = parsed.escalate === true

  // Send the AI reply via SendGrid
  const apiKey = process.env.CONTACT_SENDGRID_API_KEY
  if (!apiKey) {
    console.error('❌ CONTACT_SENDGRID_API_KEY not configured, cannot send AI reply')
    return
  }

  sgMail.setApiKey(apiKey)

  const replyToEmail = `ai+${contact.id}@reply.sagerock.com`
  const htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${parsed.body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>')}</div>`

  await sgMail.send({
    to: contact.email,
    bcc: [{ email: 'sage@sagerock.com' }],
    from: { email: 'ai@sagerock.com', name: 'SageRock AI Assistant' },
    replyTo: { email: replyToEmail, name: 'SageRock AI Assistant' },
    subject: replySubject,
    text: parsed.body,
    html: htmlBody,
  })

  console.log(`🤖 AI reply sent to ${contact.email} (escalated: ${shouldEscalate})`)

  // Log the outbound reply
  await supabase.from('email_conversations').insert({
    client_id: contact.client_id,
    contact_id: contact.id,
    direction: 'outbound',
    subject: replySubject,
    body: parsed.body,
    ai_generated: true,
    escalated: shouldEscalate,
  })

  // If escalating, notify Sage
  if (shouldEscalate) {
    await sgMail.send({
      to: 'sage@sagerock.com',
      from: { email: 'ai@sagerock.com', name: 'SageRock AI Assistant' },
      subject: `🔔 AI escalation: ${contact.first_name || contact.email} needs your help`,
      text: `The AI assistant couldn't fully help ${contact.first_name || 'a contact'} (${contact.email}) and has escalated to you.\n\nTheir message:\n${inboundMessage}\n\nAI's reply (already sent):\n${parsed.body}\n\nFull conversation history is in the email_conversations table for contact ID: ${contact.id}`,
      html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">
        <p><strong>The AI assistant couldn't fully help ${contact.first_name || 'a contact'} (${contact.email}) and has escalated to you.</strong></p>
        <hr>
        <p><strong>Their message:</strong></p>
        <p>${inboundMessage.replace(/\n/g, '<br>')}</p>
        <hr>
        <p><strong>AI's reply (already sent):</strong></p>
        <p>${parsed.body.replace(/\n/g, '<br>')}</p>
        <hr>
        <p><small>Contact ID: ${contact.id} | Reply directly to ${contact.email} if you want to take over the conversation.</small></p>
      </div>`,
    })

    console.log(`📧 Escalation notification sent to sage@sagerock.com for contact ${contact.email}`)
  }
}

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

    // Connection successful - store credentials (encrypted)
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        salesforce_instance_url: normalizedUrl,
        salesforce_client_id: ENCRYPTION_KEY ? encryptValue(salesforceClientId, ENCRYPTION_KEY) : salesforceClientId,
        salesforce_client_secret: ENCRYPTION_KEY ? encryptValue(salesforceClientSecret, ENCRYPTION_KEY) : salesforceClientSecret,
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
        campaign_sync_status: null,
        campaign_sync_message: null,
        last_campaign_sync: null,
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
      .select('salesforce_instance_url, salesforce_connected_at, last_salesforce_sync, salesforce_sync_status, salesforce_sync_message, salesforce_sync_count, campaign_sync_status, campaign_sync_message, last_campaign_sync')
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
      campaignSyncStatus: client.campaign_sync_status,
      campaignSyncMessage: client.campaign_sync_message,
      lastCampaignSync: client.last_campaign_sync,
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
  const { data: clientRaw, error } = await supabase
    .from('clients')
    .select('salesforce_instance_url, salesforce_client_id, salesforce_client_secret')
    .eq('id', clientId)
    .single()

  const client = decryptClient(clientRaw)
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

// ============================================================
// WooCommerce integration
// Per-client store credentials (encrypted), email-keyed order sync, and
// denormalized purchase rollups on contacts. Enrich-only — never touches
// `unsubscribed`. Mirrors the Salesforce sync model above.
// ============================================================

// Alconox's store (and many WP hosts) sit behind a WAF that 403s the default
// fetch/undici user-agent. A named UA gets through.
const WOO_USER_AGENT = 'SageRockEmailTool/1.0 (+https://mail.sagerock.com)'

// WooCommerce statuses that do NOT represent realized revenue. Used to exclude
// orders from contact rollups (kept in sync with recompute_woo_rollups()).
const WOO_NON_REVENUE_STATUSES = new Set([
  'cancelled', 'refunded', 'failed', 'trash', 'checkout-draft', 'pending',
])

/**
 * Resolve and decrypt a client's WooCommerce credentials.
 * Returns { baseUrl, authHeader } or throws if not configured.
 */
async function getWooClient(clientId) {
  const { data: clientRaw, error } = await supabase
    .from('clients')
    .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
    .eq('id', clientId)
    .single()

  if (error) throw new Error(`Failed to load client: ${error.message}`)
  const client = decryptClient(clientRaw)
  if (!client.woocommerce_url || !client.woocommerce_consumer_key || !client.woocommerce_consumer_secret) {
    throw new Error('WooCommerce is not connected for this client')
  }

  const baseUrl = client.woocommerce_url.replace(/\/+$/, '') + '/wp-json/wc/v3'
  const authHeader = 'Basic ' + Buffer.from(
    `${client.woocommerce_consumer_key}:${client.woocommerce_consumer_secret}`
  ).toString('base64')
  return { baseUrl, authHeader }
}

/**
 * GET a WooCommerce REST endpoint with auth + WAF-friendly UA, returning
 * { data, totalPages }. Retries transient failures with backoff.
 */
async function wooFetch(baseUrl, authHeader, path) {
  const url = `${baseUrl}${path}`
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: authHeader, 'User-Agent': WOO_USER_AGENT, Accept: 'application/json' },
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        // 4xx (except 429) is not worth retrying — surface immediately.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw new Error(`WooCommerce ${resp.status}: ${body.slice(0, 200)}`)
        }
        throw new Error(`WooCommerce ${resp.status} (retryable): ${body.slice(0, 120)}`)
      }
      const data = await resp.json()
      const totalPages = parseInt(resp.headers.get('x-wp-totalpages') || '1', 10)
      return { data, totalPages }
    } catch (err) {
      lastErr = err
      if (/WooCommerce 4\d\d:/.test(err.message)) throw err // non-retryable 4xx
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  throw lastErr
}

/**
 * Map a raw WooCommerce order to our row shape. Data-minimized: we keep email,
 * money, dates, and line-item SKUs — not billing address, phone, IP, or payment.
 */
function mapWooOrder(order, clientId) {
  const email = (order.billing?.email || '').toLowerCase().trim() || null
  return {
    client_id: clientId,
    woo_order_id: order.id,
    email,
    status: order.status || null,
    total: order.total != null ? parseFloat(order.total) : null,
    currency: order.currency || null,
    // date_created_gmt has no tz suffix; mark it UTC explicitly.
    order_date: order.date_created_gmt ? `${order.date_created_gmt}Z` : (order.date_created || null),
    line_items: Array.isArray(order.line_items)
      ? order.line_items.map(li => ({ sku: li.sku || null, name: li.name || null, qty: li.quantity, total: li.total }))
      : null,
    updated_at: new Date().toISOString(),
  }
}

/**
 * Core WooCommerce sync. Incremental by `modified_after` (UTC) unless fullSync.
 * Returns { ordersSynced, contactsUpdated }.
 */
async function runWooSync(clientId, fullSync = false) {
  const { baseUrl, authHeader } = await getWooClient(clientId)

  const { data: client } = await supabase
    .from('clients')
    .select('last_woocommerce_sync')
    .eq('id', clientId)
    .single()

  const syncStartTime = new Date().toISOString()
  const syncSince = fullSync ? null : client?.last_woocommerce_sync

  // dates_are_gmt=true makes modified_after compare in UTC (WooCommerce
  // otherwise interprets it in the store's local timezone). orderby=modified
  // keeps pagination stable as the result set shifts during the run.
  const baseParams = new URLSearchParams({
    per_page: '100', status: 'any', orderby: 'modified', order: 'asc', dates_are_gmt: 'true',
  })
  if (syncSince) baseParams.set('modified_after', syncSince)

  const affectedEmails = new Set()
  let ordersSynced = 0
  let page = 1
  let totalPages = 1

  do {
    const params = new URLSearchParams(baseParams)
    params.set('page', String(page))
    const { data: orders, totalPages: tp } = await wooFetch(baseUrl, authHeader, `/orders?${params}`)
    totalPages = tp
    if (!Array.isArray(orders) || orders.length === 0) break

    const rows = orders.map(o => mapWooOrder(o, clientId))
    const { error: upErr } = await supabase
      .from('woocommerce_orders')
      .upsert(rows, { onConflict: 'client_id,woo_order_id', ignoreDuplicates: false })
    if (upErr) throw new Error(`Order upsert failed: ${upErr.message}`)

    for (const r of rows) if (r.email) affectedEmails.add(r.email)
    ordersSynced += rows.length
    page++
  } while (page <= totalPages)

  // Recompute rollups for the touched emails, in chunks (keeps the array param
  // and the UPDATE bounded). Excludes non-revenue statuses inside the RPC.
  let contactsUpdated = 0
  const emails = [...affectedEmails]
  const CHUNK = 500
  for (let i = 0; i < emails.length; i += CHUNK) {
    const { data: n, error: rpcErr } = await supabase.rpc('recompute_woo_rollups', {
      p_client_id: clientId,
      p_emails: emails.slice(i, i + CHUNK),
    })
    if (rpcErr) throw new Error(`Rollup recompute failed: ${rpcErr.message}`)
    contactsUpdated += n || 0
  }

  await supabase
    .from('clients')
    .update({
      last_woocommerce_sync: syncStartTime,
      woocommerce_sync_status: 'completed',
      woocommerce_sync_count: ordersSynced,
      woocommerce_sync_message: `Synced ${ordersSynced} order(s); updated ${contactsUpdated} contact(s)`,
    })
    .eq('id', clientId)

  return { ordersSynced, contactsUpdated }
}

/**
 * Connect a WooCommerce store: store encrypted credentials and verify them.
 */
app.post('/api/woocommerce/connect', async (req, res) => {
  try {
    const { clientId, storeUrl, consumerKey, consumerSecret } = req.body
    if (!clientId || !storeUrl || !consumerKey || !consumerSecret) {
      return res.status(400).json({ error: 'clientId, storeUrl, consumerKey, and consumerSecret are required' })
    }

    const normalizedUrl = storeUrl.trim().replace(/\/+$/, '')
    const baseUrl = `${normalizedUrl}/wp-json/wc/v3`
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')

    // Verify credentials with a minimal call before saving.
    try {
      await wooFetch(baseUrl, authHeader, '/orders?per_page=1')
    } catch (verifyErr) {
      return res.status(400).json({ error: `Could not connect to WooCommerce: ${verifyErr.message}` })
    }

    const { error: updateError } = await supabase
      .from('clients')
      .update({
        woocommerce_url: normalizedUrl,
        woocommerce_consumer_key: ENCRYPTION_KEY ? encryptValue(consumerKey, ENCRYPTION_KEY) : consumerKey,
        woocommerce_consumer_secret: ENCRYPTION_KEY ? encryptValue(consumerSecret, ENCRYPTION_KEY) : consumerSecret,
        woocommerce_connected_at: new Date().toISOString(),
        woocommerce_sync_status: 'idle',
        woocommerce_sync_message: null,
      })
      .eq('id', clientId)

    if (updateError) {
      console.error('Error storing WooCommerce credentials:', updateError)
      return res.status(500).json({ error: 'Failed to save WooCommerce connection' })
    }

    console.log(`✅ WooCommerce connected for client ${clientId}`)
    res.json({ success: true, message: 'WooCommerce connected successfully' })
  } catch (error) {
    console.error('WooCommerce connect error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get WooCommerce connection/sync status for a client.
 */
app.get('/api/woocommerce/status', async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const { data: client, error } = await supabase
      .from('clients')
      .select('woocommerce_url, woocommerce_connected_at, last_woocommerce_sync, woocommerce_sync_status, woocommerce_sync_message, woocommerce_sync_count')
      .eq('id', clientId)
      .single()

    if (error) throw error

    res.json({
      connected: !!client.woocommerce_url,
      storeUrl: client.woocommerce_url,
      connectedAt: client.woocommerce_connected_at,
      lastSync: client.last_woocommerce_sync,
      syncStatus: client.woocommerce_sync_status,
      syncMessage: client.woocommerce_sync_message,
      syncCount: client.woocommerce_sync_count,
    })
  } catch (error) {
    console.error('Error getting WooCommerce status:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Disconnect WooCommerce from a client (clears credentials + sync state).
 */
app.post('/api/woocommerce/disconnect', async (req, res) => {
  try {
    const { clientId } = req.body
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const { error } = await supabase
      .from('clients')
      .update({
        woocommerce_url: null,
        woocommerce_consumer_key: null,
        woocommerce_consumer_secret: null,
        woocommerce_connected_at: null,
        woocommerce_sync_status: null,
        woocommerce_sync_message: null,
        woocommerce_sync_count: null,
        last_woocommerce_sync: null,
      })
      .eq('id', clientId)

    if (error) throw error
    console.log(`🔌 WooCommerce disconnected for client ${clientId}`)
    res.json({ success: true })
  } catch (error) {
    console.error('Error disconnecting WooCommerce:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Sync WooCommerce orders for a client. Body: { clientId, fullSync? }.
 * Runs in the background; poll /api/woocommerce/status for progress.
 */
app.post('/api/woocommerce/sync', async (req, res) => {
  try {
    const { clientId, fullSync } = req.body
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    await supabase
      .from('clients')
      .update({ woocommerce_sync_status: 'syncing', woocommerce_sync_message: 'Starting sync...' })
      .eq('id', clientId)

    // Respond immediately; the sync can take a while across many pages.
    res.json({ success: true, message: 'WooCommerce sync started' })

    runWooSync(clientId, !!fullSync)
      .then(({ ordersSynced, contactsUpdated }) => {
        console.log(`✅ WooCommerce sync done for ${clientId}: ${ordersSynced} orders, ${contactsUpdated} contacts`)
      })
      .catch(async (err) => {
        console.error('WooCommerce sync error:', err.message)
        await supabase
          .from('clients')
          .update({ woocommerce_sync_status: 'error', woocommerce_sync_message: err.message })
          .eq('id', clientId)
      })
  } catch (error) {
    console.error('WooCommerce sync error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message })
  }
})

/**
 * Resolve the set of lowercased buyer emails who purchased any of the given
 * SKUs (revenue statuses only). Used by campaign purchase-filtering. Paginates
 * woocommerce_orders rather than passing a large id list through PostgREST.
 */
async function getProductBuyerEmailSet(clientId, skus) {
  const skuSet = new Set((skus || []).filter(Boolean))
  const emails = new Set()
  if (skuSet.size === 0) return emails

  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await withRetry(
      () => supabase.from('woocommerce_orders')
        .select('email, status, line_items')
        .eq('client_id', clientId)
        .range(from, from + PAGE - 1),
      { label: `Fetch woo orders page ${from / PAGE + 1}` }
    )
    if (error) throw error
    if (!data || data.length === 0) break
    for (const o of data) {
      if (!o.email || WOO_NON_REVENUE_STATUSES.has(o.status)) continue
      const items = Array.isArray(o.line_items) ? o.line_items : []
      if (items.some(li => li && skuSet.has(li.sku))) emails.add(o.email.toLowerCase())
    }
    if (data.length < PAGE) break
    from += PAGE
  }
  return emails
}

/**
 * List distinct products (sku + name) a client's customers have purchased,
 * with buyer counts — powers the product picker in the campaign builder.
 */
app.get('/api/woocommerce/products', async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const PAGE = 1000
    let from = 0
    const bySku = new Map() // sku -> { sku, name, buyers:Set<email> }
    while (true) {
      const { data, error } = await supabase.from('woocommerce_orders')
        .select('email, status, line_items')
        .eq('client_id', clientId)
        .range(from, from + PAGE - 1)
      if (error) throw error
      if (!data || data.length === 0) break
      for (const o of data) {
        if (WOO_NON_REVENUE_STATUSES.has(o.status)) continue
        const items = Array.isArray(o.line_items) ? o.line_items : []
        for (const li of items) {
          if (!li || !li.sku) continue
          if (!bySku.has(li.sku)) bySku.set(li.sku, { sku: li.sku, name: li.name || li.sku, buyers: new Set() })
          if (o.email) bySku.get(li.sku).buyers.add(o.email.toLowerCase())
        }
      }
      if (data.length < PAGE) break
      from += PAGE
    }

    const products = [...bySku.values()]
      .map(p => ({ sku: p.sku, name: p.name, buyers: p.buyers.size }))
      .sort((a, b) => b.buyers - a.buyers)
    res.json({ products })
  } catch (error) {
    console.error('Error listing WooCommerce products:', error)
    res.status(500).json({ error: error.message })
  }
})

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
 * List Salesforce sobjects matching known marketing/email activity patterns.
 * Helps detect Marketing Cloud Connect (et4ae5__*), Pardot (pi__*), and
 * any email-related standard/custom objects present in the org.
 */
app.get('/api/salesforce/list-objects', async (req, res) => {
  try {
    const { clientId, filter } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const conn = await getSalesforceConnection(clientId)
    const global = await conn.describeGlobal()

    const matchers = [
      { label: 'Marketing Cloud Connect (et4ae5)', test: (n) => n.toLowerCase().startsWith('et4ae5__') },
      { label: 'Pardot (pi)', test: (n) => n.toLowerCase().startsWith('pi__') },
      { label: 'Email / Activity', test: (n) => /email|activity|engagement|task/i.test(n) },
    ]

    const grouped = {}
    for (const m of matchers) grouped[m.label] = []

    for (const obj of global.sobjects) {
      for (const m of matchers) {
        if (m.test(obj.name)) {
          grouped[m.label].push({
            name: obj.name,
            label: obj.label,
            custom: obj.custom,
            queryable: obj.queryable,
          })
          break
        }
      }
    }

    // Optional row counts for MC Connect objects so we can see if there's real data
    const countCandidates = grouped['Marketing Cloud Connect (et4ae5)']
      .filter(o => o.queryable)
      .slice(0, 10)
    const counts = {}
    for (const o of countCandidates) {
      try {
        const r = await conn.query(`SELECT COUNT() FROM ${o.name}`)
        counts[o.name] = r.totalSize
      } catch (e) {
        counts[o.name] = `error: ${e.message}`
      }
    }

    res.json({ totalObjects: global.sobjects.length, grouped, rowCounts: counts, filter: filter || null })
  } catch (error) {
    console.error('Error listing Salesforce objects:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Diagnose Order/OrderItem access specifically.
 * OrderItem (label: "Order Product") requires:
 *  1. Orders feature enabled org-wide (Setup → Order Settings)
 *  2. Order object read permission on the Run As user
 *  3. OrderItem object read permission
 * Returns counts + sample rows + clear error messages for each check.
 */
app.get('/api/salesforce/diagnose-orders', async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const conn = await getSalesforceConnection(clientId)
    const results = {}

    const tryQuery = async (label, soql) => {
      try {
        const r = await conn.query(soql)
        return { ok: true, count: r.totalSize, sample: r.records.slice(0, 3) }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }

    const tryDescribe = async (objectName) => {
      try {
        const meta = await conn.sobject(objectName).describe()
        return { ok: true, fields: meta.fields.map(f => f.name) }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }

    results.order_describe = await tryDescribe('Order')
    results.orderitem_describe = await tryDescribe('OrderItem')
    results.pricebook_describe = await tryDescribe('Pricebook2')
    results.pricebookentry_describe = await tryDescribe('PricebookEntry')

    results.order_count = await tryQuery('Order count', 'SELECT COUNT() FROM Order')
    results.orderitem_count = await tryQuery('OrderItem count', 'SELECT COUNT() FROM OrderItem')
    results.pricebook_count = await tryQuery('Pricebook2 count', 'SELECT COUNT() FROM Pricebook2')
    results.pricebookentry_count = await tryQuery('PricebookEntry count', 'SELECT COUNT() FROM PricebookEntry')

    if (results.order_count.ok && results.order_count.count > 0) {
      results.order_sample = await tryQuery('Order sample', 'SELECT Id, Name, Status, TotalAmount, AccountId FROM Order LIMIT 3')
    }

    if (results.orderitem_count.ok && results.orderitem_count.count > 0) {
      results.orderitem_sample = await tryQuery('OrderItem sample', 'SELECT Id, OrderId, Quantity, UnitPrice, TotalPrice, Product2Id FROM OrderItem LIMIT 3')
    }

    // Diagnose likely root cause
    const diagnosis = []
    if (!results.order_describe.ok) {
      diagnosis.push('Order object is NOT accessible. The Run As user needs Read permission on the Order object (not just OrderItem).')
    }
    if (!results.orderitem_describe.ok) {
      diagnosis.push('OrderItem object is NOT accessible. Check that the permission set grants Read on OrderItem.')
    }
    if (results.order_describe.ok && results.order_count.ok && results.order_count.count === 0) {
      diagnosis.push('Order object is accessible but contains 0 records. Either Orders is not used in this org, or the feature is enabled but no orders exist yet.')
    }
    if (results.order_describe.ok && !results.order_count.ok) {
      if (results.order_count.error?.toLowerCase().includes('not supported')) {
        diagnosis.push('Orders feature is NOT enabled in this org. Go to Setup → Order Settings → check "Enable Orders".')
      } else {
        diagnosis.push(`Order query failed: ${results.order_count.error}`)
      }
    }
    if (diagnosis.length === 0 && results.orderitem_count.ok && results.orderitem_count.count === 0) {
      diagnosis.push('All permissions look correct but OrderItem has 0 records. The org may not use Salesforce Orders for purchases.')
    }
    if (diagnosis.length === 0 && results.orderitem_count.ok && results.orderitem_count.count > 0) {
      diagnosis.push('OrderItem is accessible and has data. Integration is ready.')
    }

    res.json({ diagnosis, results })
  } catch (error) {
    console.error('Error diagnosing orders:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Generate a human-readable markdown report of Salesforce data accessible
 * to the integration user. Designed to be shared with the client's SF admin
 * so they can confirm which objects/fields drive sample-request automations.
 */
app.get('/api/salesforce/access-report', async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const conn = await getSalesforceConnection(clientId)
    const global = await conn.describeGlobal()

    const allObjects = global.sobjects
      .filter(o => o.queryable)
      .map(o => ({ name: o.name, label: o.label, custom: o.custom }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const groups = {
      'Sample / Request / Opportunity': allObjects.filter(o => /sample|request|opportunity|quote|order/i.test(o.name)),
      'Marketing Cloud Connect (et4ae5)': allObjects.filter(o => o.name.toLowerCase().startsWith('et4ae5__')),
      'Pardot (pi)': allObjects.filter(o => o.name.toLowerCase().startsWith('pi__')),
      'Email / Activity / Task': allObjects.filter(o => /email|activity|engagement|task|campaign/i.test(o.name)),
      'Custom Objects': allObjects.filter(o => o.custom && !o.name.toLowerCase().startsWith('et4ae5__') && !o.name.toLowerCase().startsWith('pi__')),
    }

    const describeFields = async (name) => {
      try {
        const meta = await conn.sobject(name).describe()
        return meta.fields
          .filter(f => f.type !== 'address' && f.type !== 'location')
          .map(f => ({ name: f.name, label: f.label, type: f.type, custom: f.custom, picklistValues: f.picklistValues?.map(p => p.value) || [] }))
          .sort((a, b) => a.label.localeCompare(b.label))
      } catch (e) {
        return []
      }
    }

    const leadFields = await describeFields('Lead')
    const contactFields = await describeFields('Contact')

    const lines = []
    lines.push('# Salesforce Access Report')
    lines.push('')
    lines.push(`Generated: ${new Date().toISOString()}`)
    lines.push(`Total queryable sobjects visible to integration user: **${allObjects.length}** (of ${global.sobjects.length} total)`)
    lines.push('')
    lines.push('## Questions for the Salesforce Admin')
    lines.push('')
    lines.push('We want to trigger email automations based on sample-request activity. To do that correctly, we need to know where that data lives in your Salesforce org. Please help us answer:')
    lines.push('')
    lines.push('1. **Where is the "sample request stage" tracked?**')
    lines.push('   - A picklist field on the Lead/Contact (e.g., Status, or a custom field)?')
    lines.push('   - An Opportunity record with a StageName like "Sample Requested / Sample Sent / Follow-up"?')
    lines.push('   - A custom object (e.g., `Sample_Request__c` or similar)?')
    lines.push('')
    lines.push('2. **What are the possible stage values** (e.g., "Requested", "Shipped", "Delivered", "Follow-up Needed", "Converted to Sale")?')
    lines.push('')
    lines.push('3. **Which stage transitions should trigger an email?** For example: "When stage moves to Sample Shipped, send follow-up after 7 days."')
    lines.push('')
    lines.push('4. **Can the integration user be granted Read access to these objects/fields?** If the relevant object is a custom object or Opportunity, our integration user may not currently have permission to see it.')
    lines.push('')
    lines.push('5. **For logging AI-generated emails back to Salesforce**, which would you prefer:')
    lines.push('   - `Task` records (shows on Activity Timeline, standard pattern)')
    lines.push('   - `EmailMessage` records')
    lines.push('   - A custom object')
    lines.push('')
    lines.push('6. **Marketing Cloud Connect** appears to be installed (we see `et4ae5__*` fields on Lead/Contact). Is it still actively in use? If not, can we access historical email engagement data from `et4ae5__IndividualEmailResult__c`?')
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('## Objects visible to our integration user, grouped by relevance')
    lines.push('')
    for (const [label, objs] of Object.entries(groups)) {
      lines.push(`### ${label} (${objs.length})`)
      lines.push('')
      if (objs.length === 0) {
        lines.push('_None visible to integration user._')
      } else {
        for (const o of objs) {
          lines.push(`- \`${o.name}\` — ${o.label}${o.custom ? ' (custom)' : ''}`)
        }
      }
      lines.push('')
    }

    const renderFields = (fields) => {
      const out = []
      for (const f of fields) {
        const picklist = f.picklistValues.length ? ` — values: ${f.picklistValues.join(', ')}` : ''
        out.push(`- **${f.label}** \`${f.name}\` (${f.type})${f.custom ? ' [custom]' : ''}${picklist}`)
      }
      return out.join('\n')
    }

    lines.push('---')
    lines.push('')
    lines.push(`## Lead fields (${leadFields.length})`)
    lines.push('')
    lines.push(renderFields(leadFields))
    lines.push('')
    lines.push(`## Contact fields (${contactFields.length})`)
    lines.push('')
    lines.push(renderFields(contactFields))
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('## All queryable objects (alphabetical)')
    lines.push('')
    for (const o of allObjects) {
      lines.push(`- \`${o.name}\` — ${o.label}${o.custom ? ' (custom)' : ''}`)
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.send(lines.join('\n'))
  } catch (error) {
    console.error('Error generating Salesforce access report:', error)
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
      ? `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, CreatedDate, IsConverted, ConvertedDate, State, Country, Job_Funtion__c, Product_Classification__c FROM Lead WHERE Email != null AND LastModifiedDate > ${syncSince}`
      : `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, CreatedDate, IsConverted, ConvertedDate, State, Country, Job_Funtion__c, Product_Classification__c FROM Lead WHERE Email != null`

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
            salesforce_created_date: lead.CreatedDate || null,
            is_converted: lead.IsConverted ?? null,
            converted_date: lead.ConvertedDate || null,
            state: lead.State || null,
            country: lead.Country || null,
            job_function: lead.Job_Funtion__c || null,
            product_classification: lead.Product_Classification__c ? lead.Product_Classification__c.split(';').map(s => s.trim()).filter(Boolean) : null,
            updated_at: new Date().toISOString(),
          })
        }

        // Upsert in batches of BATCH_SIZE with individual retry fallback
        for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
          const chunk = batchRecords.slice(i, i + BATCH_SIZE)
          await upsertContactBatch(chunk, clientId)
        }

        totalSynced += batchRecords.length
        await addSourceCodeTags(batchRecords, clientId, 'lead')
        await checkAiFollowupEnrollment(batchRecords, clientId)

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

    // Sync Contacts — try with Account.Name first, fall back without if permission denied
    let contactsQuery
    const contactFieldsWithAccount = 'Id, Email, FirstName, LastName, Account.Name, Account.Type, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c'
    const contactFieldsWithout = 'Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c'
    let hasAccountAccess = true

    contactsQuery = syncSince
      ? `SELECT ${contactFieldsWithAccount} FROM Contact WHERE Email != null AND LastModifiedDate > ${syncSince}`
      : `SELECT ${contactFieldsWithAccount} FROM Contact WHERE Email != null`

    console.log(`📥 Querying Salesforce Contacts...`)

    try {
      let contacts
      try {
        contacts = await conn.query(contactsQuery)
      } catch (accountErr) {
        if (accountErr.message?.includes('Account') || accountErr.message?.includes('relationship')) {
          console.warn('⚠️ No access to Account relationship on Contact, falling back without Account.Name')
          hasAccountAccess = false
          contactsQuery = syncSince
            ? `SELECT ${contactFieldsWithout} FROM Contact WHERE Email != null AND LastModifiedDate > ${syncSince}`
            : `SELECT ${contactFieldsWithout} FROM Contact WHERE Email != null`
          contacts = await conn.query(contactsQuery)
        } else {
          throw accountErr
        }
      }
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
            company: hasAccountAccess ? ((contact.Account && contact.Account.Name) || null) : null,
            salesforce_id: contact.Id,
            record_type: 'contact',
            industry: contact.Industry__c || null,
            source_code: contact.Source_Code1__c || null,
            source_code_history: contact.Source_Code_History__c || null,
            salesforce_created_date: contact.CreatedDate || null,
            state: contact.MailingState || null,
            country: contact.MailingCountry || null,
            job_function: contact.Job_Function__c || null,
            product_classification: contact.Product_Classification__c ? contact.Product_Classification__c.split(';').map(s => s.trim()).filter(Boolean) : null,
            contact_type: contact.Type__c || null,
            account_type: contact.Account?.Type === 'Dealers' ? 'Dealer' : (contact.Account?.Type || null),
            updated_at: new Date().toISOString(),
          })
        }

        // Upsert in batches of BATCH_SIZE with individual retry fallback
        for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
          const chunk = batchRecords.slice(i, i + BATCH_SIZE)
          await upsertContactBatch(chunk, clientId)
        }

        totalSynced += batchRecords.length
        await addSourceCodeTags(batchRecords, clientId, 'contact')
        await checkAiFollowupEnrollment(batchRecords, clientId)

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
      query = `SELECT Id, Email, FirstName, LastName, Account.Name, Industry__c, Source_Code1__c, Source_Code_History__c, LastModifiedDate FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT ${recordLimit}`
    }

    let result
    try {
      result = await conn.query(query)
    } catch (err) {
      if (targetObject !== 'Lead' && (err.message?.includes('Account') || err.message?.includes('relationship'))) {
        query = `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, LastModifiedDate FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT ${recordLimit}`
        result = await conn.query(query)
      } else {
        throw err
      }
    }

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

// ============ SALESFORCE LOOKUP ENDPOINT ============

/**
 * Look up a specific email in Salesforce (Leads + Contacts + Campaign Memberships)
 */
app.get('/api/salesforce/lookup', async (req, res) => {
  try {
    const { clientId, email } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }
    if (!email) {
      return res.status(400).json({ error: 'email is required' })
    }

    const conn = await getSalesforceConnection(clientId)

    // Sanitize email to prevent SOQL injection (backslashes must be escaped before quotes)
    const sanitizedEmail = email.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

    // Query Leads and Contacts in parallel
    let contactQuery = `SELECT Id, Email, FirstName, LastName, Account.Name, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, LastModifiedDate FROM Contact WHERE Email = '${sanitizedEmail}'`
    const leadResult = await conn.query(`SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, CreatedDate, LastModifiedDate FROM Lead WHERE Email = '${sanitizedEmail}'`)
    let contactResult
    try {
      contactResult = await conn.query(contactQuery)
    } catch (err) {
      if (err.message?.includes('Account') || err.message?.includes('relationship')) {
        contactQuery = `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, LastModifiedDate FROM Contact WHERE Email = '${sanitizedEmail}'`
        contactResult = await conn.query(contactQuery)
      } else {
        throw err
      }
    }

    const leads = (leadResult.records || []).map(r => ({
      type: 'Lead',
      id: r.Id,
      email: r.Email,
      firstName: r.FirstName,
      lastName: r.LastName,
      company: r.Company,
      industry: r.Industry,
      sourceCode: r.Source_code__c,
      sourceCodeHistory: r.Source_Code_History__c,
      createdDate: r.CreatedDate,
      lastModifiedDate: r.LastModifiedDate,
    }))

    const contacts = (contactResult.records || []).map(r => ({
      type: 'Contact',
      id: r.Id,
      email: r.Email,
      firstName: r.FirstName,
      lastName: r.LastName,
      company: (r.Account && r.Account.Name) || null,
      industry: r.Industry__c,
      sourceCode: r.Source_Code1__c,
      sourceCodeHistory: r.Source_Code_History__c,
      createdDate: r.CreatedDate,
      lastModifiedDate: r.LastModifiedDate,
    }))

    // Collect all IDs for campaign member lookup
    const leadIds = leads.map(l => l.id)
    const contactIds = contacts.map(c => c.id)

    let campaignMembers = []
    if (leadIds.length > 0 || contactIds.length > 0) {
      const conditions = []
      if (leadIds.length > 0) {
        conditions.push(`LeadId IN ('${leadIds.join("','")}')`)
      }
      if (contactIds.length > 0) {
        conditions.push(`ContactId IN ('${contactIds.join("','")}')`)
      }

      const cmResult = await conn.query(
        `SELECT Id, LeadId, ContactId, Status, CampaignId, Campaign.Name, Campaign.Type, Campaign.Status FROM CampaignMember WHERE ${conditions.join(' OR ')}`
      )

      campaignMembers = (cmResult.records || []).map(r => ({
        id: r.Id,
        leadId: r.LeadId,
        contactId: r.ContactId,
        memberStatus: r.Status,
        campaignId: r.CampaignId,
        campaignName: r.Campaign?.Name,
        campaignType: r.Campaign?.Type,
        campaignStatus: r.Campaign?.Status,
      }))
    }

    // Attach campaign memberships to each record
    const allRecords = [...leads, ...contacts].map(record => ({
      ...record,
      campaigns: campaignMembers.filter(cm =>
        (record.type === 'Lead' && cm.leadId === record.id) ||
        (record.type === 'Contact' && cm.contactId === record.id)
      ),
    }))

    res.json({
      email,
      totalResults: allRecords.length,
      records: allRecords,
    })
  } catch (error) {
    console.error('Error looking up Salesforce record:', error)
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
 * Full backfill — syncs ALL contacts/leads from Salesforce with no date filter.
 * Runs in the background so the HTTP response returns immediately.
 * Progress is tracked in clients.salesforce_sync_status / salesforce_sync_message.
 */
app.post('/api/salesforce/backfill', async (req, res) => {
  const { clientId } = req.body
  if (!clientId) return res.status(400).json({ error: 'clientId is required' })

  // Respond immediately — work happens in background
  res.json({ success: true, message: 'Backfill started in background' })

  ;(async () => {
    try {
      await supabase.from('clients').update({
        salesforce_sync_status: 'syncing',
        salesforce_sync_message: 'Full backfill starting...',
      }).eq('id', clientId)

      const conn = await getSalesforceConnection(clientId)
      let totalSynced = 0
      const syncStartTime = new Date().toISOString()
      const BATCH_SIZE = 100

      // Leads — no date filter
      const leadsQuery = `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, CreatedDate, IsConverted, ConvertedDate, State, Country, Job_Funtion__c, Product_Classification__c FROM Lead WHERE Email != null`
      let leads = await conn.query(leadsQuery)
      console.log(`🔄 Backfill: ${leads.totalSize} total leads`)

      while (true) {
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
            salesforce_created_date: lead.CreatedDate || null,
            is_converted: lead.IsConverted ?? null,
            converted_date: lead.ConvertedDate || null,
            state: lead.State || null,
            country: lead.Country || null,
            job_function: lead.Job_Funtion__c || null,
            product_classification: lead.Product_Classification__c ? lead.Product_Classification__c.split(';').map(s => s.trim()).filter(Boolean) : null,
            updated_at: new Date().toISOString(),
          })
        }
        for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
          await upsertContactBatch(batchRecords.slice(i, i + BATCH_SIZE), clientId)
        }
        totalSynced += batchRecords.length
        await addSourceCodeTags(batchRecords, clientId, 'lead')

        await supabase.from('clients').update({
          salesforce_sync_message: `Backfill in progress: ${totalSynced} records synced...`,
        }).eq('id', clientId)

        if (!leads.done && leads.nextRecordsUrl) {
          leads = await conn.queryMore(leads.nextRecordsUrl)
        } else break
      }

      // Contacts — no date filter
      let hasAccountAccess = true
      let contactsQuery = `SELECT Id, Email, FirstName, LastName, Account.Name, Account.Type, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c FROM Contact WHERE Email != null`
      let contacts
      try {
        contacts = await conn.query(contactsQuery)
      } catch (err) {
        if (err.message?.includes('Account') || err.message?.includes('relationship')) {
          hasAccountAccess = false
          contactsQuery = `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c FROM Contact WHERE Email != null`
          contacts = await conn.query(contactsQuery)
        } else throw err
      }
      console.log(`🔄 Backfill: ${contacts.totalSize} total contacts`)

      while (true) {
        const batchRecords = []
        for (const contact of contacts.records) {
          if (!contact.Email) continue
          batchRecords.push({
            client_id: clientId,
            email: contact.Email.toLowerCase().trim(),
            first_name: contact.FirstName || null,
            last_name: contact.LastName || null,
            company: hasAccountAccess ? ((contact.Account && contact.Account.Name) || null) : null,
            salesforce_id: contact.Id,
            record_type: 'contact',
            industry: contact.Industry__c || null,
            source_code: contact.Source_Code1__c || null,
            source_code_history: contact.Source_Code_History__c || null,
            salesforce_created_date: contact.CreatedDate || null,
            state: contact.MailingState || null,
            country: contact.MailingCountry || null,
            job_function: contact.Job_Function__c || null,
            product_classification: contact.Product_Classification__c ? contact.Product_Classification__c.split(';').map(s => s.trim()).filter(Boolean) : null,
            contact_type: contact.Type__c || null,
            account_type: contact.Account?.Type === 'Dealers' ? 'Dealer' : (contact.Account?.Type || null),
            updated_at: new Date().toISOString(),
          })
        }
        for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
          await upsertContactBatch(batchRecords.slice(i, i + BATCH_SIZE), clientId)
        }
        totalSynced += batchRecords.length
        await addSourceCodeTags(batchRecords, clientId, 'contact')

        await supabase.from('clients').update({
          salesforce_sync_message: `Backfill in progress: ${totalSynced} records synced...`,
        }).eq('id', clientId)

        if (!contacts.done && contacts.nextRecordsUrl) {
          contacts = await conn.queryMore(contacts.nextRecordsUrl)
        } else break
      }

      await supabase.from('clients').update({
        salesforce_sync_status: 'success',
        salesforce_sync_message: `Backfill complete: ${totalSynced} records synced`,
        salesforce_sync_count: totalSynced,
        last_salesforce_sync: syncStartTime,
      }).eq('id', clientId)

      console.log(`✅ Backfill complete: ${totalSynced} records`)
    } catch (err) {
      console.error('Backfill error:', err)
      await supabase.from('clients').update({
        salesforce_sync_status: 'error',
        salesforce_sync_message: `Backfill failed: ${err.message}`,
      }).eq('id', clientId)
    }
  })()
})

/**
 * Sync Salesforce Campaigns and Campaign Members
 * Syncs campaign members linked via LeadId or ContactId
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
    // Set campaign sync status to syncing
    await supabase
      .from('clients')
      .update({ campaign_sync_status: 'syncing', campaign_sync_message: 'Campaign sync starting...' })
      .eq('id', clientId)

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

      // 3. Get Campaign Members (Leads and Contacts)
      const membersQuery = `
        SELECT Id, LeadId, ContactId, Status
        FROM CampaignMember
        WHERE CampaignId = '${sfCampaign.Id}'
        AND (LeadId != null OR ContactId != null)
      `

      try {
        const membersResult = await conn.query(membersQuery)
        console.log(`  📥 Campaign "${sfCampaign.Name}": ${membersResult.totalSize} members`)

        if (membersResult.records.length === 0) continue

        // Get all Lead/Contact IDs from this campaign
        const leadIds = membersResult.records.map(m => m.LeadId || m.ContactId)

        // Batch lookup: find all matching contacts at once
        const { data: contacts } = await supabase
          .from('contacts')
          .select('id, salesforce_id, email')
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
          const contactId = contactMap.get(member.LeadId || member.ContactId)
          if (!contactId) continue // Lead/Contact not synced yet

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

        // Tag matched contacts with "Campaign: <name>"
        const matchedEmails = contacts?.filter(c => contactMap.has(c.salesforce_id)).map(c => c.email).filter(Boolean) || []
        await addCampaignTag(sfCampaign.Name, matchedEmails, clientId)

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

              const firstStepScheduledFor =
                firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
                  ? firstStep.fixed_send_at
                  : now

              // Batch create enrollments
              const enrollmentsToCreate = contactsToEnroll.map(contactId => ({
                sequence_id: sequence.id,
                contact_id: contactId,
                status: 'active',
                current_step: 0,
                trigger_campaign_id: campaign.id,
                next_email_scheduled_at: firstStepScheduledFor,
              }))

              let enrollmentsToSchedule = []

              const { data: createdEnrollments, error: enrollError } = await supabase
                .from('sequence_enrollments')
                .insert(enrollmentsToCreate)
                .select('id, contact_id')

              if (enrollError) {
                // If duplicate key error (another replica already enrolled), fetch existing enrollments
                if (enrollError.code === '23505') {
                  console.log(`ℹ️ Some contacts already enrolled by another process, fetching existing enrollments...`)
                  const { data: existingEnrollments } = await supabase
                    .from('sequence_enrollments')
                    .select('id, contact_id')
                    .eq('sequence_id', sequence.id)
                    .in('contact_id', contactsToEnroll)
                  enrollmentsToSchedule = existingEnrollments || []
                } else {
                  console.error('Error batch creating enrollments:', enrollError)
                  continue
                }
              } else {
                enrollmentsToSchedule = createdEnrollments || []
              }

              // Batch schedule first emails (unique constraint prevents duplicates)
              if (enrollmentsToSchedule.length > 0) {
                const emailsToSchedule = enrollmentsToSchedule.map(enrollment => ({
                  enrollment_id: enrollment.id,
                  step_id: firstStep.id,
                  contact_id: enrollment.contact_id,
                  scheduled_for: firstStepScheduledFor,
                  status: 'pending',
                }))

                const { error: scheduleError } = await supabase
                  .from('scheduled_emails')
                  .upsert(emailsToSchedule, {
                    onConflict: 'enrollment_id,step_id',
                    ignoreDuplicates: true
                  })

                if (scheduleError) {
                  console.error('Warning: Error scheduling emails (may be duplicates):', scheduleError.message)
                }
              }

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

    const summaryMsg = `Synced ${campaignsSynced} campaigns, ${membersSynced} members, ${newEnrollments} new enrollments`
    console.log(`✅ Salesforce Campaign sync complete: ${summaryMsg}`)

    await supabase
      .from('clients')
      .update({
        campaign_sync_status: 'success',
        campaign_sync_message: summaryMsg,
        last_campaign_sync: new Date().toISOString(),
      })
      .eq('id', clientId)
  } catch (error) {
    console.error('❌ Error syncing Salesforce campaigns:', error)
    await supabase
      .from('clients')
      .update({
        campaign_sync_status: 'error',
        campaign_sync_message: error.message || 'Campaign sync failed',
      })
      .eq('id', clientId)
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
    const firstStepScheduledFor =
      firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
        ? firstStep.fixed_send_at
        : now

    // Create enrollments and get IDs back atomically (prevents race condition)
    const enrollmentsToCreate = subscribedContactIds.map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      status: 'active',
      current_step: 0,
      enrolled_at: now,
      next_email_scheduled_at: firstStepScheduledFor,
    }))

    const { data: newEnrollments, error: enrollError } = await supabase
      .from('sequence_enrollments')
      .insert(enrollmentsToCreate)
      .select('id, contact_id')

    if (enrollError) throw enrollError

    // Schedule first emails with enrollment IDs (unique constraint prevents duplicates)
    if (newEnrollments && newEnrollments.length > 0) {
      const scheduledEmailsToCreate = newEnrollments.map(enrollment => ({
        enrollment_id: enrollment.id,
        step_id: firstStep.id,
        contact_id: enrollment.contact_id,
        scheduled_for: firstStepScheduledFor,
        status: 'pending',
        attempts: 0,
      }))

      // Use upsert with onConflict to prevent duplicates if constraint exists
      const { error: scheduleError } = await supabase
        .from('scheduled_emails')
        .upsert(scheduledEmailsToCreate, {
          onConflict: 'enrollment_id,step_id',
          ignoreDuplicates: true
        })

      if (scheduleError) {
        console.error('Warning: Error scheduling emails (may be duplicates):', scheduleError.message)
      }
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
    // Paginate through all events - Supabase caps at 1000 rows per request
    console.log(`   Step 1: Finding emails with analytics events (paginated)...`)
    const allEmails = new Set()
    let offset = 0
    const batchSize = 1000 // Supabase default limit

    while (true) {
      const { data: batch, error } = await supabase
        .from('analytics_events')
        .select('email')
        .order('email') // Ensure consistent ordering for pagination
        .range(offset, offset + batchSize - 1)

      if (error) throw error
      if (!batch || batch.length === 0) break

      batch.forEach(e => allEmails.add(e.email))
      console.log(`   Fetched batch ${Math.floor(offset / batchSize) + 1}: ${batch.length} events, ${allEmails.size} unique emails total`)
      offset += batchSize

      if (batch.length < batchSize) break // Last batch
    }

    console.log(`   Pagination complete: ${offset} total events scanned`)

    const uniqueEmails = Array.from(allEmails)
    console.log(`   Found ${uniqueEmails.length} unique emails with analytics events`)

    if (uniqueEmails.length === 0) {
      return res.json({ updated: 0, total: 0, message: 'No analytics events found' })
    }

    // Step 2: Get contacts for this client that match those emails
    // Batch the IN clause to avoid "Bad Request" with too many emails
    console.log(`   Step 2: Matching to contacts for this client...`)
    const contacts = []
    const emailBatchSize = 500 // Safe limit for IN clause

    for (let i = 0; i < uniqueEmails.length; i += emailBatchSize) {
      const emailBatch = uniqueEmails.slice(i, i + emailBatchSize)
      const { data: contactBatch, error: contactsError } = await supabase
        .from('contacts')
        .select('id, email')
        .eq('client_id', clientId)
        .in('email', emailBatch)

      if (contactsError) throw contactsError
      if (contactBatch) contacts.push(...contactBatch)
    }

    if (contacts.length === 0) {
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

            // Count unique URLs clicked
            const uniqueUrls = new Set(campClicks.map(c => c.url).filter(Boolean))
            const uniqueUrlCount = uniqueUrls.size

            // Bot detection:
            // 1. All clicks within 30 seconds = bot (security scanner burst)
            // 2. More than 5 unique URLs clicked = bot (humans click 1-3 links typically)
            const isTimeBurstBot = timeSpreadSeconds <= 30
            const isTooManyUrlsBot = uniqueUrlCount > 5

            if (isTimeBurstBot || isTooManyUrlsBot) {
              // Bot detected - don't count these clicks
              if (debugEmails.includes(contact.email)) {
                console.log(`   DEBUG ${contact.email}: BOT DETECTED (timeBurst=${isTimeBurstBot}, tooManyUrls=${isTooManyUrlsBot}) - setting clicks to 0`)
              }
            } else {
              // Human behavior - count unique URLs clicked
              humanClicks += uniqueUrlCount
              if (debugEmails.includes(contact.email)) {
                console.log(`   DEBUG ${contact.email}: HUMAN - counting ${uniqueUrlCount} unique URLs`)
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
    const { data: clientRaw, error: clientError } = await supabase
      .from('clients')
      .select('sendgrid_api_key')
      .eq('id', clientId)
      .single()

    if (clientError || !clientRaw) {
      return res.status(404).json({ error: 'Client not found' })
    }

    const client = decryptClient(clientRaw)
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
// BOUNCE RECOVERY ENDPOINTS
// View, recover, and re-send to hard-bounced contacts
// ============================================================

/**
 * Get hard bounce summary grouped by domain
 */
app.get('/api/bounces/summary', async (req, res) => {
  try {
    const { clientId } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('email, bounce_status, bounced_at')
      .eq('client_id', clientId)
      .eq('bounce_status', 'hard')

    if (error) throw error

    // Group by domain
    const domainCounts = {}
    for (const contact of contacts || []) {
      const domain = contact.email.split('@')[1]?.toLowerCase() || 'unknown'
      if (!domainCounts[domain]) {
        domainCounts[domain] = 0
      }
      domainCounts[domain]++
    }

    // Sort by count descending
    const domains = Object.entries(domainCounts)
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)

    res.json({
      totalHardBounces: contacts?.length || 0,
      domains,
    })
  } catch (error) {
    console.error('Error fetching bounce summary:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get hard-bounced contacts with optional domain filter
 */
app.get('/api/bounces/contacts', async (req, res) => {
  try {
    const { clientId, domain, page = 0, pageSize = 50 } = req.query

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' })
    }

    const pageNum = parseInt(page)
    const size = Math.min(parseInt(pageSize), 200)

    let query = supabase
      .from('contacts')
      .select('id, email, first_name, last_name, bounce_status, bounced_at, last_bounce_campaign_id, tags')
      .eq('client_id', clientId)
      .eq('bounce_status', 'hard')
      .order('bounced_at', { ascending: false })
      .range(pageNum * size, (pageNum + 1) * size - 1)

    const { data: contacts, error } = await query

    if (error) throw error

    // Filter by domain in JS (Supabase doesn't support LIKE on email easily via REST)
    let filtered = contacts || []
    if (domain) {
      filtered = filtered.filter(c => c.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`))
    }

    res.json({ contacts: filtered })
  } catch (error) {
    console.error('Error fetching bounced contacts:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Remove contacts from SendGrid suppression list and reset bounce status
 */
app.post('/api/bounces/recover', async (req, res) => {
  try {
    const { clientId, contactIds } = req.body

    if (!clientId || !contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'clientId and contactIds array are required' })
    }

    if (contactIds.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 contacts per recovery request' })
    }

    // Get client's SendGrid API key
    const { data: clientRaw, error: clientError } = await supabase
      .from('clients')
      .select('sendgrid_api_key')
      .eq('id', clientId)
      .single()

    if (clientError || !clientRaw) {
      return res.status(404).json({ error: 'Client not found' })
    }

    const client = decryptClient(clientRaw)

    // Get contact emails
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id, email')
      .in('id', contactIds)
      .eq('client_id', clientId)
      .eq('bounce_status', 'hard')

    if (contactsError) throw contactsError

    if (!contacts || contacts.length === 0) {
      return res.json({ recovered: 0, suppressionRemoved: 0, message: 'No matching hard-bounced contacts found' })
    }

    const emails = contacts.map(c => c.email.toLowerCase())
    console.log(`🔄 Recovering ${emails.length} hard-bounced contacts for client ${clientId}`)

    // Remove from SendGrid suppression list (bounces endpoint)
    let suppressionRemoved = 0
    for (const email of emails) {
      try {
        const deleteRes = await fetch(`https://api.sendgrid.com/v3/suppression/bounces/${encodeURIComponent(email)}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${client.sendgrid_api_key}`,
            'Content-Type': 'application/json',
          },
        })
        // 204 = success, 404 = not in suppression list (also fine)
        if (deleteRes.status === 204 || deleteRes.status === 404) {
          suppressionRemoved++
        } else {
          console.warn(`   ⚠️ Failed to remove ${email} from suppression: ${deleteRes.status}`)
        }
      } catch (err) {
        console.warn(`   ⚠️ Error removing ${email} from suppression:`, err.message)
      }
    }

    // Reset bounce status in database
    const ids = contacts.map(c => c.id)
    const { error: updateError } = await supabase
      .from('contacts')
      .update({
        bounce_status: 'none',
        bounced_at: null,
        last_bounce_campaign_id: null,
      })
      .in('id', ids)
      .eq('client_id', clientId)

    if (updateError) throw updateError

    console.log(`   ✅ Recovered ${contacts.length} contacts, removed ${suppressionRemoved} from SendGrid suppression`)

    res.json({
      recovered: contacts.length,
      suppressionRemoved,
      emails: emails,
      message: `Recovered ${contacts.length} contacts. Removed ${suppressionRemoved} from SendGrid suppression list.`,
    })
  } catch (error) {
    console.error('Error recovering bounces:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Send a test/recovery campaign to recovered contacts in controlled batches
 */
app.post('/api/bounces/send-recovery', async (req, res) => {
  try {
    const { clientId, contactIds, templateId, subject, batchSize = 100 } = req.body

    if (!clientId || !contactIds || !templateId || !subject) {
      return res.status(400).json({ error: 'clientId, contactIds, templateId, and subject are required' })
    }

    if (contactIds.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 contacts per recovery send' })
    }

    // Get client
    const { data: clientRaw, error: clientError } = await supabase
      .from('clients')
      .select('sendgrid_api_key, from_email, from_name, mailing_address, ip_pool')
      .eq('id', clientId)
      .single()

    if (clientError || !clientRaw) {
      return res.status(404).json({ error: 'Client not found' })
    }

    const client = decryptClient(clientRaw)

    // Get template
    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('html_content')
      .eq('id', templateId)
      .single()

    if (templateError || !template) {
      return res.status(404).json({ error: 'Template not found' })
    }

    // Get contacts (only those with bounce_status = 'none', meaning already recovered)
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id, email, first_name, last_name, unsubscribe_token, industry')
      .in('id', contactIds)
      .eq('client_id', clientId)
      .eq('bounce_status', 'none')
      .eq('unsubscribed', false)

    if (contactsError) throw contactsError

    if (!contacts || contacts.length === 0) {
      return res.json({ sent: 0, failed: 0, message: 'No eligible contacts to send to. Contacts must be recovered first.' })
    }

    // Get industry links
    const { data: industryLinks } = await supabase
      .from('industry_links')
      .select('industry, url')
      .eq('client_id', clientId)
    const industryLinkMap = new Map((industryLinks || []).map(l => [l.industry, l.url]))
    const defaultIndustryUrl = 'https://alconox.com/industries/'
    const baseUrl = process.env.BASE_URL || 'https://mail.sagerock.com'

    const recoverySgClient = require('@sendgrid/client')
    recoverySgClient.setApiKey(client.sendgrid_api_key)

    const htmlContent = template.html_content
      .replace(/\{\{mailing_address\}\}/g, client.mailing_address || '')

    let sentCount = 0
    let failedCount = 0
    const safeBatchSize = Math.min(parseInt(batchSize) || 100, 200)

    // Send in controlled batches
    for (let i = 0; i < contacts.length; i += safeBatchSize) {
      const batch = contacts.slice(i, i + safeBatchSize)

      const personalizations = batch.map(contact => {
        const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${contact.unsubscribe_token}`
        const industryLink = contact.industry
          ? (industryLinkMap.get(contact.industry) || defaultIndustryUrl)
          : defaultIndustryUrl

        return {
          to: [{ email: contact.email }],
          substitutions: {
            '{{email}}': contact.email,
            '{{first_name}}': contact.first_name || '',
            '{{last_name}}': contact.last_name || '',
            '{{unsubscribe_url}}': unsubscribeUrl,
            '{{industry_link}}': industryLink,
          },
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      })

      const requestBody = {
        personalizations,
        from: { email: client.from_email, name: client.from_name || '' },
        subject,
        content: [{ type: 'text/html', value: htmlContent }],
        categories: ['bounce-recovery'],
      }
      if (client.ip_pool) requestBody.ip_pool_name = client.ip_pool

      try {
        await recoverySgClient.request({ method: 'POST', url: '/v3/mail/send', body: requestBody })
        sentCount += batch.length
        console.log(`📧 Recovery batch ${Math.floor(i / safeBatchSize) + 1}: sent ${batch.length} emails`)
      } catch (err) {
        failedCount += batch.length
        console.error(`📧 Recovery batch FAILED:`, err.message || err)
      }
    }

    console.log(`✅ Recovery send complete: ${sentCount} sent, ${failedCount} failed`)

    res.json({
      sent: sentCount,
      failed: failedCount,
      total: contacts.length,
      message: `Sent ${sentCount} recovery emails (${failedCount} failed)`,
    })
  } catch (error) {
    console.error('Error sending recovery emails:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// STATIC FILE SERVING (Frontend)
// Serve the built React app from the dist folder
// This must come AFTER all API routes
// ============================================================

// ==========================================
// Public signup endpoint (AI for Business lead gen)
// Rate-limited, no auth required, triggers AI welcome email
// ==========================================
const publicSignupRateLimit = new Map() // IP -> { count, resetTime }

app.post('/api/public/signup', async (req, res) => {
  try {
    // Rate limiting: 5 requests per IP per 15 minutes
    const ip = req.ip || req.connection.remoteAddress
    const now = Date.now()
    const windowMs = 15 * 60 * 1000
    const maxRequests = 5

    const rateData = publicSignupRateLimit.get(ip) || { count: 0, resetTime: now + windowMs }
    if (now > rateData.resetTime) {
      rateData.count = 0
      rateData.resetTime = now + windowMs
    }
    rateData.count++
    publicSignupRateLimit.set(ip, rateData)

    if (rateData.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' })
    }

    // Validate input
    const { email, first_name, source } = req.body

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' })
    }

    if (!first_name || typeof first_name !== 'string' || first_name.trim().length === 0) {
      return res.status(400).json({ error: 'First name is required' })
    }

    const normalizedEmail = email.toLowerCase().trim()
    const cleanName = first_name.trim()
    const signupSource = (source || 'ai-for-business').trim()

    // Look up the default client for public signups
    const publicClientId = process.env.PUBLIC_SIGNUP_CLIENT_ID
    if (!publicClientId) {
      console.error('❌ PUBLIC_SIGNUP_CLIENT_ID not configured')
      return res.status(500).json({ error: 'Signup is not configured' })
    }

    // Check if contact already exists
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('*')
      .eq('client_id', publicClientId)
      .eq('email', normalizedEmail)
      .single()

    let contact
    let action
    const tags = ['ai-for-business', 'youtube-lead']

    if (existingContact) {
      // Merge tags, update name if blank
      const mergedTags = [...new Set([...(existingContact.tags || []), ...tags])]
      const { data: updated, error: updateError } = await supabase
        .from('contacts')
        .update({
          first_name: existingContact.first_name || cleanName,
          tags: mergedTags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingContact.id)
        .select()
        .single()

      if (updateError) throw updateError
      contact = updated
      action = 'updated'
      console.log(`📝 Public signup: updated contact ${normalizedEmail}`)
    } else {
      // Create new contact
      const { data: created, error: createError } = await supabase
        .from('contacts')
        .insert({
          client_id: publicClientId,
          email: normalizedEmail,
          first_name: cleanName,
          tags,
          unsubscribed: false,
        })
        .select()
        .single()

      if (createError) throw createError
      contact = created
      action = 'created'
      console.log(`✅ Public signup: created contact ${normalizedEmail}`)
    }

    // Send AI-generated welcome email (async, don't block the response)
    sendAiWelcomeEmail(contact, signupSource).catch(err => {
      console.error('❌ Failed to send AI welcome email:', err)
    })

    res.json({ success: true, action })
  } catch (error) {
    console.error('❌ Public signup error:', error)
    res.status(500).json({ error: 'Signup failed. Please try again.' })
  }
})

// ==========================================
// AWSNA 2026 booth resource signup
// Public, rate-limited. Captures the lead under the SageRock client,
// tags it for follow-up, and emails the booth PDF download links.
// The landing page also reveals the links instantly on success.
// ==========================================
const awsnaSignupRateLimit = new Map() // IP -> { count, resetTime }

const AWSNA_RESOURCES = [
  { title: 'The Waldorf Storytelling Calendar (Sept 2026 – Aug 2027)', url: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/awsna-2026/waldorf-storytelling-calendar-2026-2027.pdf' },
  { title: 'You Get the Families. We Handle the Rest.', url: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/awsna-2026/you-get-the-families.pdf' },
  { title: 'The Enrollment Audit', url: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/awsna-2026/enrollment-audit.pdf' },
  { title: 'SageRock Data Flow', url: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/awsna-2026/sagerock-data-flow.pdf' },
  { title: 'Iris: Technology Made Human', url: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/awsna-2026/iris-technology-made-human.pdf' },
  { title: 'Beyond the Classroom', url: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/awsna-2026/beyond-the-classroom.pdf' },
]

app.post('/api/public/awsna-signup', async (req, res) => {
  try {
    // Rate limiting: 8 requests per IP per 15 minutes (booth use, shared wifi)
    const ip = req.ip || req.connection.remoteAddress
    const now = Date.now()
    const windowMs = 15 * 60 * 1000
    const maxRequests = 8

    const rateData = awsnaSignupRateLimit.get(ip) || { count: 0, resetTime: now + windowMs }
    if (now > rateData.resetTime) {
      rateData.count = 0
      rateData.resetTime = now + windowMs
    }
    rateData.count++
    awsnaSignupRateLimit.set(ip, rateData)

    if (rateData.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' })
    }

    // Validate input (name optional, email required)
    const { email, first_name } = req.body

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' })
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' })
    }

    const normalizedEmail = email.toLowerCase().trim()
    const cleanName = (first_name && typeof first_name === 'string') ? first_name.trim() : null

    const publicClientId = process.env.PUBLIC_SIGNUP_CLIENT_ID
    if (!publicClientId) {
      console.error('❌ PUBLIC_SIGNUP_CLIENT_ID not configured')
      return res.status(500).json({ error: 'Signup is not configured' })
    }

    const tags = ['awsna-2026', 'conference-lead']

    // Upsert contact (merge tags if they already exist)
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('*')
      .eq('client_id', publicClientId)
      .eq('email', normalizedEmail)
      .single()

    let contact
    if (existingContact) {
      const mergedTags = [...new Set([...(existingContact.tags || []), ...tags])]
      const { data: updated, error: updateError } = await supabase
        .from('contacts')
        .update({
          first_name: existingContact.first_name || cleanName,
          tags: mergedTags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingContact.id)
        .select()
        .single()
      if (updateError) throw updateError
      contact = updated
      console.log(`📝 AWSNA signup: updated contact ${normalizedEmail}`)
    } else {
      const { data: created, error: createError } = await supabase
        .from('contacts')
        .insert({
          client_id: publicClientId,
          email: normalizedEmail,
          first_name: cleanName,
          tags,
          unsubscribed: false,
        })
        .select()
        .single()
      if (createError) throw createError
      contact = created
      console.log(`✅ AWSNA signup: created contact ${normalizedEmail}`)
    }

    // Email the resource links (best-effort, don't block the response)
    sendAwsnaResourcesEmail(contact).catch(err => {
      console.error('❌ Failed to send AWSNA resources email:', err)
    })

    // Return the links so the landing page can reveal them instantly
    res.json({ success: true, resources: AWSNA_RESOURCES })
  } catch (error) {
    console.error('❌ AWSNA signup error:', error)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

/**
 * Send the AWSNA booth resources email with download links.
 */
async function sendAwsnaResourcesEmail(contact) {
  const apiKey = process.env.CONTACT_SENDGRID_API_KEY
  if (!apiKey) {
    console.error('❌ CONTACT_SENDGRID_API_KEY not configured, skipping AWSNA email')
    return
  }
  sgMail.setApiKey(apiKey)

  const greeting = contact.first_name ? `Hi ${contact.first_name},` : 'Hi there,'

  const linkRows = AWSNA_RESOURCES.map(r => (
    `<tr><td style="padding:8px 0;border-bottom:1px solid #ece7da;">
       <a href="${r.url}" style="color:#58654d;font-weight:600;text-decoration:none;font-size:15px;">${r.title}</a>
       <div style="font-size:12px;color:#9a9483;margin-top:2px;">PDF · click to download</div>
     </td></tr>`
  )).join('')

  const textLinks = AWSNA_RESOURCES.map(r => `• ${r.title}\n  ${r.url}`).join('\n\n')

  const htmlBody = `
  <div style="background:#faf8f3;padding:28px 0;font-family:Georgia,'Source Serif 4',serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ece7da;border-radius:10px;padding:32px;">
      <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#c08a5e;font-family:Arial,sans-serif;">SageRock Schools · AWSNA 2026</div>
      <h1 style="font-size:24px;color:#3f4a35;margin:10px 0 16px;">Your booth resources</h1>
      <p style="font-size:15px;color:#444;line-height:1.6;font-family:Arial,sans-serif;">${greeting}</p>
      <p style="font-size:15px;color:#444;line-height:1.6;font-family:Arial,sans-serif;">Thanks for stopping by the SageRock booth. Here is everything we shared, yours to keep:</p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0;font-family:Arial,sans-serif;">${linkRows}</table>
      <p style="font-size:15px;color:#444;line-height:1.6;font-family:Arial,sans-serif;">Want us to look at your own enrollment funnel? Reply to this email or reach Rocky at <a href="mailto:rocky@sagerock.com" style="color:#58654d;">rocky@sagerock.com</a>. AWSNA attendees get our enrollment audit at half off, $1,250 instead of $2,500, through July 31.</p>
      <p style="font-size:15px;color:#444;line-height:1.6;font-family:Arial,sans-serif;margin-top:18px;">Warmly,<br>Sage &amp; the SageRock team</p>
    </div>
    <div style="max-width:560px;margin:14px auto 0;text-align:center;font-size:12px;color:#9a9483;font-family:Arial,sans-serif;">SageRock · sagerock.com/schools</div>
  </div>`

  const textBody = `${greeting}\n\nThanks for stopping by the SageRock booth at AWSNA 2026. Here are your resources:\n\n${textLinks}\n\nWant us to look at your enrollment funnel? Reply here or email rocky@sagerock.com. AWSNA attendees get our enrollment audit at half off, $1,250 instead of $2,500, through July 31.\n\nWarmly,\nSage & the SageRock team\nsagerock.com/schools`

  await sgMail.send({
    to: contact.email,
    bcc: [{ email: 'sage@sagerock.com' }],
    from: { email: 'sage@sagerock.com', name: 'Sage at SageRock' },
    replyTo: { email: 'rocky@sagerock.com', name: 'Rocky Lewis' },
    subject: 'Your SageRock booth resources (AWSNA 2026)',
    text: textBody,
    html: htmlBody,
  })

  console.log(`📧 AWSNA resources email sent to ${contact.email}`)
}

/**
 * Generate and send an AI-powered welcome email using Claude
 */
async function sendAiWelcomeEmail(contact, source) {
  const knowledgeBase = await loadKnowledgeBase(contact.client_id)

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not configured, skipping AI welcome email')
    return
  }

  const Anthropic = require('@anthropic-ai/sdk')
  const anthropic = new Anthropic()

  const systemPrompt = `You are Sage's AI assistant at SageRock. A new person just signed up for the AI for Business video series — a free course teaching business owners how to use AI to automate their business operations.

Your job is to write them a warm, personalized welcome email. Be conversational, friendly, and genuinely helpful — not salesy or corporate. Write like a real person, not a marketing bot.

Use the knowledge base below for accurate details about the series, links, and next steps.

IMPORTANT RULES:
- Return ONLY a JSON object with "subject" and "body" fields
- The body should be plain text (no HTML)
- Keep it concise: 3-4 short paragraphs max
- Sign off as "Sage's AI Assistant" or similar — be transparent that this is AI
- Include relevant links and next steps from the knowledge base
- Do NOT make up links, prices, or details not in the knowledge base

KNOWLEDGE BASE:
${knowledgeBase}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `New signup: ${contact.first_name} (${contact.email}). They signed up via: ${source}.`
    }],
  })

  // Parse the AI response
  const aiText = response.content[0].text
  let parsed
  try {
    const jsonMatch = aiText.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiText)
  } catch (e) {
    console.error('❌ Failed to parse AI welcome email response:', aiText)
    return
  }

  // Send via SendGrid
  const apiKey = process.env.CONTACT_SENDGRID_API_KEY
  if (!apiKey) {
    console.error('❌ CONTACT_SENDGRID_API_KEY not configured, cannot send welcome email')
    return
  }

  sgMail.setApiKey(apiKey)

  const htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${parsed.body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>')}</div>`

  // Route replies through SendGrid Inbound Parse so the AI can respond
  const replyToEmail = `ai+${contact.id}@reply.sagerock.com`

  await sgMail.send({
    to: contact.email,
    bcc: [{ email: 'sage@sagerock.com' }],
    from: { email: 'ai@sagerock.com', name: 'SageRock AI Assistant' },
    replyTo: { email: replyToEmail, name: 'SageRock AI Assistant' },
    subject: parsed.subject,
    text: parsed.body,
    html: htmlBody,
  })

  console.log(`🤖 AI welcome email sent to ${contact.email} (subject: "${parsed.subject}")`)

  // Log in email_conversations table (if it exists)
  try {
    await supabase.from('email_conversations').insert({
      client_id: contact.client_id,
      contact_id: contact.id,
      direction: 'outbound',
      subject: parsed.subject,
      body: parsed.body,
      ai_generated: true,
      escalated: false,
    })
  } catch (logErr) {
    // Table may not exist yet — don't fail the email send
    console.warn('⚠️ Could not log to email_conversations:', logErr.message)
  }
}

// ==========================================
// Contact form (landing page)
// ==========================================
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' })
    }

    const apiKey = process.env.CONTACT_SENDGRID_API_KEY
    if (!apiKey) {
      console.error('❌ CONTACT_SENDGRID_API_KEY not configured')
      return res.status(500).json({ error: 'Contact form is not configured' })
    }

    sgMail.setApiKey(apiKey)

    await sgMail.send({
      to: 'sage@sagerock.com',
      from: { email: 'sage@sagerock.com', name: 'SageRock Website' },
      replyTo: { email, name },
      subject: `SageRock Email Platform Inquiry from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
      html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><hr><p>${message.replace(/\n/g, '<br>')}</p>`,
    })

    console.log('📧 Contact form submission sent from:', email)
    res.json({ success: true })
  } catch (error) {
    console.error('❌ Contact form error:', error)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// ============================================================
// Knowledge Base Endpoints
// ============================================================

// List knowledge bases for a client
app.get('/api/knowledge-bases', async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const { data, error } = await supabase
      .from('knowledge_bases')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error fetching knowledge bases:', error)
    res.status(500).json({ error: error.message })
  }
})

// Create a knowledge base
app.post('/api/knowledge-bases', async (req, res) => {
  try {
    const { clientId, name, description, content, is_active } = req.body
    if (!clientId || !name) {
      return res.status(400).json({ error: 'clientId and name are required' })
    }

    // If setting this one as active, deactivate others first
    if (is_active) {
      await supabase
        .from('knowledge_bases')
        .update({ is_active: false })
        .eq('client_id', clientId)
    }

    const { data, error } = await supabase
      .from('knowledge_bases')
      .insert({
        client_id: clientId,
        name,
        description: description || null,
        content: content || '',
        is_active: is_active || false,
      })
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error creating knowledge base:', error)
    res.status(500).json({ error: error.message })
  }
})

// Update a knowledge base
app.put('/api/knowledge-bases/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, content, is_active, clientId } = req.body

    // If setting this one as active, deactivate others first
    if (is_active && clientId) {
      await supabase
        .from('knowledge_bases')
        .update({ is_active: false })
        .eq('client_id', clientId)
        .neq('id', id)
    }

    const updates = { updated_at: new Date().toISOString() }
    if (name !== undefined) updates.name = name
    if (description !== undefined) updates.description = description
    if (content !== undefined) updates.content = content
    if (is_active !== undefined) updates.is_active = is_active

    const { data, error } = await supabase
      .from('knowledge_bases')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error updating knowledge base:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete a knowledge base
app.delete('/api/knowledge-bases/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase
      .from('knowledge_bases')
      .delete()
      .eq('id', id)

    if (error) throw error
    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting knowledge base:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// AI Follow-up Agent Endpoints
// ============================================================

// Get all AI agent configs for a client
app.get('/api/ai-followup/configs', async (req, res) => {
  try {
    const { clientId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    const { data, error } = await supabase
      .from('ai_followup_config')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error fetching AI configs:', error)
    res.status(500).json({ error: error.message })
  }
})

// Create a new AI agent config
app.post('/api/ai-followup/configs', async (req, res) => {
  try {
    const { clientId, name, trigger_type, trigger_tag, from_email, from_name, reply_to, bcc_email, max_followups, followup_delays, system_prompt, log_to_salesforce, auto_send } = req.body
    if (!clientId || !name || !from_email || !from_name) {
      return res.status(400).json({ error: 'clientId, name, from_email, and from_name are required' })
    }

    const isWebhook = trigger_type === 'webhook'
    const webhookKey = isWebhook ? require('crypto').randomBytes(32).toString('hex') : null

    const { data, error } = await supabase
      .from('ai_followup_config')
      .insert({
        client_id: clientId,
        name,
        trigger_type: trigger_type || 'tag',
        trigger_tag: isWebhook ? null : (trigger_tag || 'Sample Request'),
        webhook_key: webhookKey,
        from_email,
        from_name,
        reply_to,
        bcc_email: bcc_email || null,
        max_followups: max_followups || 3,
        followup_delays: followup_delays || [1, 3, 7],
        system_prompt: system_prompt || null,
        log_to_salesforce: log_to_salesforce || false,
        auto_send: auto_send || false,
        enabled: false,
      })
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error creating AI config:', error)
    res.status(500).json({ error: error.message })
  }
})

// Update an AI agent config
app.put('/api/ai-followup/configs/:id', async (req, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    // Remove fields that shouldn't be directly updated
    delete updates.id
    delete updates.created_at
    delete updates.client_id

    // Auto-generate webhook key when switching to webhook trigger type
    if (updates.trigger_type === 'webhook' && !updates.webhook_key) {
      // Check if config already has a webhook key
      const { data: existing } = await supabase
        .from('ai_followup_config')
        .select('webhook_key')
        .eq('id', id)
        .single()
      if (!existing?.webhook_key) {
        updates.webhook_key = require('crypto').randomBytes(32).toString('hex')
      }
    }
    // Clear webhook key when switching to tag trigger
    if (updates.trigger_type === 'tag') {
      updates.webhook_key = null
    }

    const { data, error } = await supabase
      .from('ai_followup_config')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error updating AI config:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete an AI agent config
app.delete('/api/ai-followup/configs/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase
      .from('ai_followup_config')
      .delete()
      .eq('id', id)

    if (error) throw error
    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting AI config:', error)
    res.status(500).json({ error: error.message })
  }
})

// Generate an AI draft for a specific contact
app.post('/api/ai-followup/generate', async (req, res) => {
  try {
    const { contactId, configId } = req.body
    if (!contactId || !configId) {
      return res.status(400).json({ error: 'contactId and configId are required' })
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
    }

    // Fetch config
    const { data: config, error: configError } = await supabase
      .from('ai_followup_config')
      .select('*')
      .eq('id', configId)
      .single()
    if (configError) throw configError

    // Fetch contact
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single()
    if (contactError) throw contactError

    // Fetch the followup contact record (if enrolled)
    const { data: followupContact } = await supabase
      .from('ai_followup_contacts')
      .select('*')
      .eq('config_id', configId)
      .eq('contact_id', contactId)
      .single()

    const stepNumber = followupContact ? followupContact.current_step + 1 : 1

    // Fetch previous drafts for context
    const { data: previousDrafts } = await supabase
      .from('ai_followup_drafts')
      .select('step_number, subject, plain_text, status')
      .eq('config_id', configId)
      .eq('contact_id', contactId)
      .in('status', ['sent', 'approved'])
      .order('step_number', { ascending: true })

    // Build the AI prompt
    const Anthropic = require('@anthropic-ai/sdk')
    const anthropic = new Anthropic()

    const contactContext = [
      `Contact: ${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
      contact.email ? `Email: ${contact.email}` : null,
      contact.company ? `Company: ${contact.company}` : null,
      contact.industry ? `Industry: ${contact.industry}` : null,
      contact.source_code ? `Source: ${contact.source_code}` : null,
      `Follow-up #${stepNumber} of ${config.max_followups}`,
    ].filter(Boolean).join('\n')

    // Include form submission context if available
    let formContext = ''
    if (contact.form_submissions && contact.form_submissions.length > 0) {
      const latest = contact.form_submissions[contact.form_submissions.length - 1]
      const fieldEntries = Object.entries(latest.fields || {})
        .filter(([k]) => !['email'].includes(k.toLowerCase()))
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
      if (fieldEntries) {
        formContext = `\n\nForm submission (${latest.form_name || 'Web Form'}):\n${fieldEntries}`
      }
    }

    // Optionally inject an approved resource link (resource-nudge agents only).
    // Derives industry from the contact, or falls back to the latest form
    // submission's Industry field, then looks up the vetted industry_links URL.
    // This is the ONLY URL such agents are allowed to reference (no invented links).
    let resourceContext = ''
    if (config.include_resource_link) {
      const latestSub = contact.form_submissions?.length > 0
        ? contact.form_submissions[contact.form_submissions.length - 1]
        : null
      const industryName = contact.industry
        || latestSub?.fields?.Industry
        || latestSub?.fields?.industry
        || null
      let approvedResourceUrl = 'https://alconox.com/industries/'
      if (industryName) {
        const { data: il } = await supabase
          .from('industry_links')
          .select('link_url')
          .eq('client_id', config.client_id)
          .eq('industry', industryName)
          .maybeSingle()
        if (il?.link_url) approvedResourceUrl = il.link_url
      }
      resourceContext = `\n\nAPPROVED RESOURCE LINK (the ONLY URL you may include in the email; use it only when pointing the reader to resources, and never invent or guess any other URL):\n  ${approvedResourceUrl}`
    }

    let previousContext = ''
    if (previousDrafts && previousDrafts.length > 0) {
      previousContext = '\n\nPrevious emails sent to this contact:\n' +
        previousDrafts.map(d => `- Follow-up #${d.step_number}: Subject: "${d.subject}" | ${d.plain_text?.substring(0, 200) || '(no text)'}...`).join('\n')
    }

    const systemPrompt = config.system_prompt || `You are a friendly follow-up assistant. Your job is to write brief, professional follow-up emails. Keep emails under 150 words. Be warm and conversational, not salesy.`

    const userPrompt = `Write a follow-up email for this contact. Return ONLY a JSON object with "subject" and "body" fields. The body should be plain text (no HTML). Do not include any other text outside the JSON.

${contactContext}${formContext}${resourceContext}${previousContext}`

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    // Parse the AI response
    const aiText = response.content[0].text
    let parsed
    try {
      // Try to extract JSON from the response (handle markdown code blocks)
      const jsonMatch = aiText.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiText)
    } catch (e) {
      console.error('Failed to parse AI response:', aiText)
      return res.status(500).json({ error: 'Failed to parse AI response', raw: aiText })
    }

    // Convert plain text body to simple HTML
    const htmlContent = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${parsed.body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>')}</div>`

    // Insert the draft
    const { data: draft, error: draftError } = await supabase
      .from('ai_followup_drafts')
      .insert({
        followup_contact_id: followupContact?.id || null,
        contact_id: contactId,
        client_id: config.client_id,
        config_id: configId,
        step_number: stepNumber,
        subject: parsed.subject,
        html_content: htmlContent,
        plain_text: parsed.body,
        ai_model: 'claude-sonnet-4-6',
        ai_prompt_context: { contact: { first_name: contact.first_name, last_name: contact.last_name, company: contact.company, industry: contact.industry, source_code: contact.source_code }, step: stepNumber, previous_drafts_count: previousDrafts?.length || 0, form_submission: contact.form_submissions?.length > 0 ? contact.form_submissions[contact.form_submissions.length - 1] : null },
        status: 'pending',
      })
      .select()
      .single()

    if (draftError) throw draftError

    console.log(`🤖 AI draft generated for ${contact.email} (step ${stepNumber}) - config: ${config.name}`)

    // Auto-send: skip the approval queue when the agent is configured for it.
    // If the send fails, the draft stays 'pending' and falls back to the manual queue.
    if (config.auto_send) {
      try {
        const { messageId } = await sendAiFollowupDraft(draft.id, null)
        console.log(`🚀 Auto-sent AI draft to ${contact.email} (${config.name} step ${stepNumber})`)
        return res.json({ ...draft, status: 'sent', sendgrid_message_id: messageId, auto_sent: true })
      } catch (sendError) {
        console.error(`⚠️ Auto-send failed for draft ${draft.id} — left pending for manual review:`, sendError.message)
      }
    }

    res.json(draft)
  } catch (error) {
    console.error('Error generating AI draft:', error)
    res.status(500).json({ error: error.message })
  }
})

// ---- Re-engagement / sunset (Phase 1: report-only) ----

// List-health report: active / cold / protected breakdown for a client.
app.get('/api/reengagement/health', async (req, res) => {
  try {
    const clientId = req.query.clientId
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })
    const { data, error } = await supabase.rpc('reengagement_health', { p_client: clientId })
    if (error) throw error
    const { data: cfg } = await supabase
      .from('reengagement_config').select('*').eq('client_id', clientId).maybeSingle()
    res.json({ health: data, config: cfg || null })
  } catch (error) {
    console.error('Error fetching re-engagement health:', error)
    res.status(500).json({ error: error.message })
  }
})

// Manually re-run the classifier for a client (also runs daily via cron).
app.post('/api/reengagement/scan', async (req, res) => {
  try {
    const clientId = req.body?.clientId
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })
    const { data, error } = await supabase.rpc('reengagement_classify', { p_client: clientId })
    if (error) throw error
    res.json({ result: data })
  } catch (error) {
    console.error('Error running re-engagement scan:', error)
    res.status(500).json({ error: error.message })
  }
})

// List drafts for the approval queue
app.get('/api/ai-followup/drafts', async (req, res) => {
  try {
    const { clientId, status, configId } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    let query = supabase
      .from('ai_followup_drafts')
      .select(`
        *,
        contact:contacts(id, email, first_name, last_name, company, industry, salesforce_id),
        config:ai_followup_config(id, name, from_email, from_name, reply_to, bcc_email, log_to_salesforce)
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (configId) query = query.eq('config_id', configId)

    const { data, error } = await query
    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error fetching AI drafts:', error)
    res.status(500).json({ error: error.message })
  }
})

// Approve and send an AI draft
/**
 * Core send path for an AI follow-up draft — shared by the manual approve
 * endpoint and auto_send agents (send immediately on generation).
 * Validation problems throw with .statusCode and .validation = true so
 * callers can tell "bad state, don't mark failed" apart from real send errors.
 */
async function sendAiFollowupDraft(draftId, reviewedBy = null) {
  const fail = (statusCode, message) => {
    const err = new Error(message)
    err.statusCode = statusCode
    err.validation = true
    throw err
  }

  // Fetch the draft with config and contact info
  const { data: draft, error: draftError } = await supabase
    .from('ai_followup_drafts')
    .select(`
      *,
      contact:contacts(id, email, first_name, last_name, salesforce_id, unsubscribed),
      config:ai_followup_config(id, name, from_email, from_name, reply_to, bcc_email, log_to_salesforce, max_followups, followup_delays, client_id)
    `)
    .eq('id', draftId)
    .single()

  if (draftError) throw draftError
  if (!draft) fail(404, 'Draft not found')
  if (draft.status !== 'pending') fail(400, `Draft is already ${draft.status}`)
  if (draft.contact?.unsubscribed) fail(400, 'Contact has unsubscribed')

  // Fetch client SendGrid API key
  const { data: clientRaw } = await supabase
    .from('clients')
    .select('sendgrid_api_key')
    .eq('id', draft.client_id)
    .single()

  const client = decryptClient(clientRaw)
  if (!client?.sendgrid_api_key) {
    fail(400, 'Client does not have a SendGrid API key configured')
  }

  // Build unsubscribe URL
  const baseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || 'https://mail.sagerock.com'

  // Fetch the contact's unsubscribe token
  const { data: fullContact } = await supabase
    .from('contacts')
    .select('unsubscribe_token')
    .eq('id', draft.contact_id)
    .single()

  const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${fullContact?.unsubscribe_token || ''}`

  // Send via SendGrid
  sgMail.setApiKey(client.sendgrid_api_key)
  const msg = {
    to: draft.contact.email,
    from: { email: draft.config.from_email, name: draft.config.from_name },
    replyTo: draft.config.reply_to || undefined,
    bcc: draft.config.bcc_email ? [{ email: draft.config.bcc_email }] : undefined,
    subject: draft.subject,
    html: draft.html_content,
    text: draft.plain_text,
    customArgs: {
      ai_followup_draft_id: draft.id,
      ai_followup_config_id: draft.config_id,
    },
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }

  const [sgResponse] = await sgMail.send(msg)
  const messageId = sgResponse?.headers?.['x-message-id'] || null

  // Update draft status to sent
  const now = new Date().toISOString()
  await supabase
    .from('ai_followup_drafts')
    .update({
      status: 'sent',
      reviewed_by: reviewedBy || null,
      reviewed_at: now,
      sent_at: now,
      sendgrid_message_id: messageId,
    })
    .eq('id', draftId)

  // Update followup contact record
  if (draft.followup_contact_id) {
    const config = draft.config
    const nextStep = draft.step_number
    const isComplete = nextStep >= config.max_followups

    const contactUpdate = {
      current_step: nextStep,
      last_email_sent_at: now,
    }

    if (isComplete) {
      contactUpdate.status = 'completed'
      contactUpdate.completed_at = now
      contactUpdate.next_followup_at = null
    } else {
      // Calculate next followup time
      const delayDays = config.followup_delays[nextStep] || config.followup_delays[config.followup_delays.length - 1] || 7
      const nextDate = new Date()
      nextDate.setDate(nextDate.getDate() + delayDays)
      contactUpdate.next_followup_at = nextDate.toISOString()
    }

    await supabase
      .from('ai_followup_contacts')
      .update(contactUpdate)
      .eq('id', draft.followup_contact_id)
  }

  // Salesforce Task write-back (non-blocking)
  if (draft.config.log_to_salesforce && draft.contact.salesforce_id) {
    try {
      const taskResult = await createSalesforceTask(draft.client_id, {
        whoId: draft.contact.salesforce_id,
        subject: `AI Follow-up: ${draft.subject}`,
        description: `Automated follow-up email sent via AI Agent "${draft.config.name}".\n\nStep ${draft.step_number} of ${draft.config.max_followups}.\n\n${draft.plain_text}`,
      })
      if (taskResult?.id) {
        await supabase
          .from('ai_followup_drafts')
          .update({ salesforce_task_id: taskResult.id })
          .eq('id', draftId)
      }
    } catch (sfError) {
      console.error('⚠️ SF Task creation failed (non-blocking):', sfError.message)
    }
  }

  return { draft, messageId }
}

app.post('/api/ai-followup/drafts/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    const { reviewedBy } = req.body

    const { draft, messageId } = await sendAiFollowupDraft(id, reviewedBy || null)

    console.log(`✅ AI draft approved and sent to ${draft.contact.email} (${draft.config.name} step ${draft.step_number})`)
    res.json({ success: true, messageId })
  } catch (error) {
    console.error('Error approving AI draft:', error)
    if (error.validation) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    // Update draft as failed
    await supabase
      .from('ai_followup_drafts')
      .update({ status: 'failed', error_message: error.message })
      .eq('id', req.params.id)
    res.status(500).json({ error: error.message })
  }
})

// Reject an AI draft
app.post('/api/ai-followup/drafts/:id/reject', async (req, res) => {
  try {
    const { id } = req.params
    const { rejectionReason, regenerate, reviewedBy } = req.body

    const now = new Date().toISOString()
    const { data: draft, error } = await supabase
      .from('ai_followup_drafts')
      .update({
        status: 'rejected',
        rejection_reason: rejectionReason || null,
        reviewed_by: reviewedBy || null,
        reviewed_at: now,
      })
      .eq('id', id)
      .select('*, config:ai_followup_config(id, name)')
      .single()

    if (error) throw error

    console.log(`❌ AI draft rejected for config "${draft.config?.name}" - reason: ${rejectionReason || 'none'}`)

    // Optionally regenerate
    if (regenerate) {
      // Trigger generation of a new draft (reuse the generate endpoint logic)
      const generateRes = await fetch(`http://localhost:${PORT}/api/ai-followup/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: draft.contact_id, configId: draft.config_id }),
      })
      const newDraft = await generateRes.json()
      return res.json({ success: true, regenerated: true, newDraft })
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Error rejecting AI draft:', error)
    res.status(500).json({ error: error.message })
  }
})

// Edit an AI draft
app.put('/api/ai-followup/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { subject, html_content, plain_text } = req.body

    const updates = {}
    if (subject !== undefined) updates.subject = subject
    if (html_content !== undefined) updates.html_content = html_content
    if (plain_text !== undefined) updates.plain_text = plain_text

    const { data, error } = await supabase
      .from('ai_followup_drafts')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error updating AI draft:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get sent AI emails with aggregated analytics
app.get('/api/ai-followup/sent-emails', async (req, res) => {
  try {
    const { clientId, configId, search, startDate, endDate } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    let query = supabase
      .from('ai_followup_drafts')
      .select(`
        id, subject, step_number, sent_at, sendgrid_message_id, plain_text, html_content, ai_prompt_context, status,
        contact:contacts(id, email, first_name, last_name, company),
        config:ai_followup_config(id, name, from_email, from_name)
      `)
      .eq('client_id', clientId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(200)

    if (configId) query = query.eq('config_id', configId)
    if (startDate) query = query.gte('sent_at', startDate)
    if (endDate) query = query.lte('sent_at', endDate)

    const { data: drafts, error } = await query
    if (error) throw error

    // Fetch aggregated analytics for all returned draft IDs
    const draftIds = (drafts || []).map(d => d.id)
    if (draftIds.length > 0) {
      const { data: analytics } = await supabase
        .from('ai_followup_analytics')
        .select('draft_id, event_type')
        .in('draft_id', draftIds)

      const countsMap = {}
      for (const evt of (analytics || [])) {
        if (!countsMap[evt.draft_id]) countsMap[evt.draft_id] = {}
        countsMap[evt.draft_id][evt.event_type] = (countsMap[evt.draft_id][evt.event_type] || 0) + 1
      }

      for (const draft of drafts) {
        draft.analytics = countsMap[draft.id] || {}
      }
    }

    // Apply search filter in-memory
    let result = drafts || []
    if (search) {
      const s = search.toLowerCase()
      result = result.filter(d =>
        d.contact?.email?.toLowerCase().includes(s) ||
        d.contact?.first_name?.toLowerCase().includes(s) ||
        d.contact?.last_name?.toLowerCase().includes(s) ||
        d.contact?.company?.toLowerCase().includes(s) ||
        d.subject?.toLowerCase().includes(s)
      )
    }

    res.json(result)
  } catch (error) {
    console.error('Error fetching sent AI emails:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get detailed analytics events for a single AI draft
app.get('/api/ai-followup/drafts/:id/analytics', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ai_followup_analytics')
      .select('*')
      .eq('draft_id', req.params.id)
      .order('timestamp', { ascending: true })
    if (error) throw error
    res.json(data || [])
  } catch (error) {
    console.error('Error fetching AI draft analytics:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get pipeline contacts for a client
app.get('/api/ai-followup/contacts', async (req, res) => {
  try {
    const { clientId, configId, status } = req.query
    if (!clientId) return res.status(400).json({ error: 'clientId is required' })

    let query = supabase
      .from('ai_followup_contacts')
      .select(`
        *,
        contact:contacts(id, email, first_name, last_name, company, industry),
        config:ai_followup_config(id, name)
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })

    if (configId) query = query.eq('config_id', configId)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error
    res.json(data)
  } catch (error) {
    console.error('Error fetching AI pipeline contacts:', error)
    res.status(500).json({ error: error.message })
  }
})

// Manually enroll a contact in an AI agent
app.post('/api/ai-followup/enroll', async (req, res) => {
  try {
    const { contactId, configId } = req.body
    if (!contactId || !configId) {
      return res.status(400).json({ error: 'contactId and configId are required' })
    }

    const { data: config } = await supabase
      .from('ai_followup_config')
      .select('*')
      .eq('id', configId)
      .single()

    if (!config) return res.status(404).json({ error: 'AI agent config not found' })

    const delayDays = config.followup_delays[0] || 1
    const nextDate = new Date()
    nextDate.setDate(nextDate.getDate() + delayDays)

    const { data, error } = await supabase
      .from('ai_followup_contacts')
      .upsert({
        config_id: configId,
        contact_id: contactId,
        client_id: config.client_id,
        status: 'in_progress',
        current_step: 0,
        next_followup_at: nextDate.toISOString(),
      }, { onConflict: 'config_id,contact_id' })
      .select()
      .single()

    if (error) throw error
    console.log(`📥 Contact ${contactId} enrolled in AI agent "${config.name}"`)
    res.json(data)
  } catch (error) {
    console.error('Error enrolling contact:', error)
    res.status(500).json({ error: error.message })
  }
})

// Salesforce Task write-back helper
async function createSalesforceTask(clientId, { whoId, subject, description }) {
  const conn = await getSalesforceConnection(clientId)
  const result = await conn.sobject('Task').create({
    WhoId: whoId,
    Subject: subject,
    Description: description,
    Status: 'Completed',
    ActivityDate: new Date().toISOString().split('T')[0],
    Type: 'Email',
  })
  return result
}

// AI Follow-up enrollment check (called after Salesforce sync)
async function checkAiFollowupEnrollment(batchRecords, clientId) {
  try {
    // Fetch all enabled AI configs for this client
    const { data: configs } = await supabase
      .from('ai_followup_config')
      .select('*')
      .eq('client_id', clientId)
      .eq('enabled', true)

    if (!configs || configs.length === 0) return

    for (const config of configs) {
      // Find contacts in batch that match the trigger tag
      const matchingEmails = batchRecords
        .filter(r => {
          const sourceCode = r.Source_code__c || r.Source_Code1__c || ''
          const sourceHistory = r.Source_Code_History__c || ''
          return sourceCode.includes(config.trigger_tag) || sourceHistory.includes(config.trigger_tag)
        })
        .map(r => r.Email?.toLowerCase())
        .filter(Boolean)

      if (matchingEmails.length === 0) continue

      // Look up contact IDs
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, email')
        .eq('client_id', clientId)
        .in('email', matchingEmails)

      if (!contacts || contacts.length === 0) continue

      // Check which are already enrolled
      const contactIds = contacts.map(c => c.id)
      const { data: existing } = await supabase
        .from('ai_followup_contacts')
        .select('contact_id')
        .eq('config_id', config.id)
        .in('contact_id', contactIds)

      const existingIds = new Set((existing || []).map(e => e.contact_id))
      const newContacts = contacts.filter(c => !existingIds.has(c.id))

      if (newContacts.length === 0) continue

      // Enroll new contacts
      const delayDays = config.followup_delays[0] || 1
      const nextDate = new Date()
      nextDate.setDate(nextDate.getDate() + delayDays)

      const enrollments = newContacts.map(c => ({
        config_id: config.id,
        contact_id: c.id,
        client_id: clientId,
        status: 'in_progress',
        current_step: 0,
        next_followup_at: nextDate.toISOString(),
      }))

      const { error: enrollError } = await supabase
        .from('ai_followup_contacts')
        .insert(enrollments)

      if (enrollError) {
        console.error(`⚠️ AI enrollment error for config "${config.name}":`, enrollError.message)
      } else {
        console.log(`🤖 AI agent "${config.name}": enrolled ${newContacts.length} new contacts`)
      }
    }
  } catch (error) {
    console.error('⚠️ AI followup enrollment check error:', error.message)
  }
}

// GET /api/media?clientId=X
// Returns merged list of S3 objects under the client's prefix plus discovered URLs.
app.get('/api/media', async (req, res) => {
  const clientId = req.query.clientId
  if (!clientId) return res.status(400).json({ error: 'clientId is required' })

  // Look up client prefix
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('s3_prefix')
    .eq('id', clientId)
    .single()
  if (clientErr) return res.status(500).json({ error: clientErr.message })
  if (!client?.s3_prefix) return res.json({ items: [], needs_setup: true })

  // List S3 objects under the prefix
  const prefix = client.s3_prefix.endsWith('/') ? client.s3_prefix : client.s3_prefix + '/'
  const s3Items = []
  let continuationToken = undefined
  let pageCount = 0
  try {
    do {
      const out = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }))
      for (const obj of out.Contents || []) {
        const basename = obj.Key.split('/').pop() || ''
        if (basename.startsWith('stripothumbnailurl')) continue
        s3Items.push({
          key: obj.Key,
          url: publicUrlForKey(obj.Key),
          filename: basename,
          size: obj.Size,
          last_modified: obj.LastModified,
          source: 's3',
        })
      }
      continuationToken = out.NextContinuationToken
      pageCount++
      if (pageCount > 5) {
        console.warn(`[media] ${clientId}: hit pagination cap (5 pages, ~5000 objects)`)
        break
      }
    } while (continuationToken)
  } catch (err) {
    console.error('[media] S3 list failed', err)
    return res.status(500).json({ error: 'S3 list failed: ' + (err.message || 'unknown') })
  }

  // Fetch discovered URLs and dedupe against S3 items
  const s3UrlSet = new Set(s3Items.map((i) => i.url))
  const { data: discovered, error: discErr } = await supabase
    .from('discovered_media_urls')
    .select('url, filename, last_scanned_at')
    .eq('client_id', clientId)
  if (discErr) return res.status(500).json({ error: discErr.message })

  const discoveredItems = (discovered || [])
    .filter((d) => !s3UrlSet.has(d.url))
    .map((d) => ({
      key: '',
      url: d.url,
      filename: d.filename || filenameFromUrl(d.url),
      size: null,
      last_modified: d.last_scanned_at,
      source: 'discovered',
    }))

  res.json({ items: [...s3Items, ...discoveredItems], needs_setup: false })
})

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) cb(null, true)
    else cb(new Error('Unsupported image type'))
  },
})

function safeFilename(name) {
  const path = require('node:path')
  const base = path.basename(name).toLowerCase()
  return base.replace(/[^a-z0-9.-]/g, '-').replace(/-+/g, '-').slice(0, 80) || 'image'
}

// POST /api/media/upload
// multipart/form-data with fields: clientId, file
app.post('/api/media/upload', mediaUpload.single('file'), async (req, res) => {
  const clientId = req.body.clientId
  if (!clientId) return res.status(400).json({ error: 'clientId is required' })
  if (!req.file) return res.status(400).json({ error: 'file is required' })

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('s3_prefix')
    .eq('id', clientId)
    .single()
  if (clientErr) return res.status(500).json({ error: clientErr.message })
  if (!client?.s3_prefix) {
    return res.status(400).json({ error: 'Client has no s3_prefix configured' })
  }

  const key = `${client.s3_prefix}/${Date.now()}-${safeFilename(req.file.originalname)}`
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }))
  } catch (err) {
    console.error('[media] upload failed', err)
    return res.status(500).json({ error: 'S3 upload failed' })
  }

  res.json({ key, url: publicUrlForKey(key) })
})

// multer error handler — catches file-too-large and bad mimetype
app.use('/api/media/upload', (err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message })
  next()
})

// DELETE /api/media?clientId=X&key=...
// Only allowed when key starts with the client's s3_prefix.
app.delete('/api/media', async (req, res) => {
  const clientId = req.query.clientId
  const key = req.query.key
  if (!clientId || !key) {
    return res.status(400).json({ error: 'clientId and key are required' })
  }

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('s3_prefix')
    .eq('id', clientId)
    .single()
  if (clientErr) return res.status(500).json({ error: clientErr.message })
  if (!client?.s3_prefix) {
    return res.status(400).json({ error: 'Client has no s3_prefix configured' })
  }

  const expectedPrefix = client.s3_prefix.endsWith('/') ? client.s3_prefix : client.s3_prefix + '/'
  if (!key.startsWith(expectedPrefix)) {
    return res.status(403).json({ error: 'Key is outside this client\'s prefix' })
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (err) {
    console.error('[media] delete failed', err)
    return res.status(500).json({ error: 'S3 delete failed' })
  }
  res.status(204).end()
})

// POST /api/media/scan
// Body: { clientId }
// Scans templates + sequence_steps HTML for image URLs and caches them.
app.post('/api/media/scan', async (req, res) => {
  const clientId = req.body.clientId
  if (!clientId) return res.status(400).json({ error: 'clientId is required' })
  try {
    const result = await scanClientHtml(supabase, clientId)
    res.json(result)
  } catch (err) {
    console.error('[media] scan failed', err)
    res.status(500).json({ error: err.message })
  }
})

// ---- Public unsubscribe endpoint (RFC 8058 one-click) ----
// MUST be registered BEFORE express.static and the SPA catch-all below.
// Gmail / Apple Mail / Outlook honor the `List-Unsubscribe-Post: One-Click`
// header by sending an HTTP POST to the List-Unsubscribe URL. Without this
// route that POST fell through to the SPA catch-all (which only matches GET),
// so it 404'd and the opt-out was silently lost — a CAN-SPAM problem and the
// cause of unsubscribes collapsing to ~0/month after ~late March 2026. The
// token rides in the query string of the List-Unsubscribe URL. The browser
// GET continues to fall through to the React confirm page, which records the
// opt-out client-side.
async function recordUnsubscribe(token, campaignId) {
  if (!token) return { ok: false, status: 400, message: 'Missing unsubscribe token.' }

  const { data: contact, error: lookupError } = await supabase
    .from('contacts')
    .select('id, email, client_id, unsubscribed')
    .eq('unsubscribe_token', token)
    .maybeSingle()

  if (lookupError) {
    console.error('❌ Unsubscribe lookup failed:', lookupError.message)
    return { ok: false, status: 500, message: 'Lookup failed.' }
  }
  if (!contact) return { ok: false, status: 404, message: 'Unknown unsubscribe token.' }

  // Idempotent: only write + log the first time so repeat POSTs don't pile up events.
  if (!contact.unsubscribed) {
    const nowIso = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('contacts')
      .update({ unsubscribed: true, unsubscribed_at: nowIso })
      .eq('unsubscribe_token', token)

    if (updateError) {
      console.error('❌ Unsubscribe update failed:', updateError.message)
      return { ok: false, status: 500, message: 'Could not record unsubscribe.' }
    }

    // Best-effort analytics event so opt-outs appear in campaign reporting again.
    try {
      await supabase.from('analytics_events').insert({
        campaign_id: campaignId || null,
        email: contact.email,
        event_type: 'unsubscribe',
        timestamp: nowIso,
      })
    } catch (analyticsError) {
      console.error('⚠️ Unsubscribe analytics log failed:', analyticsError.message)
    }
    console.log(`✅ Unsubscribed ${contact.email} via one-click (campaign ${campaignId || 'n/a'})`)
  }

  return { ok: true, status: 200, message: 'You have been unsubscribed.' }
}

// One-click POST (RFC 8058). Must return 2xx so the mail client reports success.
app.post('/unsubscribe', async (req, res) => {
  const token = req.query.token || req.body?.token
  const campaignId = req.query.campaign_id || req.body?.campaign_id || null
  const result = await recordUnsubscribe(token, campaignId)
  res.status(result.status).type('text/plain').send(result.message)
})

// Public token lookup for the in-body unsubscribe page. The browser cannot read
// the contacts table directly (RLS only permits authenticated admins), so the
// React page must go through the backend service key. Without this, a valid
// unsubscribe link renders "invalid or expired." Registered BEFORE the SPA
// catch-all so it isn't swallowed by the React router.
app.get('/unsubscribe-info', async (req, res) => {
  const token = req.query.token
  if (!token) return res.status(400).json({ error: 'Missing token.' })
  const { data, error } = await supabase
    .from('contacts')
    .select('id, email, unsubscribed')
    .eq('unsubscribe_token', token)
    .maybeSingle()
  if (error) {
    console.error('❌ unsubscribe-info lookup failed:', error.message)
    return res.status(500).json({ error: 'Lookup failed.' })
  }
  if (!data) return res.status(404).json({ error: 'Invalid or expired unsubscribe link.' })
  res.json({ id: data.id, email: data.email, unsubscribed: data.unsubscribed })
})

// Resubscribe (undo) by token — mirror of recordUnsubscribe, service-key path.
async function recordResubscribe(token) {
  if (!token) return { ok: false, status: 400, message: 'Missing token.' }
  const { data: contact, error: lookupError } = await supabase
    .from('contacts')
    .select('id, email, unsubscribed')
    .eq('unsubscribe_token', token)
    .maybeSingle()
  if (lookupError) {
    console.error('❌ Resubscribe lookup failed:', lookupError.message)
    return { ok: false, status: 500, message: 'Lookup failed.' }
  }
  if (!contact) return { ok: false, status: 404, message: 'Unknown token.' }
  if (contact.unsubscribed) {
    const { error: updateError } = await supabase
      .from('contacts')
      .update({ unsubscribed: false, unsubscribed_at: null })
      .eq('unsubscribe_token', token)
    if (updateError) {
      console.error('❌ Resubscribe update failed:', updateError.message)
      return { ok: false, status: 500, message: 'Could not resubscribe.' }
    }
    console.log(`✅ Resubscribed ${contact.email}`)
  }
  return { ok: true, status: 200, message: 'You have been resubscribed.' }
}

app.post('/resubscribe', async (req, res) => {
  const token = req.query.token || req.body?.token
  const result = await recordResubscribe(token)
  res.status(result.status).type('text/plain').send(result.message)
})

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
              .update({ status: 'failed', send_error: campaignError.message })
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
            .filter('tags', 'cs', `{"${triggerTag}"}`)

          if (!contacts || contacts.length === 0) continue

          const contactIds = contacts.map(c => c.id)

          // Get already enrolled contacts (chunked: contactIds can be large and
          // an unbounded .in() would overflow undici's 16 KB header limit)
          const { data: enrolled } = await inChunks(contactIds, 100, (batch) =>
            supabase
              .from('sequence_enrollments')
              .select('contact_id')
              .eq('sequence_id', sequence.id)
              .in('contact_id', batch))

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
          const firstStepScheduledFor =
            firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
              ? new Date(firstStep.fixed_send_at)
              : now

          // Create enrollments and get IDs back atomically (prevents race condition)
          const enrollments = newContactIds.map(contactId => ({
            sequence_id: sequence.id,
            contact_id: contactId,
            status: 'active',
            current_step: 0,
            next_email_scheduled_at: firstStepScheduledFor.toISOString(),
          }))

          let enrollmentsToSchedule = []

          const { data: newEnrollments, error: enrollError } = await supabase
            .from('sequence_enrollments')
            .insert(enrollments)
            .select('id, contact_id')

          if (enrollError) {
            // If duplicate key error (another replica already enrolled), fetch existing enrollments
            if (enrollError.code === '23505') {
              console.log(`ℹ️ Some contacts already enrolled by another process, fetching existing enrollments...`)
              const { data: existingEnrollments } = await inChunks(newContactIds, 100, (batch) =>
                supabase
                  .from('sequence_enrollments')
                  .select('id, contact_id')
                  .eq('sequence_id', sequence.id)
                  .in('contact_id', batch))
              enrollmentsToSchedule = existingEnrollments || []
            } else {
              console.error('❌ Error auto-enrolling contacts:', enrollError)
              continue
            }
          } else {
            enrollmentsToSchedule = newEnrollments || []
          }

          // Schedule first emails (unique constraint prevents duplicates)
          if (enrollmentsToSchedule.length > 0) {
            const scheduledEmails = enrollmentsToSchedule.map(enrollment => ({
              enrollment_id: enrollment.id,
              step_id: firstStep.id,
              contact_id: enrollment.contact_id,
              scheduled_for: firstStepScheduledFor.toISOString(),
              status: 'pending',
            }))

            const { error: scheduleError } = await supabase
              .from('scheduled_emails')
              .upsert(scheduledEmails, {
                onConflict: 'enrollment_id,step_id',
                ignoreDuplicates: true
              })

            if (scheduleError) {
              console.error('Warning: Error scheduling emails (may be duplicates):', scheduleError.message)
            }
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

      // Claim a BOUNDED batch of pending scheduled emails by flipping them to
      // 'processing'. This must be capped: PostgREST IGNORES .limit() on an
      // UPDATE, so the previous `.update(...).limit(50)` actually claimed ALL
      // pending rows (536 at peak) and returned every id. The follow-up
      // `.in('id', [536 uuids])` then built a ~21 KB request URL that undici
      // rejected with UND_ERR_HEADERS_OVERFLOW (max header size 16 KB) — the
      // batch reset to 'pending' and looped forever, so zero sequence emails
      // sent. LIMIT *does* work on SELECT, so we select a capped set of ids
      // first, then UPDATE only those.
      const CLAIM_BATCH = 100
      let claimedIds = null
      let claimError = null
      {
        const { data: candidateRows, error: candidateError } = await supabase
          .from('scheduled_emails')
          .select('id')
          .eq('status', 'pending')
          .lte('scheduled_for', now)
          .order('scheduled_for', { ascending: true })
          .limit(CLAIM_BATCH)

        if (candidateError) {
          claimError = candidateError
        } else if (candidateRows && candidateRows.length > 0) {
          // The trailing .eq('status','pending') keeps this atomic across
          // replicas: only rows another replica hasn't already grabbed are
          // updated and returned.
          const { data, error } = await supabase
            .from('scheduled_emails')
            .update({ status: 'processing' })
            .in('id', candidateRows.map(c => c.id))
            .eq('status', 'pending')
            .select('id')
          claimedIds = data
          claimError = error
        } else {
          claimedIds = []
        }
      }

      if (claimError) {
        console.error('❌ Error claiming scheduled emails:', claimError)
      } else if (claimedIds && claimedIds.length > 0) {

      // Fetch full details for the claimed emails using FLAT queries, then stitch
      // them together in JS. Each .in('id', ...) is bounded by CLAIM_BATCH above,
      // so no request URL approaches undici's 16 KB header limit. The assembled
      // objects keep the exact shape the processing loop below expects.
      let scheduledEmails = null
      let fetchError = null
      try {
        const { data: rawSched, error: e1 } = await supabase
          .from('scheduled_emails')
          .select('id, attempts, enrollment_id, step_id')
          .in('id', claimedIds.map(e => e.id))
        if (e1) throw e1

        const enrollmentIds = [...new Set((rawSched || []).map(r => r.enrollment_id).filter(Boolean))]
        const stepIds = [...new Set((rawSched || []).map(r => r.step_id).filter(Boolean))]

        const { data: enrollments, error: e2 } = await supabase
          .from('sequence_enrollments')
          .select('id, status, sequence_id, contact_id, trigger_campaign_id')
          .in('id', enrollmentIds)
        if (e2) throw e2

        const sequenceIds = [...new Set((enrollments || []).map(r => r.sequence_id).filter(Boolean))]
        const contactIds = [...new Set((enrollments || []).map(r => r.contact_id).filter(Boolean))]
        const campaignIds = [...new Set((enrollments || []).map(r => r.trigger_campaign_id).filter(Boolean))]

        const { data: sequences, error: e3 } = await supabase
          .from('email_sequences')
          .select('id, status, client_id, from_email, from_name, reply_to, total_completed')
          .in('id', sequenceIds)
        if (e3) throw e3

        const { data: contactRows, error: e4 } = await supabase
          .from('contacts')
          .select('id, email, first_name, last_name, unsubscribed, unsubscribe_token, industry')
          .in('id', contactIds)
        if (e4) throw e4

        const { data: steps, error: e5 } = await supabase
          .from('sequence_steps')
          .select('id, step_order, subject, template_id, html_content, sent_count')
          .in('id', stepIds)
        if (e5) throw e5

        let campaigns = []
        if (campaignIds.length > 0) {
          const { data: camps, error: e6 } = await supabase
            .from('salesforce_campaigns')
            .select('id, name, type')
            .in('id', campaignIds)
          if (e6) throw e6
          campaigns = camps || []
        }

        const seqById = new Map((sequences || []).map(s => [s.id, s]))
        const contactById = new Map((contactRows || []).map(c => [c.id, c]))
        const stepById = new Map((steps || []).map(s => [s.id, s]))
        const enrollmentById = new Map((enrollments || []).map(en => [en.id, en]))
        const campaignById = new Map(campaigns.map(c => [c.id, c]))

        scheduledEmails = (rawSched || []).map(r => {
          const enr = enrollmentById.get(r.enrollment_id)
          return {
            id: r.id,
            attempts: r.attempts,
            enrollment: enr ? {
              id: enr.id,
              status: enr.status,
              sequence: seqById.get(enr.sequence_id) || null,
              contact: contactById.get(enr.contact_id) || null,
              trigger_campaign: enr.trigger_campaign_id ? (campaignById.get(enr.trigger_campaign_id) || null) : null,
            } : null,
            step: stepById.get(r.step_id) || null,
          }
        }).filter(se => se.enrollment && se.enrollment.sequence && se.enrollment.contact && se.step)
      } catch (err) {
        fetchError = err
      }

      if (fetchError) {
        console.error('❌ Error fetching scheduled emails:', fetchError)
        // Reset claimed emails back to pending on error
        await supabase
          .from('scheduled_emails')
          .update({ status: 'pending' })
          .in('id', claimedIds.map(e => e.id))
      } else if (scheduledEmails && scheduledEmails.length > 0) {

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
          const { data: clientRaw } = await supabase
            .from('clients')
            .select('*')
            .eq('id', sequence.client_id)
            .single()

          const client = decryptClient(clientRaw)
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
            categories: [
              `sequence-${sequence.id}`,
              `sequence-step-${step.id}`,
              clientCategory(client),
            ].filter(Boolean),
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
            // now is an ISO string in this cron handler; wrap to Date for computeNextSendTime
            const scheduledFor = computeNextSendTime(nextStep, new Date(now))

            if (scheduledFor === null) {
              // Fixed-date step skipped (past or within 3-day minimum gap)
              console.log(`⏭️ Skipping fixed-date step ${nextStep.id} for enrollment ${enrollment.id}`)

              // Advance chain: look for the step after the skipped one
              const { data: stepAfterSkipped } = await supabase
                .from('sequence_steps')
                .select('*')
                .eq('sequence_id', sequence.id)
                .eq('step_order', nextStep.step_order + 1)
                .single()

              if (stepAfterSkipped) {
                // now is an ISO string in this cron handler; wrap to Date for computeNextSendTime
                const nextNextSendTime = computeNextSendTime(stepAfterSkipped, new Date(now))
                if (nextNextSendTime !== null) {
                  await supabase.from('scheduled_emails').upsert({
                    enrollment_id: enrollment.id,
                    step_id: stepAfterSkipped.id,
                    contact_id: contact.id,
                    scheduled_for: nextNextSendTime.toISOString(),
                    status: 'pending',
                  }, { onConflict: 'enrollment_id,step_id', ignoreDuplicates: true })

                  await supabase
                    .from('sequence_enrollments')
                    .update({
                      current_step: step.step_order,
                      last_email_sent_at: new Date().toISOString(),
                      next_email_scheduled_at: nextNextSendTime.toISOString(),
                    })
                    .eq('id', enrollment.id)
                } else {
                  // Skip chain is one level deep by design: if the step after the skipped step
                  // is also past/too-close, we complete the enrollment rather than scanning further.
                  // Step after skipped is also skipped — complete enrollment
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
                  await supabase
                    .from('email_sequences')
                    .update({ total_completed: sequence.total_completed + 1 })
                    .eq('id', sequence.id)
                }
              } else {
                // Skip chain is one level deep by design: if the step after the skipped step
                // is also past/too-close, we complete the enrollment rather than scanning further.
                // No step after skipped — complete enrollment
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
                await supabase
                  .from('email_sequences')
                  .update({ total_completed: sequence.total_completed + 1 })
                  .eq('id', sequence.id)
              }
            } else {
              // Normal scheduling (relative or future fixed-date)
              await supabase.from('scheduled_emails').upsert({
                enrollment_id: enrollment.id,
                step_id: nextStep.id,
                contact_id: contact.id,
                scheduled_for: scheduledFor.toISOString(),
                status: 'pending',
              }, { onConflict: 'enrollment_id,step_id', ignoreDuplicates: true })

              await supabase
                .from('sequence_enrollments')
                .update({
                  current_step: step.step_order,
                  last_email_sent_at: new Date().toISOString(),
                  next_email_scheduled_at: scheduledFor.toISOString(),
                })
                .eq('id', enrollment.id)
            }
          } else {
            // Sequence completed (no next step at all)
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

      } // end scheduledEmails check
      } // end claimedIds check

      // ============ PART 3: AI Follow-up draft generation ============
      // Find contacts that are due for their next follow-up and don't have a pending draft
      try {
        const { data: dueContacts } = await supabase
          .from('ai_followup_contacts')
          .select(`
            *,
            config:ai_followup_config(*)
          `)
          .eq('status', 'in_progress')
          .lte('next_followup_at', now)
          .limit(10) // Process up to 10 per minute to avoid rate limits

        if (dueContacts && dueContacts.length > 0) {
          for (const fc of dueContacts) {
            // Check if there's already a pending draft for this contact+config
            const { data: existingDraft } = await supabase
              .from('ai_followup_drafts')
              .select('id')
              .eq('followup_contact_id', fc.id)
              .eq('status', 'pending')
              .limit(1)

            if (existingDraft && existingDraft.length > 0) continue

            // Check if config is still enabled
            if (!fc.config?.enabled) continue

            // Generate a draft via internal call
            try {
              const generateUrl = `http://localhost:${PORT}/api/ai-followup/generate`
              const generateRes = await fetch(generateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactId: fc.contact_id, configId: fc.config_id }),
              })
              if (!generateRes.ok) {
                const err = await generateRes.json()
                console.error(`⚠️ AI draft generation failed for contact ${fc.contact_id}:`, err.error)
              }
            } catch (genError) {
              console.error(`⚠️ AI draft generation error:`, genError.message)
            }
          }
        }
      } catch (aiError) {
        console.error('⚠️ AI follow-up cron error:', aiError.message)
      }

    } catch (error) {
      console.error('❌ Cron job error:', error.message)
    }
  })

  console.log('✅ Cron job started (runs every minute) - processes scheduled campaigns, automation sequences, and AI follow-ups')

  // Daily re-engagement classification at 5:30 AM UTC (report-only; labels cold
  // contacts for enabled clients — does NOT change send behavior).
  cron.schedule('30 5 * * *', async () => {
    try {
      console.log('🔄 Running daily re-engagement classification...')
      const { error } = await supabase.rpc('reengagement_classify_all')
      if (error) throw error
      console.log('✅ Re-engagement classification complete')
    } catch (err) {
      console.error('❌ Re-engagement classification failed:', err.message)
    }
  })

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
            ? `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, CreatedDate, IsConverted, ConvertedDate, State, Country, Job_Funtion__c, Product_Classification__c FROM Lead WHERE Email != null AND LastModifiedDate > ${lastSync}`
            : `SELECT Id, Email, FirstName, LastName, Company, Industry, Source_code__c, Source_Code_History__c, CreatedDate, IsConverted, ConvertedDate, State, Country, Job_Funtion__c, Product_Classification__c FROM Lead WHERE Email != null`

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
                salesforce_created_date: lead.CreatedDate || null,
                is_converted: lead.IsConverted ?? null,
                converted_date: lead.ConvertedDate || null,
                state: lead.State || null,
                country: lead.Country || null,
                job_function: lead.Job_Funtion__c || null,
                product_classification: lead.Product_Classification__c ? lead.Product_Classification__c.split(';').map(s => s.trim()).filter(Boolean) : null,
                updated_at: new Date().toISOString(),
              })
            }

            for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
              const chunk = batchRecords.slice(i, i + BATCH_SIZE)
              await upsertContactBatch(chunk, client.id)
            }
            totalSynced += batchRecords.length
            await addSourceCodeTags(batchRecords, client.id, 'lead')
            await checkAiFollowupEnrollment(batchRecords, client.id)

            if (!leads.done && leads.nextRecordsUrl) {
              leads = await conn.queryMore(leads.nextRecordsUrl)
            } else {
              break
            }
          }

          // Sync Contacts — try with Account.Name, fall back without
          let cronContactsQuery
          let cronHasAccountAccess = true
          try {
            cronContactsQuery = lastSync
              ? `SELECT Id, Email, FirstName, LastName, Account.Name, Account.Type, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c FROM Contact WHERE Email != null AND LastModifiedDate > ${lastSync}`
              : `SELECT Id, Email, FirstName, LastName, Account.Name, Account.Type, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c FROM Contact WHERE Email != null`
            var contacts = await conn.query(cronContactsQuery)
          } catch (accountErr) {
            if (accountErr.message?.includes('Account') || accountErr.message?.includes('relationship')) {
              console.warn(`  ⚠️ No Account access for ${client.name}, falling back`)
              cronHasAccountAccess = false
              cronContactsQuery = lastSync
                ? `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c FROM Contact WHERE Email != null AND LastModifiedDate > ${lastSync}`
                : `SELECT Id, Email, FirstName, LastName, Industry__c, Source_Code1__c, Source_Code_History__c, CreatedDate, MailingState, MailingCountry, Job_Function__c, Product_Classification__c, Type__c FROM Contact WHERE Email != null`
              var contacts = await conn.query(cronContactsQuery)
            } else {
              throw accountErr
            }
          }
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
                company: cronHasAccountAccess ? ((contact.Account && contact.Account.Name) || null) : null,
                salesforce_id: contact.Id,
                record_type: 'contact',
                industry: contact.Industry__c || null,
                source_code: contact.Source_Code1__c || null,
                source_code_history: contact.Source_Code_History__c || null,
                salesforce_created_date: contact.CreatedDate || null,
                state: contact.MailingState || null,
                country: contact.MailingCountry || null,
                job_function: contact.Job_Function__c || null,
                product_classification: contact.Product_Classification__c ? contact.Product_Classification__c.split(';').map(s => s.trim()).filter(Boolean) : null,
                contact_type: contact.Type__c || null,
                account_type: contact.Account?.Type === 'Dealers' ? 'Dealer' : (contact.Account?.Type || null),
                updated_at: new Date().toISOString(),
              })
            }

            for (let i = 0; i < batchRecords.length; i += BATCH_SIZE) {
              const chunk = batchRecords.slice(i, i + BATCH_SIZE)
              await upsertContactBatch(chunk, client.id)
            }
            totalSynced += batchRecords.length
            await addSourceCodeTags(batchRecords, client.id, 'contact')
            await checkAiFollowupEnrollment(batchRecords, client.id)

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
          await supabase
            .from('clients')
            .update({ campaign_sync_status: 'syncing', campaign_sync_message: 'Daily auto-sync starting...' })
            .eq('id', client.id)
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

              // Get Campaign Members (Leads and Contacts)
              const membersQuery = `SELECT Id, LeadId, ContactId, Status FROM CampaignMember WHERE CampaignId = '${sfCampaign.Id}' AND (LeadId != null OR ContactId != null)`
              const membersResult = await conn.query(membersQuery)

              if (membersResult.records.length === 0) continue

              const leadIds = membersResult.records.map(m => m.LeadId || m.ContactId)
              const { data: contacts } = await supabase
                .from('contacts')
                .select('id, salesforce_id, email')
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
                const contactId = contactMap.get(member.LeadId || member.ContactId)
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

              // Tag matched contacts with "Campaign: <name>"
              const matchedEmails = contacts?.filter(c => contactMap.has(c.salesforce_id)).map(c => c.email).filter(Boolean) || []
              await addCampaignTag(sfCampaign.Name, matchedEmails, client.id)

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

                    const now = new Date()
                    const firstStepScheduledFor =
                      firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
                        ? new Date(firstStep.fixed_send_at)
                        : now
                    const enrollmentsToCreate = contactsToEnroll.map(contactId => ({
                      sequence_id: sequence.id,
                      contact_id: contactId,
                      status: 'active',
                      current_step: 0,
                      trigger_campaign_id: campaign.id,
                      next_email_scheduled_at: firstStepScheduledFor.toISOString(),
                    }))

                    let enrollmentsToSchedule = []

                    const { data: createdEnrollments, error: enrollError } = await supabase
                      .from('sequence_enrollments')
                      .insert(enrollmentsToCreate)
                      .select('id, contact_id')

                    if (enrollError) {
                      // If duplicate key error, fetch existing enrollments
                      if (enrollError.code === '23505') {
                        const { data: existingEnrolls } = await supabase
                          .from('sequence_enrollments')
                          .select('id, contact_id')
                          .eq('sequence_id', sequence.id)
                          .in('contact_id', contactsToEnroll)
                        enrollmentsToSchedule = existingEnrolls || []
                      }
                    } else {
                      enrollmentsToSchedule = createdEnrollments || []
                    }

                    if (enrollmentsToSchedule.length > 0) {
                      const emailsToSchedule = enrollmentsToSchedule.map(enrollment => ({
                        enrollment_id: enrollment.id,
                        step_id: firstStep.id,
                        contact_id: enrollment.contact_id,
                        scheduled_for: firstStepScheduledFor.toISOString(),
                        status: 'pending',
                      }))

                      // Use upsert to prevent duplicates
                      await supabase.from('scheduled_emails').upsert(emailsToSchedule, {
                        onConflict: 'enrollment_id,step_id',
                        ignoreDuplicates: true
                      })

                      if (!enrollError) {
                        await supabase
                          .from('email_sequences')
                          .update({ total_enrolled: sequence.total_enrolled + enrollmentsToSchedule.length })
                          .eq('id', sequence.id)

                        newEnrollments += enrollmentsToSchedule.length
                      }
                    }
                  }
                }
              }
            }
            const campaignSummary = `Synced ${campaignsSynced} campaigns, ${membersSynced} members, ${newEnrollments} new enrollments`
            console.log(`  ✅ Campaigns: ${campaignSummary}`)
            await supabase
              .from('clients')
              .update({
                campaign_sync_status: 'success',
                campaign_sync_message: campaignSummary,
                last_campaign_sync: new Date().toISOString(),
              })
              .eq('id', client.id)
          } catch (campaignError) {
            console.error(`  ⚠️ Campaign sync error for ${client.name}:`, campaignError.message)
            await supabase
              .from('clients')
              .update({
                campaign_sync_status: 'error',
                campaign_sync_message: campaignError.message || 'Campaign sync failed',
              })
              .eq('id', client.id)
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

  // Daily WooCommerce sync — 30 min after Salesforce so the two don't overlap.
  cron.schedule('30 6 * * *', async () => {
    console.log('🔄 Starting daily WooCommerce sync...')
    try {
      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, name, woocommerce_consumer_key')
        .not('woocommerce_consumer_key', 'is', null)

      if (error) {
        console.error('❌ Error fetching clients for WooCommerce sync:', error.message)
        return
      }
      if (!clients || clients.length === 0) {
        console.log('📭 No clients with WooCommerce connected')
        return
      }

      console.log(`📋 Found ${clients.length} client(s) with WooCommerce connected`)
      for (const client of clients) {
        try {
          await supabase
            .from('clients')
            .update({ woocommerce_sync_status: 'syncing', woocommerce_sync_message: 'Daily auto-sync starting...' })
            .eq('id', client.id)
          const { ordersSynced, contactsUpdated } = await runWooSync(client.id, false)
          console.log(`  ✅ ${client.name}: ${ordersSynced} order(s), ${contactsUpdated} contact(s) updated`)
        } catch (clientErr) {
          console.error(`  ❌ WooCommerce sync failed for ${client.name}:`, clientErr.message)
          await supabase
            .from('clients')
            .update({ woocommerce_sync_status: 'error', woocommerce_sync_message: clientErr.message })
            .eq('id', client.id)
        }
      }
      console.log('✅ Daily WooCommerce sync complete')
    } catch (error) {
      console.error('❌ Daily WooCommerce sync error:', error.message)
    }
  })

  console.log('✅ Daily WooCommerce sync cron job started (runs at 6:30 AM UTC)')
})

