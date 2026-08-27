// ============ CAMPAIGN REPLY RECEIVER ============
// SendGrid Inbound Parse → this endpoint, for client-branded reply subdomains
// (first one: email.alconox.com, MX → mx.sendgrid.net, added 2026-08-27).
//
// What it does with a reply to a campaign email:
//   1. Match the sender to a contact (by email, within the client).
//   2. Log it in email_conversations (direction = inbound).
//   3. Tag the contact "Replied", flag ai_followup_contacts.replied, cancel any
//      active sequence enrollments — replies stop automations.
//   4. Forward the reply, untouched, to the client's real inbox with Reply-To set
//      to the original sender so staff can answer directly.
//
// It never auto-replies. That's deliberate: the general chatbot path in
// /api/webhook/inbound-email answers in SageRock's voice and must not touch
// client customers. An AI (persona) reply can be added here later, draft-first.
//
// Auto-responders (out-of-office, bounces) are logged but NOT forwarded.

const multer = require('multer')
const { MailService } = require('@sendgrid/mail')

// Reply subdomain → client routing. forwardTo falls back to clients.default_reply_to_email.
const REPLY_DOMAINS = {
  'email.alconox.com': {
    clientId: 'ea7f1422-2d20-4299-85a7-c1201e953409',
    fromEmail: 'cleaning@email.alconox.com',
    fromName: 'Alconox, LLC',
    forwardTo: 'cleaning@alconox.com',
    bcc: ['sage@sagerock.com'],
  },
}

// Visible ref line we plan to put in campaign footers, e.g. "Ref: Campaign1234".
// Nothing embeds this yet; when present we record it so Salesforce-side matching
// and ours agree on one code.
const REF_RE = /\b(?:Ref(?:erence)?|Campaign(?: ID)?)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,})/i

function parseAddress(raw) {
  if (!raw) return null
  const m = raw.match(/<([^>]+)>/)
  return (m ? m[1] : raw).trim().toLowerCase()
}

