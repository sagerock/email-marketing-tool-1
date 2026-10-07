'use strict'

// One-page click heatmap report for a sent campaign: summary numbers, the
// email with each link shaded by how many people clicked it and a rank badge,
// a ranked table of links, and a color key. Rendered server-side in the same
// locked-down Chromium as the builder's visual check (no JavaScript, public
// images only), so every image shows up, unlike the old browser-side export.
//
// The email itself is never modified for display: it's rendered alone, link
// positions are measured, and the overlay is drawn on top of a screenshot.

const { publicUrl } = require('./visual-check')

const EMAIL_WIDTH = 640
const SCALE = 2
const UTM = /^(utm_[a-z_]+|_cors)$/i

// Clicks are recorded per URL; the template's href may carry UTM parameters,
// trailing-slash or host-case differences. Everything else must match exactly
// (no "contains" matching, which let similar links steal each other's clicks).
function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw).trim())
    url.hash = ''
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    for (const key of [...url.searchParams.keys()]) if (UTM.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    let s = url.toString()
    if (url.pathname.endsWith('/') && !url.search) s = s.replace(/\/$/, '')
    return s
  } catch {
    return null
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Tag every <a> so its rendered position can be measured; returns the hrefs in order.
function tagLinks(html) {
  const hrefs = []
  const tagged = html.replace(/<a\b([^>]*)>/gi, (whole, attrs) => {
    const m = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const href = m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''
    hrefs.push(href.replace(/&amp;/g, '&'))
    return `<a data-hm="${hrefs.length - 1}"${attrs}>`
  })
  return { tagged, hrefs }
}

// Reader-facing stand-ins for merge tags, so the report reads like the email did.
function fillMergeTags(html, client) {
  return html
    .replace(/\{\{\s*first_name\s*\}\}/gi, 'there')
    .replace(/\{\{\s*last_name\s*\}\}/gi, '')
    .replace(/\{\{\s*email\s*\}\}/gi, 'reader@example.com')
    .replace(/\{\{\s*mailing_address\s*\}\}/gi, escapeHtml(client?.mailing_address || ''))
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, '#unsubscribe')
}

// Match click stats to the email's links. Returns per-URL rows (ranked) and
// the clicks whose URL isn't in this version of the email.
function matchClicks(hrefs, linkStats, textByIndex = []) {
  const byUrl = new Map()
  hrefs.forEach((href, i) => {
    const key = normalizeUrl(href)
    if (!key || !/^https?:/i.test(href)) return
    if (!byUrl.has(key)) byUrl.set(key, { url: href, indices: [], text: '', unique: 0, total: 0 })
    const row = byUrl.get(key)
    row.indices.push(i)
    if (!row.text && textByIndex[i]) row.text = textByIndex[i]
  })
  const unmatched = []
  for (const stat of linkStats || []) {
    const key = normalizeUrl(stat.url)
    const row = key && byUrl.get(key)
    if (row) {
      row.unique += Number(stat.unique_clicks) || 0
      row.total += Number(stat.total_clicks) || 0
    } else if (!/unsubscribe/i.test(stat.url)) {
      unmatched.push({ url: stat.url, unique: Number(stat.unique_clicks) || 0 })
    }
  }
  const rows = [...byUrl.values()].sort((a, b) => b.unique - a.unique || a.indices[0] - b.indices[0])
  let rank = 0
  for (const row of rows) row.rank = row.unique > 0 ? ++rank : null
  return { rows, unmatched: unmatched.sort((a, b) => b.unique - a.unique) }
}

// Blue (no clicks) through green and amber to red (most clicked).
function heatColor(intensity, alpha = 0.35) {
  if (intensity <= 0) return `rgba(59,130,246,${alpha * 0.6})`
  const stops = [[34, 197, 94], [234, 179, 8], [239, 68, 68]]
  const t = Math.min(1, intensity) * 2
  const [a, b] = t <= 1 ? [stops[0], stops[1]] : [stops[1], stops[2]]
  const f = t <= 1 ? t : t - 1
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * f))
  return `rgba(${c.join(',')},${alpha})`
}

function prettyUrl(url) {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    return `${u.hostname.replace(/^www\./, '')}${path.length > 1 ? (path.length > 48 ? path.slice(0, 47) + '…' : path) : ''}`
  } catch {
    return url
  }
}

