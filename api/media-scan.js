// api/media-scan.js
'use strict'

const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/gi

function extractImageUrls(html) {
  if (!html || typeof html !== 'string') return []
  const seen = new Set()
  const out = []
  for (const match of html.matchAll(IMG_SRC_RE)) {
    const url = match[1]
    if (!seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts[parts.length - 1] || ''
  } catch {
    return url
  }
}

// Scans templates and sequence_steps for image URLs and upserts them
// into discovered_media_urls. Returns { scanned, discovered }.
async function scanClientHtml(supabase, clientId) {
  const sources = []

  const { data: templates, error: tErr } = await supabase
    .from('templates')
    .select('id, html_content')
    .eq('client_id', clientId)
    .not('html_content', 'is', null)
  if (tErr) throw tErr
  for (const row of templates || []) {
    sources.push({ id: row.id, kind: 'template', html: row.html_content })
  }

  // sequence_steps don't have client_id directly — join via email_sequences
  const { data: steps, error: sErr } = await supabase
    .from('sequence_steps')
    .select('id, html_content, email_sequences!inner(client_id)')
    .eq('email_sequences.client_id', clientId)
    .not('html_content', 'is', null)
  if (sErr) throw sErr
  for (const row of steps || []) {
    sources.push({ id: row.id, kind: 'sequence_step', html: row.html_content })
  }

  const firstSeenByUrl = new Map() // url -> 'template:uuid' or 'sequence_step:uuid'
  for (const src of sources) {
    for (const url of extractImageUrls(src.html)) {
      if (!firstSeenByUrl.has(url)) {
        firstSeenByUrl.set(url, `${src.kind}:${src.id}`)
      }
    }
  }

  if (firstSeenByUrl.size === 0) {
    return { scanned: sources.length, discovered: 0 }
  }

  const now = new Date().toISOString()
  const rows = Array.from(firstSeenByUrl.entries()).map(([url, firstSeenIn]) => ({
    client_id: clientId,
    url,
    filename: filenameFromUrl(url),
    first_seen_in: firstSeenIn,
    last_scanned_at: now,
  }))

  // Insert fresh rows, update last_scanned_at on existing rows
  const { data: existing } = await supabase
    .from('discovered_media_urls')
    .select('url')
    .eq('client_id', clientId)
    .in('url', Array.from(firstSeenByUrl.keys()))
  const existingUrls = new Set((existing || []).map((r) => r.url))
  const fresh = rows.filter((r) => !existingUrls.has(r.url))
  const stale = rows.filter((r) => existingUrls.has(r.url))

  if (fresh.length) {
    const { error: insErr } = await supabase.from('discovered_media_urls').insert(fresh)
    if (insErr) throw insErr
  }
  if (stale.length) {
    const { error: updErr } = await supabase
      .from('discovered_media_urls')
      .update({ last_scanned_at: now })
      .eq('client_id', clientId)
      .in('url', stale.map((r) => r.url))
    if (updErr) throw updErr
  }

  return { scanned: sources.length, discovered: fresh.length }
}

module.exports = { extractImageUrls, filenameFromUrl, scanClientHtml }
