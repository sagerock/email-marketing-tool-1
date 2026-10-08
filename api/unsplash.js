'use strict'

// Free photos from Unsplash for the builder's Stock photos panel. Unsplash's
// API guidelines shape this: images are hotlinked from images.unsplash.com
// (never re-hosted), choosing a photo pings its download_location, and the
// photographer and Unsplash are credited where photos are shown in our tool.
// The image URL is sized for the email slot with Unsplash's own URL options
// (crop to the slot's shape, JPEG so classic Outlook can show it).

const API = 'https://api.unsplash.com'
const UTM = 'utm_source=sagerock_email_tool&utm_medium=referral'
const ORIENTATION = { horizontal: 'landscape', panoramic: 'landscape', vertical: 'portrait', square: 'squarish' }
const PER_PAGE = 12
const CACHE_MS = 60 * 60 * 1000
const CACHE_LIMIT = 300

class UnsplashError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.status = status
  }
}

const cache = new Map()

function accessKey() {
  return process.env.UNSPLASH_ACCESS_KEY || ''
}

function withUtm(url) {
  if (!url) return ''
  return `${url}${url.includes('?') ? '&' : '?'}${UTM}`
}

async function call(path, fetchImpl) {
  const key = accessKey()
  if (!key) throw new UnsplashError('Free photo search isn’t set up yet.', 503)
  const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' } })
  if (res.status === 403 || res.status === 429) {
    throw new UnsplashError('Free photo search hit Unsplash’s hourly limit. Try again in a little while, or use Adobe Stock.', 429)
  }
  if (!res.ok) throw new UnsplashError(`Unsplash returned ${res.status}`)
  return res.json()
}

function isFree(photo) {
  // Unsplash+ photos need a paid license; leave them out.
  return !photo.premium && !photo.plus && !String(photo.urls?.raw || '').includes('plus.unsplash.com')
}

function shape(photo) {
  return {
    id: photo.id,
    alt: String(photo.alt_description || photo.description || '').slice(0, 200),
    width: photo.width,
    height: photo.height,
    color: photo.color || null,
    thumb: photo.urls?.small || photo.urls?.thumb || '',
    photographer: photo.user?.name || 'Unknown',
    photographer_url: withUtm(photo.user?.links?.html),
    source_url: withUtm(photo.links?.html),
  }
}

async function searchPhotos({ query, orientation, page = 1 }, fetchImpl = fetch) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  if (!q) throw new UnsplashError('Type something to search for', 400)
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), 20)
  const o = ORIENTATION[orientation] || ''
  const id = `${q.toLowerCase()}|${o}|${p}`
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const params = new URLSearchParams({ query: q, per_page: String(PER_PAGE), page: String(p), content_filter: 'high' })
  if (o) params.set('orientation', o)
  const data = await call(`/search/photos?${params}`, fetchImpl)
  const value = { photos: (data.results || []).filter(isFree).map(shape), total_pages: data.total_pages || 0, page: p }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(id, { at: Date.now(), value })
  return value
}

// The URL to put in the email, sized for the slot: cropped to its shape when
// both width and height are known, otherwise scaled to its width.
function emailUrl(raw, width, height) {
  const w = Number.isFinite(width) && width > 0 ? Math.min(Math.round(width), 1200) : 600
  const params = new URLSearchParams({ fm: 'jpg', q: '80' })
  if (Number.isFinite(height) && height > 0) {
    params.set('w', String(Math.min(w * 2, 2400)))
    params.set('h', String(Math.round(Math.min(w * 2, 2400) * height / w)))
    params.set('fit', 'crop')
    params.set('crop', 'entropy')
  } else {
    params.set('w', String(Math.min(w * 2, 2400)))
    params.set('fit', 'max')
  }
  return `${raw}${raw.includes('?') ? '&' : '?'}${params}`
}

// Called when the user picks a photo: looks it up again (the browser only
// sends an id), records the download as Unsplash requires, and returns the
// URL for the email plus the credit.
async function usePhoto({ id, width, height }, fetchImpl = fetch) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{5,32}$/.test(id)) throw new UnsplashError('Unknown photo', 400)
  const photo = await call(`/photos/${id}`, fetchImpl)
  if (!isFree(photo)) throw new UnsplashError('That photo needs an Unsplash+ license', 400)
  const raw = String(photo.urls?.raw || '')
  if (!/^https:\/\/images\.unsplash\.com\//.test(raw)) throw new UnsplashError('Unexpected image address')
  const download = String(photo.links?.download_location || '')
  if (download.startsWith(`${API}/`)) {
    await call(download.slice(API.length), fetchImpl).catch(err => console.warn('[unsplash] download ping failed:', err.message))
  }
  const w = Number(width) || null
  const h = Number(height) || null
  return {
    ...shape(photo),
    url: emailUrl(raw, w, h),
    // Keep the slot's shape; with no height, report the one the photo will have.
    height: h || (w ? Math.round(w * photo.height / photo.width) : null),
  }
}

module.exports = { searchPhotos, usePhoto, emailUrl, UnsplashError }
