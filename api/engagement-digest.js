// ============ WEEKLY ENGAGEMENT DIGEST ============
// Monday-morning email: form leads that need a person, stalled Salesforce opportunities
// (newest first), and replies from the last week. Same data as the Engagement page
// (engagement_overview()). Recipients/days per client in engagement_digest_config.
//
// Sent from the client's own SendGrid account + from-address (their domain, their IP pool),
// but it's an autonomous send, so it says so in the footer ("Claude, for Sage").

const { MailService } = require('@sendgrid/mail')

const SITE = process.env.PUBLIC_APP_URL || 'https://mail.sagerock.com'

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
function fmtDate(s) { if (!s) return '–'; const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
function daysAgo(s) { if (!s) return ''; const d = Math.round((Date.now() - new Date(s).getTime()) / 86400000); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago` }
function name(p) { return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || '' }
function stripMeta(body) { return String(body || '').replace(/^(\[[^\]]+\]\s*)+\n*/, '') }

const T = {
  h2: 'font:600 15px/1.3 Arial,sans-serif;color:#111;margin:28px 0 4px',
  sub: 'font:13px/1.4 Arial,sans-serif;color:#666;margin:0 0 10px',
  th: 'text-align:left;font:600 11px Arial,sans-serif;color:#666;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #ddd',
  td: 'font:13px/1.35 Arial,sans-serif;color:#222;padding:7px 8px;border-bottom:1px solid #eee;vertical-align:top',
  muted: 'color:#777',
  pill: (bg, fg) => `display:inline-block;padding:2px 7px;border-radius:10px;font:11px Arial,sans-serif;background:${bg};color:${fg};white-space:nowrap`,
}

function statusPill(s) {
  if (s === 'reply awaiting verified response') return `<span style="${T.pill('#fde2e2', '#8a1c1c')}">${esc(s)}</span>`
  if (s === 'no follow-up recorded') return `<span style="${T.pill('#fff1cc', '#7a5200')}">${esc(s)}</span>`
  if (s === 'automation only' || s === 'unable to verify' || /ambiguous|unknown/.test(s)) return `<span style="${T.pill('#eeeeee', '#444')}">${esc(s)}</span>`
  if (s === 'new — within follow-up window' || s === 'Salesforce activity recorded') return `<span style="${T.pill('#dceeff', '#0b4a8b')}">${esc(s)}</span>`
  return `<span style="${T.pill('#dff3e3', '#1d6b34')}">${esc(s)}</span>`
}

function table(head, rows) {
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
    <tr>${head.map(h => `<th style="${T.th}">${esc(h)}</th>`).join('')}</tr>
    ${rows.join('')}
  </table>`
}

function buildDigest(o, client, cfg) {
  const t = o.totals
  const days = o.days
  const completed = new Set(['verified human follow-up', 'Salesforce activity recorded'])
  const attention = o.form_leads.filter(l => !completed.has(l.status))
  const completedRows = o.form_leads.filter(l => completed.has(l.status))
  const attentionTotal = t.form_leads_no_follow_up + t.form_leads_automation +
    t.form_leads_reply_waiting + t.form_leads_ambiguous + t.form_leads_unable_to_verify +
    t.form_leads_within_grace
  const stalled = o.stalled.slice(0, 25)
  const replies = o.replies.slice(0, 15)
  const pageUrl = `${SITE}/engagement`

  const leadRows = attention.map(l => `<tr>
    <td style="${T.td}"><a href="${SITE}/contacts/${l.id}" style="color:#1d4ed8;text-decoration:none">${esc(name(l))}</a>${l.company ? `<br><span style="${T.muted}">${esc(l.company)}</span>` : ''}</td>
    <td style="${T.td}">${esc(l.last_form)}${l.forms_in_window > 1 ? `<br><span style="${T.muted}">${l.forms_in_window} submissions</span>` : ''}</td>
    <td style="${T.td}">${fmtDate(l.last_form_on)}<br><span style="${T.muted}">${daysAgo(l.last_form_on)}</span></td>
    <td style="${T.td}">${statusPill(l.status)}</td>
    <td style="${T.td}">${l.opens_since_form} opens · ${l.clicks_since_form} clicks${l.genuine_reply_at ? ' · genuine reply' : ''}</td>
    <td style="${T.td}">${l.salesforce_last_activity_date ? fmtDate(l.salesforce_last_activity_date) : '<span style="color:#b45309">No activity date recorded</span>'}</td>
  </tr>`)

  const oppRows = stalled.map(s => `<tr>
    <td style="${T.td}">${esc(s.name)}</td>
    <td style="${T.td}">${esc(s.stage)}</td>
    <td style="${T.td}">${esc(s.owner_name || '–')}</td>
    <td style="${T.td}">${esc(s.contact_email || '–')}</td>
    <td style="${T.td}">${fmtDate(s.last_touch)}<br><span style="${T.muted}">${daysAgo(s.last_touch)}</span></td>
  </tr>`)

  const replyRows = replies.map(r => `<tr>
    <td style="${T.td}">${r.contact_id ? `<a href="${SITE}/contacts/${r.contact_id}" style="color:#1d4ed8;text-decoration:none">${esc(name(r) || r.email)}</a>` : esc(r.email)}${r.company ? `<br><span style="${T.muted}">${esc(r.company)}</span>` : ''}</td>
    <td style="${T.td}">${fmtDate(r.created_at)}</td>
    <td style="${T.td}">${r.answered_at ? `<span style="${T.pill('#dff3e3', '#1d6b34')}">verified human response</span>` : `<span style="${T.pill('#fde2e2', '#8a1c1c')}">no verified response</span>`}</td>
    <td style="${T.td}"><b>${esc(r.subject || '(no subject)')}</b><br><span style="${T.muted}">${esc(stripMeta(r.body).slice(0, 220))}</span></td>
  </tr>`)

  const summary = `${t.form_submissions} form submission${t.form_submissions === 1 ? '' : 's'} from ${t.form_leads} people in the last ${days} days. `
    + `${t.form_leads_no_follow_up} have no follow-up recorded, ${t.form_leads_automation} have automation only, ${t.form_leads_within_grace} are within the follow-up window, ${t.form_leads_reply_waiting} have a reply awaiting a verified response, ${t.form_leads_human_follow_up} have verified human follow-up, and ${t.form_leads_salesforce_activity} have later Salesforce activity recorded. `
    + `${t.form_leads_ambiguous} have ambiguous evidence and ${t.form_leads_unable_to_verify} could not be verified. `
    + `${t.open_opps} open opportunities, ${t.stalled} with no activity in 14+ days. `
    + `${t.replies} email repl${t.replies === 1 ? 'y' : 'ies'} in the window.`

  const html = `<div style="max-width:860px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;color:#222">
    <h1 style="font:700 20px Arial,sans-serif;margin:0 0 6px">${esc(client.name)} engagement, week of ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</h1>
    <p style="${T.sub}">${esc(summary)} <a href="${pageUrl}" style="color:#1d4ed8">Open the full page</a>.</p>

    <h2 style="${T.h2}">Form leads needing follow-up or review (${attentionTotal})</h2>
    <p style="${T.sub}">Evidence is separated into verified human follow-up, Salesforce's date-only activity rollup, automation, genuine replies, and unresolved or ambiguous coverage.</p>
    ${attention.length ? table(['Person', 'Form', 'Filled out', 'Status', 'Since the form', 'Salesforce activity date'], leadRows) : `<p style="${T.sub}">No leads need follow-up or evidence review in this verified cohort.</p>`}
    ${attention.length < attentionTotal ? `<p style="${T.sub};margin-top:8px">${attention.length} of ${attentionTotal} matching leads shown. Open the full page for the rest.</p>` : ''}
    ${completedRows.length ? `<p style="${T.sub};margin-top:8px">${t.form_leads_human_follow_up} have verified human follow-up; ${t.form_leads_salesforce_activity} have later Salesforce activity recorded.</p>` : ''}

    <h2 style="${T.h2}">Stalled opportunities (${t.stalled}${stalled.length < t.stalled ? `, newest ${stalled.length} shown` : ''})</h2>
    <p style="${T.sub}">Open in Salesforce with no activity or stage change in 14+ days. Newest first.</p>
    ${stalled.length ? table(['Opportunity', 'Stage', 'Owner', 'Contact', 'Last touch'], oppRows) : `<p style="${T.sub}">No stalled opportunities.</p>`}

    <h2 style="${T.h2}">Replies (${t.replies})</h2>
    <p style="${T.sub}">People who replied to a campaign email in the last ${days} days.</p>
    ${replies.length ? table(['Person', 'When', 'Status', 'Message'], replyRows) : `<p style="${T.sub}">No replies in this window.</p>`}

    <p style="font:12px/1.5 Arial,sans-serif;color:#888;margin-top:32px;border-top:1px solid #eee;padding-top:12px">
      Sent automatically every Monday by SageRock's email tool. Data: Salesforce (contacts, activity dates, opportunities) and our email sends, opens, clicks, and replies.
      Questions or changes: reply to this email and Sage will see it.<br>— Claude, for Sage
    </p>
  </div>`

  const text = `${client.name} engagement digest\n\n${summary}\n\nForm leads needing follow-up or review (${attentionTotal}; ${attention.length} shown):\n`
    + attention.map(l => `- ${name(l)}${l.company ? ` (${l.company})` : ''}: ${l.last_form}, ${fmtDate(l.last_form_on)}, ${l.status}, ${l.opens_since_form} opens / ${l.clicks_since_form} clicks`).join('\n')
    + `\n\nStalled opportunities (${t.stalled}):\n` + stalled.map(s => `- ${s.name} [${s.stage}] ${s.owner_name || ''} last touch ${fmtDate(s.last_touch)}`).join('\n')
    + `\n\nReplies (${t.replies}):\n` + replies.map(r => `- ${name(r) || r.email}: ${r.subject || '(no subject)'} (${r.answered_at ? 'verified human response' : 'no verified response'})`).join('\n')
    + `\n\nFull page: ${pageUrl}\n\n— Claude, for Sage`

  // House pattern for this client's subjects: "<short phrase> — <Company>" (subject_prefix holds the company)
  const phrase = `${attentionTotal} form lead${attentionTotal === 1 ? '' : 's'} need review`
  const subject = cfg.subject_prefix ? `${phrase} — ${cfg.subject_prefix}` : `${phrase}, ${t.stalled} stalled opportunities`
  return { html, text, subject, attention: attentionTotal }
}

module.exports = function mountEngagementDigest(app, { supabase, decryptClient, cron, reporting }) {
  async function sendDigest(clientId, { to, dryRun } = {}) {
    const [{ data: cfg }, { data: clientRow }, { data: lastCampaign }] = await Promise.all([
      supabase.from('engagement_digest_config').select('*').eq('client_id', clientId).maybeSingle(),
      supabase.from('clients').select('id, name, sendgrid_api_key, ip_pool, default_reply_to_email').eq('id', clientId).single(),
      // sender identity = whatever the client's campaigns go out as (clients has no from_email column)
      supabase.from('campaigns').select('from_email, from_name').eq('client_id', clientId).not('from_email', 'is', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    if (!clientRow) throw new Error('client not found')
    clientRow.from_email = lastCampaign?.from_email || clientRow.default_reply_to_email
    clientRow.from_name = lastCampaign?.from_name || clientRow.name
    const conf = cfg || { enabled: true, recipients: [], bcc: [], days: 14, subject_prefix: null }
    const recipients = to ? [].concat(to) : conf.recipients
    if (!recipients.length) throw new Error('no recipients configured')

    if (reporting && process.env.ENGAGEMENT_REPORTING_ENABLED === 'true') {
      const freshness = await reporting.refreshSnapshot(clientId, {
        scope: 'known_people', days: conf.days,
      })
      if (freshness.status !== 'complete' || freshness.unresolved_count || freshness.failed_count) {
        throw new Error(
          `Engagement digest withheld: Salesforce verification incomplete ` +
          `(status=${freshness.status}, unresolved=${freshness.unresolved_count}, failed=${freshness.failed_count})`
        )
      }
    }

    const { data: o, error } = await supabase.rpc('engagement_overview', { p_client_id: clientId, p_days: conf.days, p_wait_days: 3 })
    if (error) throw error
    const digest = buildDigest(o, clientRow, conf)
    if (dryRun) return { ...digest, recipients }

    const client = decryptClient(clientRow)
    if (!client.sendgrid_api_key || !client.from_email) throw new Error('client has no SendGrid key / from_email')
    const sg = new MailService(); sg.setApiKey(client.sendgrid_api_key)
    const msg = {
      to: recipients,
      bcc: to ? undefined : (conf.bcc?.length ? conf.bcc : undefined),
      from: { email: client.from_email, name: `${client.name} Engagement Report` },
      replyTo: { email: 'sage@sagerock.com', name: 'Sage Lewis' },
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
      trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } },
      categories: ['engagement-digest'],
    }
    if (client.ip_pool) msg.ipPoolName = client.ip_pool
    await sg.send(msg)
    if (!to) await supabase.from('engagement_digest_config').update({ last_sent_at: new Date().toISOString() }).eq('client_id', clientId)
    console.log(`📬 engagement digest sent for ${client.name} → ${recipients.join(', ')} (${digest.attention} leads need a person)`)
    return { ...digest, recipients }
  }

  // Preview / manual send (auth + client scoping via the global /api middleware).
  // POST /api/engagement/digest?clientId=   body: { to?: string|string[], dryRun?: boolean }
  app.post('/api/engagement/digest', async (req, res) => {
    try {
      const clientId = req.query.clientId || req.body?.clientId
      if (!clientId) return res.status(400).json({ error: 'clientId required' })
      const out = await sendDigest(clientId, { to: req.body?.to, dryRun: !!req.body?.dryRun })
      res.json({ ok: true, subject: out.subject, recipients: out.recipients, attention: out.attention, html: req.body?.dryRun ? out.html : undefined })
    } catch (err) {
      console.error('❌ engagement/digest:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Mondays 12:00 UTC (8am Eastern in summer, 7am in winter)
  if (cron) {
    cron.schedule('0 12 * * 1', async () => {
      const { data: cfgs } = await supabase.from('engagement_digest_config').select('client_id, recipients').eq('enabled', true)
      for (const c of cfgs || []) {
        if (!c.recipients?.length) continue
        try { await sendDigest(c.client_id) } catch (e) { console.error(`❌ digest failed for ${c.client_id}:`, e.message) }
      }
    })
  }

  return { sendDigest, buildDigest }
}
