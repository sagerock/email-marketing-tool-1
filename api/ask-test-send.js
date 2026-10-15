// Ask/Jax campaign test sends (Sage, 2026-10-15).
//
// Jax on Ask may send a "[TEST]" copy of a DRAFT campaign to that client's
// named approvers, and nobody else. The approver list lives here in code, not
// in caller input or the database, so widening it takes a reviewed commit.
// There is no route here to schedule, send to an audience, or touch a
// campaign row; real sends still need a person.
//
// Every attempt is a row in ask_test_sends (migration 113): the audit trail,
// the retry guard (unique request_key + recipient) and the daily caps.
const { authorizedBearer } = require('./ask-email-design')

const SAGEROCK_REVIEWERS = {
  'sage@sagerock.com': 'Sage',
  'rocky@sagerock.com': 'Rocky',
}

const TEST_SEND_CLIENTS = {
  alconox: {
    id: 'ea7f1422-2d20-4299-85a7-c1201e953409',
    name: 'Alconox',
    approvers: {
      'ssilverstein@alconox.com': 'Stacy',
      'mmodica@alconox.com': 'Michelle',
      'mmoussourakis@alconox.com': 'Michael',
      'slewis@alconox.com': 'Sage',
      ...SAGEROCK_REVIEWERS,
    },
  },
  sagerock: {
    id: 'dab0af79-80db-4e91-854c-be1b5ccd7288',
    name: 'SageRock',
    approvers: { ...SAGEROCK_REVIEWERS },
  },
}

const MAX_RECIPIENTS = 6
const PER_RECIPIENT_DAILY = 5 // per campaign, rolling 24h
const PER_CAMPAIGN_DAILY = 20
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TEST_UNSUB_PATH = '/unsubscribe?token=TEST_TOKEN'

class AskTestSendError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function clientEntry(key) {
  const entry = TEST_SEND_CLIENTS[String(key || '').trim().toLowerCase()]
  if (!entry) {
    throw new AskTestSendError(`client must be one of: ${Object.keys(TEST_SEND_CLIENTS).join(', ')}`)
  }
  return entry
}

function clientById(id) {
  return Object.values(TEST_SEND_CLIENTS).find(c => c.id === id) || null
}

function validateTestSendRequest(body, idempotencyKey) {
  const campaignId = String(body?.campaignId || '').trim()
  const requestKey = String(idempotencyKey || '').trim()
  const raw = body?.recipients
  if (!UUID_RE.test(campaignId)) throw new AskTestSendError('campaignId must be a UUID')
  if (!requestKey || requestKey.length > 200) {
    throw new AskTestSendError('a valid Idempotency-Key header is required')
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RECIPIENTS) {
    throw new AskTestSendError(`recipients must list 1 to ${MAX_RECIPIENTS} addresses`)
  }
  const recipients = [...new Set(raw.map(r => String(r || '').trim().toLowerCase()))]
  return { campaignId, requestKey, recipients }
}

function appendUtmParams(html, params) {
  if (!params) return html
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
    if (url.includes('unsubscribe')) return match
    const separator = url.includes('?') ? '&' : '?'
    return `href="${url}${separator}${params}"`
  })
}

