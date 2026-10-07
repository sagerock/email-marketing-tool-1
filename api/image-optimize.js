'use strict'

// Shrinks uploaded images to something sensible for email: longest side at
// most 1200px (2x the 600px email width, so it stays sharp on retina),
// orientation baked in, metadata (camera, GPS) stripped, and recompressed.
// WebP becomes JPEG/PNG because classic Outlook can't show WebP. Animated
// GIFs pass through untouched; resizing would drop or mangle the animation.

// If the native library ever fails to load (a bad build on a new platform),
// uploads fall back to storing the original instead of taking the server down.
let sharp = null
try {
  sharp = require('sharp')
} catch (err) {
  console.warn('[media] sharp unavailable, images will be stored unoptimized:', err.message)
}

const MAX_DIMENSION = 1200
const JPEG_QUALITY = 82
// An opaque PNG becomes a JPEG only when that's dramatically smaller, which
// means it's a photo. Screenshots and flat graphics compress well as PNG and
// would pick up JPEG smudging around text, so they stay PNG.
const PHOTO_PNG_RATIO = 0.5
// Otherwise-fine images are only re-saved when that saves at least 25%.
const MIN_SAVINGS_RATIO = 0.75

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

function passThrough(buffer, mimetype, meta = {}) {
  return {
    buffer,
    mimetype,
    ext: EXT[mimetype] || 'img',
    width: meta.width || null,
    height: meta.height || null,
    originalBytes: buffer.length,
    bytes: buffer.length,
    changed: false,
  }
}

// keepFormat: re-save in the same format (used when rewriting an existing file
// in place, where its URL and extension must keep working).
async function optimizeImage(buffer, mimetype, { keepFormat = false } = {}) {
  if (!sharp) return passThrough(buffer, mimetype)
  const input = sharp(buffer, { failOn: 'error', animated: true })
  const meta = await input.metadata()
  const width = meta.autoOrient?.width || meta.width
  const height = meta.autoOrient?.height || meta.height
  const animated = (meta.pages || 1) > 1

  if (mimetype === 'image/gif' || animated) return passThrough(buffer, mimetype, { width, height })

  const needsResize = Math.max(width, height) > MAX_DIMENSION
  const base = () => {
    const img = sharp(buffer, { failOn: 'error' }).rotate()
    return needsResize
      ? img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      : img
  }

  let out
  if (keepFormat && mimetype === 'image/webp') {
    const webp = await base().webp({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true })
    out = { mimetype, data: webp.data, info: webp.info }
  } else if (mimetype === 'image/jpeg' || (mimetype === 'image/webp' && !meta.hasAlpha)) {
    out = { mimetype: 'image/jpeg', ...(await toJpeg(base())) }
  } else {
    const png = await base().png({ compressionLevel: 9, effort: 8 }).toBuffer({ resolveWithObject: true })
    out = { mimetype: 'image/png', data: png.data, info: png.info }
    const opaque = !meta.hasAlpha || (await sharp(png.data).stats()).isOpaque
    if (opaque && !keepFormat) {
      const jpeg = await toJpeg(base())
      if (jpeg.data.length < png.data.length * PHOTO_PNG_RATIO) out = { mimetype: 'image/jpeg', ...jpeg }
    }
  }

  // Keep the original when nothing required a change (already small, upright,
  // email-safe, no metadata) and recompressing wouldn't save much. Re-saving a
  // JPEG for a small gain only adds another round of compression blur.
  const mustChange = needsResize || (mimetype === 'image/webp' && !keepFormat) ||
    (meta.orientation && meta.orientation !== 1) || meta.exif || meta.xmp
  if (!mustChange && out.data.length > buffer.length * MIN_SAVINGS_RATIO) {
    return passThrough(buffer, mimetype, { width, height })
  }

  return {
    buffer: out.data,
    mimetype: out.mimetype,
    ext: EXT[out.mimetype],
    width: out.info.width,
    height: out.info.height,
    originalBytes: buffer.length,
    bytes: out.data.length,
    changed: true,
  }
}

async function toJpeg(img) {
  const { data, info } = await img
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { data, info }
}

// "Holiday Photo.WEBP" + "jpg" -> "Holiday Photo.jpg"
function withExtension(filename, ext) {
  const base = String(filename || 'image').replace(/\.[a-z0-9]{1,5}$/i, '')
  return `${base}.${ext}`
}

module.exports = { optimizeImage, withExtension, MAX_DIMENSION }
