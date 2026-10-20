'use strict'

// Client credentials stay on the server (migration 120, 2026-10-20).
//
// The browser roles no longer have SELECT/UPDATE on the secret columns of
// `clients` (SendGrid key, Salesforce consumer key/secret/tokens, WooCommerce
// consumer key/secret). The UI learns whether a credential is configured, and
// its last four characters, from GET /api/clients/:id/credentials, and a super
// admin sets the SendGrid key through PUT /api/clients/:id/sendgrid-key, which
// encrypts it the same way the Salesforce and WooCommerce connect routes do.
// Salesforce and WooCommerce credentials already had their own connect routes.

const CIPHERTEXT_RE = /^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Columns the browser roles may still read and write. Anything not listed here
// is invisible to the app, so a new column on `clients` must be added here AND
// to the grants in supabase/migrations/120_client_secret_columns.sql.
const SECRET_COLUMNS = [
  'sendgrid_api_key',
  'salesforce_client_id',
  'salesforce_client_secret',
  'salesforce_access_token',
  'salesforce_refresh_token',
  'woocommerce_consumer_key',
  'woocommerce_consumer_secret',
]

function isCiphertext(value) {
  return typeof value === 'string' && CIPHERTEXT_RE.test(value)
}

// Last four characters of the stored secret, decrypting when it is ciphertext.
// Returns null when nothing is stored or the value can't be decrypted.
function keyHint(value, { encryptionKey, decrypt } = {}) {
  if (!value || typeof value !== 'string') return null
  let plain = value
  if (isCiphertext(value)) {
    if (!encryptionKey || !decrypt) return null
    try {
      plain = decrypt(value, encryptionKey)
    } catch {
      return null
    }
  }
  if (plain.length < 8) return null
  return plain.slice(-4)
}

// SendGrid keys look like `SG.<22 chars>.<43 chars>`; accept that shape only.
function validateSendgridKey(input) {
  if (typeof input !== 'string') return { ok: false, error: 'apiKey must be a string' }
  const key = input.trim()
  if (!key) return { ok: false, error: 'apiKey is required' }
  if (/\s/.test(key)) return { ok: false, error: 'apiKey must not contain spaces' }
  if (!/^SG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128}$/.test(key)) {
    return { ok: false, error: 'That does not look like a SendGrid API key (SG.xxx.yyy)' }
  }
  return { ok: true, key }
}

// Super admins and admins see every client; a client admin only their own.
function canReadClient(adminUser, clientId) {
  if (!adminUser || !clientId) return false
  if (adminUser.role === 'super_admin' || adminUser.role === 'admin') return true
  if (adminUser.role === 'client_admin') return adminUser.client_id === clientId
  return false
}

function credentialSummary(row, { encryptionKey, decrypt } = {}) {
  const hintOf = v => keyHint(v, { encryptionKey, decrypt })
  return {
    sendgrid: {
      configured: Boolean(row.sendgrid_api_key),
      hint: hintOf(row.sendgrid_api_key),
      ip_pool: row.ip_pool || null,
    },
    salesforce: {
      configured: Boolean(row.salesforce_client_id && row.salesforce_client_secret),
      instance_url: row.salesforce_instance_url || null,
      connected_at: row.salesforce_connected_at || null,
    },
    woocommerce: {
      configured: Boolean(row.woocommerce_consumer_key && row.woocommerce_consumer_secret),
      url: row.woocommerce_url || null,
      connected_at: row.woocommerce_connected_at || null,
    },
  }
}

const SUMMARY_COLUMNS = [
  'id', 'sendgrid_api_key', 'ip_pool',
  'salesforce_client_id', 'salesforce_client_secret', 'salesforce_instance_url', 'salesforce_connected_at',
  'woocommerce_consumer_key', 'woocommerce_consumer_secret', 'woocommerce_url', 'woocommerce_connected_at',
].join(', ')

function register(app, { supabase, authenticateUser, requireSuperAdmin, encryptionKey, encrypt, decrypt }) {
  app.get('/api/clients/:id/credentials', authenticateUser, async (req, res) => {
    const clientId = req.params.id
    if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Invalid client id' })
    if (!canReadClient(req.adminUser, clientId)) return res.status(403).json({ error: 'Access denied to this client' })
    try {
      const { data, error } = await supabase.from('clients').select(SUMMARY_COLUMNS).eq('id', clientId).maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Client not found' })
      res.json(credentialSummary(data, { encryptionKey, decrypt }))
    } catch (err) {
      console.error('[client-credentials] summary failed:', err.message)
      res.status(500).json({ error: 'Failed to load credentials' })
    }
  })

  app.put('/api/clients/:id/sendgrid-key', authenticateUser, requireSuperAdmin, async (req, res) => {
    const clientId = req.params.id
    if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Invalid client id' })
    const check = validateSendgridKey(req.body?.apiKey)
    if (!check.ok) return res.status(400).json({ error: check.error })
    try {
      const stored = encryptionKey ? encrypt(check.key, encryptionKey) : check.key
      const { data, error } = await supabase
        .from('clients')
        .update({ sendgrid_api_key: stored })
        .eq('id', clientId)
        .select('id')
        .maybeSingle()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Client not found' })
      console.log(`[client-credentials] SendGrid key updated for client ${clientId} by ${req.user?.email || req.user?.id}`)
      res.json({ configured: true, hint: check.key.slice(-4) })
    } catch (err) {
      console.error('[client-credentials] key update failed:', err.message)
      res.status(500).json({ error: 'Failed to save SendGrid key' })
    }
  })
}

module.exports = {
  register,
  keyHint,
  validateSendgridKey,
  canReadClient,
  credentialSummary,
  isCiphertext,
  SECRET_COLUMNS,
}