const fmt = n => Number(n || 0).toLocaleString('en-US')
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(n / d < 0.1 ? 1 : 0)}%` : '—')

function reportHtml({ campaign, client, summary, shot, boxes, rows, unmatched }) {
  const maxUnique = Math.max(1, ...rows.map(r => r.unique))
  const clickers = summary.clickers || 0
  const overlays = []
  for (const row of rows) {
    const color = heatColor(row.unique / maxUnique)
    const edge = heatColor(row.unique / maxUnique, 0.95)
    row.indices.forEach((i, n) => {
      for (const b of boxes[i] || []) {
        overlays.push(`<div class="hot" style="left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px;background:${color};border-color:${edge}"></div>`)
      }
      const first = (boxes[i] || [])[0]
      if (row.rank && first && n === 0) {
        overlays.push(`<div class="badge" style="left:${first.x + first.w - 6}px;top:${Math.max(0, first.y - 12)}px">${row.rank}</div>`)
      }
    })
  }
  const tableRows = rows.filter(r => r.unique > 0).map(r => `
    <tr>
      <td class="rank"><span class="dot" style="background:${heatColor(r.unique / maxUnique, 0.95)}">${r.rank}</span></td>
      <td><div class="lt">${escapeHtml(r.text || prettyUrl(r.url))}</div><div class="lu">${escapeHtml(prettyUrl(r.url))}${r.indices.length > 1 ? ` · ${r.indices.length} places in the email` : ''}</div></td>
      <td class="num">${fmt(r.unique)}</td>
      <td class="num">${pct(r.unique, clickers)}</td>
    </tr>`).join('')
  const zero = rows.filter(r => r.unique === 0)
  const unmatchedHtml = unmatched.length ? `
    <div class="note"><b>Clicked links no longer in this version of the email</b> (the email was edited after sending):
      ${unmatched.slice(0, 6).map(u => `${escapeHtml(prettyUrl(u.url))} (${fmt(u.unique)})`).join(', ')}</div>` : ''
  const sent = campaign.sent_at ? new Date(campaign.sent_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f5f7; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; }
  .page { width: 1240px; padding: 36px 40px 40px; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; }
  .kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; font-weight: 600; }
  h1 { margin: 4px 0 2px; font-size: 26px; line-height: 1.2; }
  .sub { color: #6b7280; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; }
  .kpi .v { font-size: 24px; font-weight: 700; }
  .kpi .l { font-size: 12px; color: #6b7280; }
  .cols { display: flex; gap: 28px; align-items: flex-start; }
  .email { position: relative; width: ${EMAIL_WIDTH}px; flex: none; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
  .email img.shot { display: block; width: ${EMAIL_WIDTH}px; }
  .hot { position: absolute; border: 2px solid; border-radius: 4px; }
  .badge { position: absolute; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: #111827; color: #fff;
    font-size: 12px; font-weight: 700; line-height: 22px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
  .side { flex: 1; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; padding: 0 6px 6px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 6px; border-bottom: 1px solid #f1f2f4; vertical-align: top; }
  th.num, td.num { text-align: right; white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; font-weight: 600; }
  .dot { display: inline-block; min-width: 22px; height: 22px; border-radius: 11px; color: #fff; font-weight: 700; font-size: 12px; line-height: 22px; text-align: center; padding: 0 5px; text-shadow: 0 1px 1px rgba(0,0,0,.35); }
  .lt { font-weight: 600; }
  .lu { color: #6b7280; font-size: 12px; word-break: break-all; }
  .legend { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #4b5563; }
  .bar { flex: 1; height: 12px; border-radius: 6px; background: linear-gradient(90deg, ${heatColor(0.001, 0.9)}, ${heatColor(0.5, 0.9)}, ${heatColor(1, 0.9)}); }
  .note { font-size: 12px; color: #4b5563; margin-top: 8px; }
  .foot { margin-top: 14px; font-size: 11px; color: #9ca3af; }
</style></head><body><div class="page">
  <div class="head">
    <div>
      <div class="kicker">${escapeHtml(client?.name || '')} · Click heatmap</div>
      <h1>${escapeHtml(campaign.name)}</h1>
      <div class="sub">${escapeHtml(campaign.subject || '')}${sent ? ` · Sent ${sent}` : ''}</div>
    </div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="v">${fmt(summary.sent)}</div><div class="l">Sent</div></div>
    <div class="kpi"><div class="v">${fmt(summary.delivered)}</div><div class="l">Delivered</div></div>
    <div class="kpi"><div class="v">${fmt(clickers)}</div><div class="l">People who clicked a link</div></div>
    <div class="kpi"><div class="v">${pct(clickers, summary.delivered || summary.sent)}</div><div class="l">Click rate (of delivered)</div></div>
  </div>
  <div class="cols">
    <div class="email"><img class="shot" src="data:image/png;base64,${shot}">${overlays.join('')}</div>
    <div class="side">
      <div class="card">
        <h2>Most-clicked links</h2>
        <table><thead><tr><th>#</th><th>Link</th><th class="num">People</th><th class="num">Of clickers</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="4">No link clicks recorded.</td></tr>'}</tbody></table>
        ${zero.length ? `<div class="note">${zero.length} other link${zero.length === 1 ? '' : 's'} had no clicks (shaded blue).</div>` : ''}
        ${unmatchedHtml}
      </div>
      <div class="card">
        <h2>How to read this</h2>
        <div class="legend"><span>No clicks</span><div class="bar"></div><span>Most clicks</span></div>
        <div class="note">Each link is shaded by how many people clicked it; the number badge is its rank. Counts are unique
          people, with automated security-scanner clicks removed. A person who clicked several links counts once in
          "People who clicked a link". Unsubscribe clicks are not included.</div>
      </div>
      <div class="foot">Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · SageRock Mail</div>
    </div>
  </div>
</div></body></html>`
}

