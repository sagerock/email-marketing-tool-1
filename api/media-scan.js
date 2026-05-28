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

module.exports = { extractImageUrls, filenameFromUrl }
