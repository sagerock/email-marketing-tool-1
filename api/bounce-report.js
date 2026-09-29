// ============ WEEKLY BOUNCE REPORT ============
// Monday email listing the week's new hard bounces so the client can clean them up in
// Salesforce (Stacy, Alconox, 2026-09-29: "I don't want dirty data coming in").
// Groups: likely typos with a fix (same person already on file elsewhere, or a close
// delivering domain when the bounced domain doesn't exist), domains that don't exist,
// mailboxes that no longer work, and possible false bounces (engaged after the bounce).
// Recipients/days per client in bounce_report_config. Quiet weeks send nothing.

const { MailService } = require('@sendgrid/mail')

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
function fmtDate(s) { if (!s) return '–'; const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
function name(p) { return [p.first_name, p.last_name].filter(Boolean).join(' ') }
function domainOf(email) { return String(email || '').toLowerCase().split('@')[1] || '' }
function localOf(email) { return String(email || '').toLowerCase().split('@')[0] || '' }

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

const TLD_FIXES = { gob: 'gov', con: 'com', cmo: 'com', ocm: 'com', vom: 'com', xom: 'com', comm: 'com', cm: 'com', og: 'org', ogr: 'org', nte: 'net' }
const GENERIC_LOCAL = /^(info|sales|admin|office|contact|purchasing|orders?|support|service|accounts?|ap|billing|lab|hello|mail|qa|qc)$/i

// Pick the best spelling fix for a domain that doesn't exist: an obvious
// top-level typo (.gob -> .gov) first, otherwise the closest delivering domain
// on the list (fewest edits, then most contacts).
function suggestDomain(domain, candidates = []) {
  if (!domain) return null
  const parts = domain.split('.')
  const tld = parts.pop()
  if (TLD_FIXES[tld]) return [...parts, TLD_FIXES[tld]].join('.')
  const best = candidates.filter(c => c.dist <= (domain.length >= 10 ? 2 : 1))
    .sort((a, b) => a.dist - b.dist || b.n - a.n)[0]
  return best ? best.candidate : null
}

// Does the domain accept mail? true / false, or null when DNS itself failed.
async function domainExists(domain, dns = require('node:dns').promises) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 5000))
  const lookup = (async () => {
    try { const mx = await dns.resolveMx(domain); if (mx?.length) return true } catch (e) {
      if (!['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENONAME'].includes(e.code)) return null
    }
    try { const a = await dns.resolve4(domain); return a?.length > 0 } catch (e) {
      return ['ENOTFOUND', 'ENODATA', 'ENONAME'].includes(e.code) ? false : null
    }
  })()
  return Promise.race([lookup, timeout])
}

function sfLink(instanceUrl, c) {
  if (!instanceUrl || !c.salesforce_id) return null
  const obj = c.record_type === 'contact' ? 'Contact' : 'Lead'
  return `${instanceUrl.replace(/\/+$/, '')}/lightning/r/${obj}/${c.salesforce_id}/view`
}

async function loadReport(supabase, clientId, days, { now = new Date(), dns } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString()
  const [{ data: client, error: ce }, { data: bounced, error: be }] = await Promise.all([
    supabase.from('clients').select('id, name, salesforce_instance_url').eq('id', clientId).single(),
    supabase.from('contacts')
      .select('id, email, first_name, last_name, company, record_type, salesforce_id, bounced_at, last_engaged_at')
      .eq('client_id', clientId).eq('bounce_status', 'hard').gte('bounced_at', since)
      .order('bounced_at', { ascending: false }).limit(2000),
  ])
  if (ce) throw ce
  if (be) throw be
  const rows = bounced || []

  const domains = [...new Set(rows.map(c => domainOf(c.email)).filter(Boolean))]
  const exists = new Map()
  for (let i = 0; i < domains.length; i += 20) {
    const part = domains.slice(i, i + 20)
    const res = await Promise.all(part.map(d => domainExists(d, dns)))
    part.forEach((d, k) => exists.set(d, res[k]))
  }
  const missing = domains.filter(d => exists.get(d) === false)
  const byDomain = new Map()
  if (missing.length) {
    const { data, error } = await supabase.rpc('bounce_report_domain_candidates', { p_client_id: clientId, p_domains: missing })
    if (error) throw error
    for (const r of data || []) (byDomain.get(r.bounced) || byDomain.set(r.bounced, []).get(r.bounced)).push({ ...r, n: Number(r.n) })
  }

  // The same person already on file at a different, working address.
  async function findTwin(c) {
    const local = localOf(c.email)
    if (local.length < 3 || GENERIC_LOCAL.test(local)) return null
    const { data, error } = await supabase.from('contacts').select('email, last_name, bounce_status')
      .eq('client_id', clientId).ilike('email', `${local.replace(/[%_\\]/g, m => '\\' + m)}@%`).limit(10)
    if (error) throw error
    const hit = (data || []).find(o => String(o.email).toLowerCase() !== String(c.email).toLowerCase()
      && o.bounce_status !== 'hard'
      && (!c.last_name || !o.last_name || o.last_name.toLowerCase() === c.last_name.toLowerCase()))
    return hit ? String(hit.email).toLowerCase() : null
  }

  const typos = [], moved = [], noDomain = [], gone = [], maybeFalse = []
  for (const c of rows) {
    const row = { ...c, link: sfLink(client.salesforce_instance_url, c) }
    if (c.last_engaged_at && c.bounced_at && new Date(c.last_engaged_at) > new Date(c.bounced_at)) { maybeFalse.push(row); continue }
    const domain = domainOf(c.email)
    const twin = await findTwin(c)
    const twinIsSpelling = twin && editDistance(domain, domainOf(twin)) <= 2
    if (twinIsSpelling) { typos.push({ ...row, suggested: twin, twin: true }); continue }
    if (exists.get(domain) === false) {
      const fix = suggestDomain(domain, byDomain.get(domain))
      if (fix) {
        const suggested = `${localOf(c.email)}@${fix}`
        typos.push({ ...row, suggested, twin: twin === suggested })
        continue
      }
    }
    if (twin) { moved.push({ ...row, otherAddress: twin }); continue }
    if (exists.get(domain) === false) noDomain.push(row)
    else gone.push(row)
  }
  return { client, days, since, typos, moved, noDomain, gone, maybeFalse, total: rows.length }
}