async function lockedPage(browser, { width, scale }) {
  const page = await browser.newPage()
  await page.setJavaScriptEnabled(false)
  await page.setRequestInterception(true)
  page.on('request', async req => {
    try {
      const type = req.resourceType()
      const url = req.url()
      if (type === 'document' && (url === 'about:blank' || url.startsWith('data:'))) return req.continue()
      if (['image', 'stylesheet', 'font'].includes(type) && await publicUrl(url)) return req.continue()
      return req.abort()
    } catch {
      // request already handled
    }
  })
  await page.setViewport({ width, height: 1000, deviceScaleFactor: scale })
  return page
}

// Returns { buffer, contentType, filename }.
async function buildHeatmapReport({ campaign, client, html, linkStats, summary, format = 'png', puppeteer = require('puppeteer') }) {
  const { tagged, hrefs } = tagLinks(fillMergeTags(html, client))
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  try {
    // 1. The email alone: screenshot plus where each link sits.
    const emailPage = await lockedPage(browser, { width: EMAIL_WIDTH, scale: SCALE })
    await emailPage.setContent(tagged, { waitUntil: 'networkidle0', timeout: 25000 }).catch(() => {})
    const measured = await emailPage.evaluate(() => {
      const out = {}
      const text = {}
      document.querySelectorAll('a[data-hm]').forEach(a => {
        const i = a.getAttribute('data-hm')
        const rects = [...a.getClientRects()].filter(r => r.width > 2 && r.height > 2)
        // An image link's box is its image's box.
        const img = a.querySelector('img')
        const list = rects.length ? rects : (img ? [img.getBoundingClientRect()] : [])
        out[i] = list.map(r => ({ x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }))
        text[i] = (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) || (img && img.getAttribute('alt')) || ''
      })
      return { boxes: out, text, height: Math.ceil(document.documentElement.scrollHeight) }
    })
    const height = Math.min(measured.height, 12000)
    const shot = await emailPage.screenshot({ type: 'png', encoding: 'base64', clip: { x: 0, y: 0, width: EMAIL_WIDTH, height }, captureBeyondViewport: true })
    await emailPage.close()

    const textByIndex = hrefs.map((_, i) => measured.text[i] || '')
    const { rows, unmatched } = matchClicks(hrefs, linkStats, textByIndex)

    // 2. The report around it.
    const page = await lockedPage(browser, { width: 1240, scale: format === 'pdf' ? 1 : SCALE })
    await page.setContent(reportHtml({ campaign, client, summary, shot, boxes: measured.boxes, rows, unmatched }),
      { waitUntil: 'load', timeout: 25000 })
    const reportHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight))
    const base = `heatmap-${String(campaign.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`
    if (format === 'pdf') {
      const buffer = await page.pdf({ width: '1240px', height: `${reportHeight + 2}px`, printBackground: true, pageRanges: '1' })
      return { buffer: Buffer.from(buffer), contentType: 'application/pdf', filename: `${base}.pdf`, rows, unmatched }
    }
    await page.setViewport({ width: 1240, height: reportHeight, deviceScaleFactor: SCALE })
    const buffer = await page.screenshot({ type: 'png', fullPage: true })
    return { buffer: Buffer.from(buffer), contentType: 'image/png', filename: `${base}.png`, rows, unmatched }
  } finally {
    await browser.close()
  }
}

module.exports = { buildHeatmapReport, matchClicks, normalizeUrl, tagLinks, fillMergeTags, heatColor }