// Same message the UI's "Send test" builds, with the reviewer's real first
// name and the same test-only analytics tags (never campaign_id).
function buildTestMessage({ campaign, client, html, email, firstName, baseUrl }) {
  const unsub = `${baseUrl}${TEST_UNSUB_PATH}`
  let body = String(html || '')
    .replace(/{{\s*email\s*}}/gi, email)
    .replace(/{{\s*first_name\s*}}/gi, firstName)
    .replace(/{{\s*last_name\s*}}/gi, '')
    .replace(/{{\s*unsubscribe_url\s*}}/gi, unsub)
    .replace(/{{\s*mailing_address\s*}}/gi, client.mailing_address || '')
    .replace(/{{\s*campaign_name\s*}}/gi, campaign.name || '')
    .replace(/{{\s*industry_link\s*}}/gi, 'https://alconox.com/industries/')
  body = appendUtmParams(body, campaign.utm_params || '')
  return {
    to: email,
    from: { email: campaign.from_email, name: campaign.from_name },
    replyTo: campaign.reply_to || undefined,
    subject: `[TEST] ${campaign.subject}`,
    html: body,
    customArgs: { test_campaign_id: campaign.id },
    categories: [`test-campaign-${campaign.id}`],
    ipPoolName: client.ip_pool || undefined,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

async function listDraftCampaigns({ supabase, clientKey }) {
  const entry = clientEntry(clientKey)
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, name, subject, status, updated_at')
    .eq('client_id', entry.id)
    .eq('status', 'draft')
    .order('updated_at', { ascending: false })
    .limit(15)
  if (error) throw new Error(`campaign lookup failed: ${error.message}`)
  return {
    client: clientKey,
    approvers: Object.keys(entry.approvers),
    drafts: data || [],
  }
}

async function sendCampaignTest({ supabase, input, decryptClient, sendMail, baseUrl, now = new Date() }) {
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns').select('*').eq('id', input.campaignId).maybeSingle()
  if (campErr) throw new Error(`campaign lookup failed: ${campErr.message}`)
  if (!campaign) throw new AskTestSendError('campaign not found', 404)
  const entry = clientById(campaign.client_id)
  if (!entry) throw new AskTestSendError('test sends are not enabled for this campaign\'s client', 403)
  if (campaign.status !== 'draft') {
    throw new AskTestSendError(`campaign is ${campaign.status}; tests go out only for drafts`, 409)
  }
  const outsiders = input.recipients.filter(r => !entry.approvers[r])
  if (outsiders.length) {
    throw new AskTestSendError(
      `not an approved test recipient for ${entry.name}: ${outsiders.join(', ')}`, 403)
  }

  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
  const { data: recent, error: recentErr } = await supabase
    .from('ask_test_sends').select('recipient, request_key')
    .eq('campaign_id', campaign.id).gte('created_at', since)
  if (recentErr) throw new Error(`test-send log unavailable: ${recentErr.message}`)
  const fresh = input.recipients.filter(r =>
    !(recent || []).some(row => row.request_key === input.requestKey && row.recipient === r))
  const already = input.recipients.filter(r => !fresh.includes(r))
  const priorCount = (recent || []).length
  if (priorCount + fresh.length > PER_CAMPAIGN_DAILY) {
    throw new AskTestSendError(`daily limit reached: ${PER_CAMPAIGN_DAILY} test copies per campaign`, 429)
  }
  for (const r of fresh) {
    const n = (recent || []).filter(row => row.recipient === r).length
    if (n >= PER_RECIPIENT_DAILY) {
      throw new AskTestSendError(`daily limit reached for ${r}: ${PER_RECIPIENT_DAILY} test copies`, 429)
    }
  }

  const { data: tpl } = campaign.template_id
    ? await supabase.from('templates').select('html_content').eq('id', campaign.template_id).maybeSingle()
    : { data: null }
  if (!tpl?.html_content?.trim()) throw new AskTestSendError('campaign has no email design yet', 409)
  const { data: clientRaw, error: clientErr } = await supabase
    .from('clients').select('*').eq('id', campaign.client_id).single()
  if (clientErr) throw new Error(`client lookup failed: ${clientErr.message}`)
  const client = decryptClient(clientRaw)
  if (!client.sendgrid_api_key) throw new Error('client has no SendGrid key')

  const sent = []
  const failed = []
  for (const email of fresh) {
    // Claim the (request, recipient) slot first; a retry that lost the race skips.
    const { error: claimErr } = await supabase.from('ask_test_sends').insert({
      client_id: campaign.client_id,
      campaign_id: campaign.id,
      recipient: email,
      request_key: input.requestKey,
      status: 'sending',
    })
    if (claimErr) {
      if (claimErr.code === '23505') { already.push(email); continue }
      throw new Error(`test-send log write failed: ${claimErr.message}`)
    }
    const msg = buildTestMessage({
      campaign, client, html: tpl.html_content, email,
      firstName: entry.approvers[email], baseUrl,
    })
    let status = 'sent'
    let detail = null
    try {
      await sendMail(client.sendgrid_api_key, msg)
      sent.push(email)
    } catch (e) {
      status = 'failed'
      detail = String(e?.response?.body ? JSON.stringify(e.response.body.errors || e.response.body) : e.message).slice(0, 500)
      failed.push({ email, error: detail })
    }
    await supabase.from('ask_test_sends').update({ status, error: detail })
      .eq('request_key', input.requestKey).eq('recipient', email)
  }
  return {
    campaign: { id: campaign.id, name: campaign.name, subject: `[TEST] ${campaign.subject}` },
    sent,
    already_sent_for_this_request: already,
    failed,
  }
}

function createAskTestSendHandlers({ supabase, apiKey, decryptClient, sendMail, baseUrl }) {
  const guard = (fn) => async (req, res) => {
    if (!apiKey) return res.status(503).json({ error: 'Ask test-send integration is not configured' })
    if (!authorizedBearer(req.headers.authorization, apiKey)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    try {
      return res.json(await fn(req))
    } catch (error) {
      const status = error instanceof AskTestSendError ? error.status : 500
      console.error('[ask-test-send] failed:', error.message)
      return res.status(status).json({ error: status >= 500 ? 'Test send failed' : error.message })
    }
  }
  const origin = String(baseUrl || 'https://mail.sagerock.com').replace(/\/$/, '')
  return {
    drafts: guard(req => listDraftCampaigns({ supabase, clientKey: req.body?.client })),
    send: guard(req => sendCampaignTest({
      supabase,
      input: validateTestSendRequest(req.body, req.headers['idempotency-key']),
      decryptClient,
      sendMail,
      baseUrl: origin,
    })),
  }
}

module.exports = {
  TEST_SEND_CLIENTS,
  AskTestSendError,
  validateTestSendRequest,
  buildTestMessage,
  listDraftCampaigns,
  sendCampaignTest,
  createAskTestSendHandlers,
}