const T = {
  h2: 'font:600 15px/1.3 Arial,sans-serif;color:#111;margin:26px 0 4px',
  p: 'font:14px/1.5 Arial,sans-serif;color:#222;margin:0 0 10px',
  sub: 'font:13px/1.4 Arial,sans-serif;color:#666;margin:0 0 8px',
  th: 'text-align:left;font:600 11px Arial,sans-serif;color:#666;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #ddd',
  td: 'font:13px/1.35 Arial,sans-serif;color:#222;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top',
}
const LIST_CAP = 60

function table(head, rows) {
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">
    <tr>${head.map(h => `<th style="${T.th}">${esc(h)}</th>`).join('')}</tr>${rows.join('')}</table>`
}
function person(c) {
  const who = [name(c), c.company].filter(Boolean).join(', ')
  return c.link ? `<a href="${esc(c.link)}" style="color:#1a4f9c">${esc(who || 'Open in Salesforce')}</a>` : esc(who)
}

const COLUMNS = ['group', 'email', 'suggested_fix', 'correct_twin_exists', 'name', 'company', 'record_type', 'salesforce_id', 'bounced_on', 'salesforce_link']
const GROUPS = [['typos', 'likely typo', 'Likely typos'], ['moved', 'another address on file', 'Another address on file'],
  ['noDomain', 'domain does not exist', "Domain doesn't exist"], ['gone', 'mailbox gone', 'Mailbox no longer works'],
  ['maybeFalse', 'possible false bounce', 'Possible false bounces']]

function exportRows(r) {
  return GROUPS.map(([key, group, sheet]) => ({
    sheet,
    rows: (r[key] || []).map(c => {
      const suggested = key === 'moved' ? c.otherAddress : c.suggested
      return [group, c.email, suggested || '', suggested ? (c.twin ? 'yes' : 'no') : '', name(c), c.company, c.record_type, c.salesforce_id, (c.bounced_at || '').slice(0, 10), c.link || '']
    }),
  }))
}

function toCsv(r) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [COLUMNS.join(',')]
  for (const g of exportRows(r)) for (const row of g.rows) lines.push(row.map(q).join(','))
  return lines.join('\n') + '\n'
}

// The weekly attachment is Excel, not CSV (Michelle, Alconox, 2026-09-29): an "All" tab plus one tab per group,
// same columns, bold frozen header, filters on.
async function toXlsx(r) {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  const groups = exportRows(r)
  const addSheet = (title, rows) => {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.addRow(COLUMNS).font = { bold: true }
    rows.forEach(row => ws.addRow(row.map(v => v ?? '')))
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }
    ws.columns.forEach((col, i) => { col.width = Math.min(60, Math.max(COLUMNS[i].length, ...rows.map(x => String(x[i] ?? '').length)) + 2) })
  }
  addSheet('All', groups.flatMap(g => g.rows))
  for (const g of groups) if (g.rows.length) addSheet(`${g.sheet} (${g.rows.length})`, g.rows)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

function buildBounceReport(r, conf = {}) {
  const company = conf.subject_suffix || r.client.name
  const moved = r.moved || []
  const n = r.typos.length + moved.length + r.noDomain.length + r.gone.length
  const subject = `${n} bad email${n === 1 ? '' : 's'} to clean up — ${company}`
  const intro = `${r.total} address${r.total === 1 ? '' : 'es'} hard-bounced in the last ${r.days} days. `
    + [
      `${r.typos.length} ${r.typos.length === 1 ? 'looks' : 'look'} like ${r.typos.length === 1 ? 'a typo' : 'typos'}`,
      moved.length ? `${moved.length} ${moved.length === 1 ? 'is a person' : 'are people'} already on file at another address` : null,
      `${r.noDomain.length} ${r.noDomain.length === 1 ? 'uses a domain' : 'use domains'} that don't exist`,
      `${r.gone.length} ${r.gone.length === 1 ? 'is a mailbox' : 'are mailboxes'} that no longer work`,
    ].filter(Boolean).join(', ')
    + (r.maybeFalse.length ? `, and ${r.maybeFalse.length} may be false bounces.` : '.')

  const typoRows = r.typos.slice(0, LIST_CAP).map(c => `<tr>
    <td style="${T.td}">${esc(c.email)}</td><td style="${T.td}"><b>${esc(c.suggested)}</b>${c.twin ? '<br><span style="color:#777">already on file, likely a duplicate</span>' : ''}</td>
    <td style="${T.td}">${person(c)}</td></tr>`)
  const plainRows = arr => arr.slice(0, LIST_CAP).map(c => `<tr>
    <td style="${T.td}">${esc(c.email)}</td><td style="${T.td}">${person(c)}</td><td style="${T.td}">${esc(fmtDate(c.bounced_at))}</td></tr>`)
  const falseRows = r.maybeFalse.slice(0, LIST_CAP).map(c => `<tr>
    <td style="${T.td}">${esc(c.email)}</td><td style="${T.td}">${person(c)}</td><td style="${T.td}">engaged ${esc(fmtDate(c.last_engaged_at))}</td></tr>`)
  const more = (arr) => arr.length > LIST_CAP ? `<p style="${T.sub}">Plus ${arr.length - LIST_CAP} more in the attached Excel file.</p>` : ''

  const html = `<div style="max-width:720px">
    <p style="${T.p}">Hi,</p>
    <p style="${T.p}">${esc(intro)} Names link to the Salesforce record. The full list is attached as an Excel file, one tab per group.</p>
    ${r.typos.length ? `<h2 style="${T.h2}">Likely typos (${r.typos.length})</h2>
      <p style="${T.sub}">Fix the email in Salesforce. If the correct address is already on file, the typo record is a duplicate.</p>
      ${table(['Bounced', 'Probably meant', 'Person'], typoRows)}${more(r.typos)}` : ''}
    ${moved.length ? `<h2 style="${T.h2}">Same person, another address on file (${moved.length})</h2>
      <p style="${T.sub}">Often a job change. The bounced record can usually be retired in favor of the other one.</p>
      ${table(['Bounced', 'Also on file as', 'Person'], moved.slice(0, LIST_CAP).map(c => `<tr>
        <td style="${T.td}">${esc(c.email)}</td><td style="${T.td}">${esc(c.otherAddress)}</td><td style="${T.td}">${person(c)}</td></tr>`))}${more(moved)}` : ''}
    ${r.noDomain.length ? `<h2 style="${T.h2}">Domain doesn't exist (${r.noDomain.length})</h2>
      <p style="${T.sub}">Probably mistyped or fake, and we couldn't tell what it should be. Check the company's website, or remove.</p>
      ${table(['Address', 'Person', 'Bounced'], plainRows(r.noDomain))}${more(r.noDomain)}` : ''}
    ${r.gone.length ? `<h2 style="${T.h2}">Mailbox no longer works (${r.gone.length})</h2>
      <p style="${T.sub}">The company is real but this address is gone, often because the person left. Safe to mark invalid.</p>
      ${table(['Address', 'Person', 'Bounced'], plainRows(r.gone))}${more(r.gone)}` : ''}
    ${r.maybeFalse.length ? `<h2 style="${T.h2}">Possible false bounces (${r.maybeFalse.length})</h2>
      <p style="${T.sub}">These people opened or clicked after the bounce, so please don't delete them.</p>
      ${table(['Address', 'Person', 'Last activity'], falseRows)}${more(r.maybeFalse)}` : ''}
    <p style="${T.p};margin-top:24px">Questions? Just reply.</p>
    <p style="${T.p}">Jax, Sage’s assistant</p></div>`

  const line = c => `- ${c.email}${c.suggested ? ` -> ${c.suggested}${c.twin ? ' (already on file)' : ''}` : ''}${name(c) || c.company ? ` (${[name(c), c.company].filter(Boolean).join(', ')})` : ''}`
  const text = `Hi,\n\n${intro} The full list is attached as an Excel file, one tab per group.\n`
    + (r.typos.length ? `\nLikely typos (${r.typos.length}):\n${r.typos.slice(0, LIST_CAP).map(line).join('\n')}\n` : '')
    + (moved.length ? `\nSame person, another address on file (${moved.length}):\n${moved.slice(0, LIST_CAP).map(c => `- ${c.email} -> also ${c.otherAddress}${name(c) || c.company ? ` (${[name(c), c.company].filter(Boolean).join(', ')})` : ''}`).join('\n')}\n` : '')
    + (r.noDomain.length ? `\nDomain doesn't exist (${r.noDomain.length}):\n${r.noDomain.slice(0, LIST_CAP).map(line).join('\n')}\n` : '')
    + (r.gone.length ? `\nMailbox no longer works (${r.gone.length}):\n${r.gone.slice(0, LIST_CAP).map(line).join('\n')}\n` : '')
    + (r.maybeFalse.length ? `\nPossible false bounces, don't delete (${r.maybeFalse.length}):\n${r.maybeFalse.slice(0, LIST_CAP).map(line).join('\n')}\n` : '')
    + `\nQuestions? Just reply.\n\nJax, Sage’s assistant\n`
  return { subject, html, text, csv: toCsv(r), count: n }
}

