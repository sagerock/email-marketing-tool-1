'use strict'

// Free photos from Pixabay for the builder's Stock photos panel. Pixabay's API
// rules shape this: search results are cached for 24 hours, their image URLs
// are only used to show results in the panel, and a photo that's actually
// used is downloaded to our own server (the client's media library), sized
// and cropped for its slot, before it goes in the email. The panel credits
// Pixabay and the photographer wherever results are shown.

const { PutObjectCommand } = require('@aws-sdk/client-s3')

let sharp = null
try { sharp = require('sharp') } catch { /* uploads fall back to Pixabay's 1280px JPEG as-is */ }

const API = 'https://pixabay.com/api/'
const PER_PAGE = 12
const CACHE_MS = 24 * 60 * 60 * 1000
const CACHE_LIMIT = 500
const MAX_BYTES = 15 * 1024 * 1024
const ORIENTATION = { horizontal: 'horizontal', panoramic: 'horizontal', vertical: 'vertical' }

class PixabayError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.status = status
  }
}

const cache = new Map()

function apiKey() {
  return process.env.PIXABAY_API_KEY || ''
}

function remember(id, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(id, { at: Date.now(), value })
}

function cached(id) {
  const hit = cache.get(id)
  return hit && Date.now() - hit.at < CACHE_MS ? hit.value : undefined
}

async function call(params, fetchImpl) {
  const key = apiKey()
  if (!key) throw new PixabayError('Pixabay photo search isn’t set up yet.', 503)
  const res = await fetchImpl(`${API}?${new URLSearchParams({ key, ...params })}`)
  if (res.status === 429) throw new PixabayError('Pixabay search is busy. Try again in a minute.', 429)
  if (!res.ok) throw new PixabayError(`Pixabay returned ${res.status}`)
  return res.json()
}

function profileUrl(hit) {
  return hit.user && hit.user_id ? `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/` : 'https://pixabay.com/'
}

function shape(hit) {
  return {
    id: String(hit.id),
    alt: String(hit.tags || '').split(',').slice(0, 4).map(t => t.trim()).filter(Boolean).join(', '),
    thumb: hit.webformatURL || hit.previewURL || '',
    color: null,
    photographer: hit.user || 'Pixabay',
    photographer_url: profileUrl(hit),
    source_url: hit.pageURL || 'https://pixabay.com/',
  }
}

async function searchPhotos({ query, orientation, page = 1 }, fetchImpl = fetch) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  if (!q) throw new PixabayError('Type something to search for', 400)
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), 20)
  const o = ORIENTATION[orientation] || 'all'
  const id = `search|${q.toLowerCase()}|${o}|${p}`
  const hit = cached(id)
  if (hit) return hit
  const data = await call({ q, image_type: 'photo', orientation: o, safesearch: 'true', per_page: String(PER_PAGE), page: String(p) }, fetchImpl)
  const hits = data.hits || []
  hits.forEach(h => remember(`photo|${h.id}`, h))
  const value = { photos: hits.map(shape), total_pages: Math.ceil(Math.min(data.totalHits || 0, 500) / PER_PAGE), page: p }
  remember(id, value)
  return value
}

// Crop to the slot's shape when both sides are known (2x for sharp screens),
// otherwise scale to its width. Always a JPEG, which every email client shows.
async function fitForSlot(buffer, width, height) {
  if (!sharp) return buffer
  const w = Math.min(Math.max(Math.round(width || 600), 50) * 2, 1200)
  const img = sharp(buffer, { failOn: 'error' }).rotate()
  const sized = height
    ? img.resize({ width: w, height: Math.round(w * height / (width || 600)), fit: 'cover', position: 'attention' })
    : img.resize({ width: w, withoutEnlargement: true })
  return sized.jpeg({ quality: 80, mozjpeg: true }).toBuffer()
}

function slug(text) {
  return String(text || 'photo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'photo'
}

// Called when the user picks a photo: downloads it from Pixabay, fits it to
// the slot, stores it under the client's media prefix, and returns our URL.
async function usePhoto({ id, width, height, s3Prefix, s3, bucket, publicUrlForKey }, fetchImpl = fetch) {
  if (!/^\d{1,12}$/.test(String(id ?? ''))) throw new PixabayError('Unknown photo', 400)
  if (!s3Prefix) throw new PixabayError('This client has no media library set up', 400)
  let hit = cached(`photo|${id}`)
  if (!hit) {
    const data = await call({ id: String(id) }, fetchImpl)
    hit = (data.hits || [])[0]
    if (!hit) throw new PixabayError('That photo is no longer on Pixabay', 404)
  }
  const source = hit.largeImageURL || hit.webformatURL
  if (!/^https:\/\/(pixabay\.com|cdn\.pixabay\.com)\//.test(String(source || ''))) throw new PixabayError('Unexpected image address')
  const res = await fetchImpl(source)
  if (!res.ok) throw new PixabayError(`Pixabay image download failed (${res.status})`)
  const original = Buffer.from(await res.arrayBuffer())
  if (original.length > MAX_BYTES) throw new PixabayError('That photo is too large')
  const w = Number(width) || null
  const h = Number(height) || null
  const body = await fitForSlot(original, w, h)
  const prefix = s3Prefix.endsWith('/') ? s3Prefix : `${s3Prefix}/`
  const key = `${prefix}${Date.now()}-pixabay-${hit.id}-${slug(hit.tags?.split(',')[0])}.jpg`
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/jpeg' }))
  return {
    ...shape(hit),
    url: publicUrlForKey(key),
    key,
    height: h || (w ? Math.round(w * hit.imageHeight / hit.imageWidth) : null),
  }
}

module.exports = { searchPhotos, usePhoto, fitForSlot, PixabayError }
