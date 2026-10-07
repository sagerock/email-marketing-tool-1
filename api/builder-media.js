'use strict'

// Gives the email builder the client's media library: the most recent uploads
// as small thumbnails, each labeled with its exact public URL and full-size
// dimensions, so the model can see what a photo shows and place it correctly
// instead of inventing image URLs. Thumbnails cost ~100 input tokens each and
// sit in the cached prefix of the conversation.

const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3')

let sharp = null
try { sharp = require('sharp') } catch { /* no thumbnails; builder runs without media */ }

const MAX_IMAGES = 24
const THUMB_MAX = 320
const FETCH_CONCURRENCY = 4
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const CACHE_LIMIT = 500

// key + ETag -> { width, height, thumb } (base64 JPEG). An ETag changes when
// the object is rewritten, so a re-optimized file gets a fresh entry.
const cache = new Map()

function remember(id, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(id, value)
}

async function listRecentImages(s3, bucket, s3Prefix) {
  const prefix = s3Prefix.endsWith('/') ? s3Prefix : `${s3Prefix}/`
  const objects = []
  let token
  let pages = 0
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
    for (const o of out.Contents || []) {
      const name = o.Key.split('/').pop() || ''
      if (!IMAGE_EXT.test(name) || name.startsWith('stripothumbnailurl')) continue
      objects.push(o)
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token && ++pages < 5)
  return objects
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
    .slice(0, MAX_IMAGES)
}

async function describeImage(s3, bucket, object) {
  const id = `${object.Key}:${object.ETag}`
  if (cache.has(id)) return cache.get(id)
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }))
  const buffer = Buffer.from(await res.Body.transformToByteArray())
  const img = sharp(buffer, { failOn: 'error' })
  const meta = await img.metadata()
  const width = meta.autoOrient?.width || meta.width
  const height = meta.autoOrient?.height || meta.height
  const thumb = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 70 })
    .toBuffer()
  const value = { width, height, thumb: thumb.toString('base64') }
  remember(id, value)
  return value
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      try { results[i] = await fn(items[i]) } catch { results[i] = null }
    }
  })
  await Promise.all(workers)
  return results
}

// Returns Anthropic content blocks (text labels + image thumbnails), or [] when
// the client has no media, no prefix, or the library can't be read.
async function mediaLibraryBlocks({ s3, bucket, s3Prefix, publicUrlForKey }) {
  if (!sharp || !s3Prefix) return []
  let objects
  try {
    objects = await listRecentImages(s3, bucket, s3Prefix)
  } catch (err) {
    console.warn('[email-builder] media library unavailable:', err.message)
    return []
  }
  if (!objects.length) return []

  const described = await mapLimit(objects, FETCH_CONCURRENCY, o => describeImage(s3, bucket, o))
  const blocks = []
  let n = 0
  objects.forEach((o, i) => {
    const d = described[i]
    if (!d) return
    n++
    const name = o.Key.split('/').pop()
    blocks.push({ type: 'text', text: `Image ${n}: ${publicUrlForKey(o.Key)} — ${d.width}×${d.height}px, file "${name}"` })
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d.thumb } })
  })
  if (!blocks.length) return []
  return [
    { type: 'text', text: `<media_library>\nThe client's uploaded images, newest first. Each thumbnail follows its label; the label has the exact URL and full-size dimensions.` },
    ...blocks,
    { type: 'text', text: '</media_library>' },
  ]
}

const MEDIA_PROMPT = `MEDIA LIBRARY:
- The first user message may include a <media_library>: the client's uploaded images as thumbnails, each labeled with its exact URL and full-size dimensions.
- When the email needs an image (logo, photo, hero, product), choose from the library by what you see in the thumbnails, and use the labeled URL exactly.
- Set width/height attributes that fit the layout (600px email, so usually ≤ 600 wide) while keeping the image's aspect ratio from its full-size dimensions. Write alt text that describes what the image shows.
- Never invent or guess image URLs. If nothing in the library fits, say so and suggest uploading one under Media, rather than using a placeholder.`

module.exports = { mediaLibraryBlocks, MEDIA_PROMPT, MAX_IMAGES }