function parseHeaders(raw) {
  const out = {}
  if (!raw) return out
  for (const line of raw.split(/\r?\n(?!\s)/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

function isAutoResponse(headers, subject, senderEmail) {
  if (/^(mailer-daemon|postmaster|no-?reply)@/i.test(senderEmail || '')) return true
  const auto = headers['auto-submitted']
  if (auto && !/^no\b/i.test(auto)) return true
  if (headers['x-autoreply'] || headers['x-autorespond']) return true
  if (/^(all|oof|autoreply)/i.test(headers['x-auto-response-suppress'] || '')) return true
  if (/\b(out of (the )?office|automatic reply|auto-?reply|autoreply|delivery status notification|undeliverable)\b/i.test(subject || '')) return true
  return false
}

function stripQuoted(text) {
  return (text || '')
    .split(/\n/)
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .split(/\n\s*On .{5,200} wrote:/)[0]
    .split(/\n\s*From: .+\n\s*Sent: .+/)[0]
    .split(/\n-{3,}\s*Original Message\s*-{3,}/i)[0]
    .trim()
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

module.exports = function mountCampaignReplies(app, { supabase, decryptClient, webhookLimiter }) {
  const upload = multer()

  app.post('/api/webhook/campaign-reply', webhookLimiter, upload.any(), async (req, res) => {
    // Always 200 so SendGrid never retries; failures are logged.
    res.status(200).send('OK')
    try {
      await handle(req.body, req.files || [])
    } catch (err) {
      console.error('❌ campaign-reply webhook error:', err)
    }
  })

  async function handle(body, files) {
    const { from: rawFrom, to: rawTo, subject = '', text, html, envelope } = body
    const headers = parseHeaders(body.headers)
    const senderEmail = parseAddress(rawFrom)

    // Which reply domain was this addressed to?
    let toAddr = parseAddress(rawTo)
    try {
      const env = envelope ? JSON.parse(envelope) : null
      if (env?.to?.[0]) toAddr = String(env.to[0]).toLowerCase()
    } catch { /* ignore */ }
    const domain = (toAddr || '').split('@')[1]
    const route = REPLY_DOMAINS[domain]

    console.log(`📨 campaign-reply from ${senderEmail} to ${toAddr} — "${subject}"`)

    if (!route) {
      console.warn(`⚠️ campaign-reply: no route for domain "${domain}", dropping`)
      return
    }
    if (!senderEmail) {
      console.warn('⚠️ campaign-reply: no sender address, dropping')
      return
    }

    const auto = isAutoResponse(headers, subject, senderEmail)
    const fullText = (text && text.trim()) || (html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    const cleanBody = stripQuoted(text || fullText) || fullText
    const refMatch = fullText.match(REF_RE)
    const refCode = refMatch ? refMatch[1] : null

    // 1. Contact
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, email, first_name, last_name, company, tags')
      .eq('client_id', route.clientId)
      .eq('email', senderEmail)
      .maybeSingle()

    // 2. Log
    const noteBits = [
      auto ? '[auto-response]' : null,
      refCode ? `[ref:${refCode}]` : null,
      headers['message-id'] ? `[message-id:${headers['message-id']}]` : null,
      headers['in-reply-to'] ? `[in-reply-to:${headers['in-reply-to']}]` : null,
      files.length ? `[attachments:${files.length}]` : null,
    ].filter(Boolean).join(' ')

    const { error: logErr } = await supabase.from('email_conversations').insert({
      client_id: route.clientId,
      contact_id: contact?.id || null,
      direction: 'inbound',
      subject: subject || '(no subject)',
      body: (noteBits ? noteBits + '\n\n' : '') + (cleanBody || '(empty)'),
      ai_generated: false,
      escalated: false,
    })
    if (logErr) console.error('❌ campaign-reply: log insert failed:', logErr.message)

    if (auto) {
      console.log(`↩️ campaign-reply: auto-response from ${senderEmail}, logged only`)
      return
    }

    // 3. Mark replied + stop automations
    if (contact) {
      const tags = Array.isArray(contact.tags) ? contact.tags : []
      const patch = { last_replied_at: new Date().toISOString() }
      if (!tags.includes('Replied')) patch.tags = [...tags, 'Replied']
      await supabase.from('contacts').update(patch).eq('id', contact.id)
      await supabase.from('ai_followup_contacts')
        .update({ replied: true })
        .eq('contact_id', contact.id)
        .eq('client_id', route.clientId)
      const { data: cancelled } = await supabase.from('sequence_enrollments')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('contact_id', contact.id)
        .in('status', ['active', 'paused'])
        .select('id')
      if (cancelled?.length) console.log(`⏹️ campaign-reply: cancelled ${cancelled.length} sequence enrollment(s) for ${senderEmail}`)
    } else {
      console.log(`ℹ️ campaign-reply: ${senderEmail} not a known contact for client, logged without contact_id`)
    }

    // 4. Forward to the client's real inbox
    const { data: clientRow, error: clientErr } = await supabase
      .from('clients')
      .select('id, name, sendgrid_api_key, ip_pool, default_reply_to_email')
      .eq('id', route.clientId)
      .single()
    if (clientErr || !clientRow?.sendgrid_api_key) {
      console.error('❌ campaign-reply: cannot load client SendGrid key, not forwarding')
      return
    }
    const client = decryptClient(clientRow)
    const forwardTo = route.forwardTo || client.default_reply_to_email
    if (!forwardTo) {
      console.error('❌ campaign-reply: no forward address configured')
      return
    }

    const who = contact
      ? `${[contact.first_name, contact.last_name].filter(Boolean).join(' ') || senderEmail}${contact.company ? ` (${contact.company})` : ''}`
      : senderEmail
    const banner = `Reply from ${who} <${senderEmail}>` + (refCode ? ` to campaign ${refCode}` : '') + '. Reply to this email to answer them directly.'

    const msg = {
      to: forwardTo,
      bcc: route.bcc || undefined,
      from: { email: route.fromEmail, name: route.fromName },
      replyTo: { email: senderEmail, name: rawFrom?.replace(/<.*/, '').replace(/"/g, '').trim() || undefined },
      subject: subject || '(no subject)',
      text: `${banner}\n\n----------------------------------------\n\n${text || fullText}`,
      html: `<p style="font:13px Arial,sans-serif;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">${escapeHtml(banner)}</p>` +
        (html || `<pre style="font:14px Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text || fullText)}</pre>`),
      headers: headers['message-id'] ? { 'X-Original-Message-ID': headers['message-id'] } : undefined,
      attachments: files.map(f => ({
        content: f.buffer.toString('base64'),
        filename: f.originalname || 'attachment',
        type: f.mimetype,
        disposition: 'attachment',
      })),
      trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } },
      categories: ['campaign-reply-forward'],
    }
    if (client.ip_pool) msg.ipPoolName = client.ip_pool

    const sg = new MailService()
    sg.setApiKey(client.sendgrid_api_key)
    await sg.send(msg)
    console.log(`📤 campaign-reply: forwarded ${senderEmail} → ${forwardTo}`)
  }
}