module.exports = function mountBounceReport(app, { supabase, decryptClient, cron, schedulerEnabled = true }) {
  async function sendBounceReport(clientId, { to, dryRun, days } = {}) {
    const { data: cfg } = await supabase.from('bounce_report_config').select('*').eq('client_id', clientId).maybeSingle()
    const conf = cfg || { enabled: true, recipients: [], cc: [], days: 7 }
    const recipients = to ? [].concat(to) : conf.recipients
    if (!recipients.length) throw new Error('no recipients configured')
    const r = await loadReport(supabase, clientId, days || conf.days)
    const report = buildBounceReport(r, { subject_suffix: /alconox/i.test(r.client.name) ? 'Alconox, LLC' : null })
    if (dryRun) return { ...report, recipients, typos: r.typos.length, moved: r.moved.length, noDomain: r.noDomain.length, gone: r.gone.length, maybeFalse: r.maybeFalse.length }
    if (!r.total) return { skipped: 'no bounces', recipients }

    const { data: clientRow } = await supabase.from('clients').select('id, name, sendgrid_api_key, ip_pool, default_reply_to_email').eq('id', clientId).single()
    const { data: lastCampaign } = await supabase.from('campaigns').select('from_email').eq('client_id', clientId)
      .not('from_email', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const client = decryptClient(clientRow)
    const fromEmail = lastCampaign?.from_email || client.default_reply_to_email
    if (!client.sendgrid_api_key || !fromEmail) throw new Error('client has no SendGrid key / from_email')
    const sg = new MailService(); sg.setApiKey(client.sendgrid_api_key)
    const msg = {
      to: recipients,
      cc: !to && conf.cc?.length ? conf.cc : undefined,
      from: { email: fromEmail, name: `${client.name} Data Cleanup` },
      replyTo: { email: 'jax@sagerock.com', name: 'Jax, Sage’s assistant' },
      subject: report.subject, text: report.text, html: report.html,
      attachments: [{ content: (await toXlsx(r)).toString('base64'), filename: `bounces-${new Date().toISOString().slice(0, 10)}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: 'attachment' }],
      trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } },
      categories: ['bounce-report'],
    }
    if (client.ip_pool) msg.ipPoolName = client.ip_pool
    await sg.send(msg)
    if (!to) await supabase.from('bounce_report_config').update({ last_sent_at: new Date().toISOString() }).eq('client_id', clientId)
    console.log(`🧹 bounce report sent for ${client.name} → ${recipients.join(', ')} (${report.count} to clean up)`)
    return { ...report, recipients }
  }

  // Mondays 13:00 UTC, an hour after the engagement digest. Scheduler service only.
  if (cron && schedulerEnabled) {
    cron.schedule('0 13 * * 1', async () => {
      const { data: cfgs } = await supabase.from('bounce_report_config').select('client_id, recipients').eq('enabled', true)
      for (const c of cfgs || []) {
        if (!c.recipients?.length) continue
        try { await sendBounceReport(c.client_id) } catch (e) { console.error(`❌ bounce report failed for ${c.client_id}:`, e.message) }
      }
    })
  }
  return { sendBounceReport }
}
module.exports.suggestDomain = suggestDomain
module.exports.domainExists = domainExists
module.exports.buildBounceReport = buildBounceReport
module.exports.loadReport = loadReport
module.exports.toXlsx = toXlsx
