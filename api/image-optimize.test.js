'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { optimizeImage, withExtension, MAX_DIMENSION } = require('./image-optimize')

// Busy pixels so JPEG/PNG sizes behave like a real photo, not a flat fill.
function noise(width, height, channels = 3) {
  const buf = Buffer.alloc(width * height * channels)
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7919) % 251
  return sharp(buf, { raw: { width, height, channels } })
}

test('large phone photo is resized, upright, stripped, and much smaller', async () => {
  const photo = await noise(400, 300).resize(4000, 3000)
    .jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer()
  const r = await optimizeImage(photo, 'image/jpeg')
  assert.equal(r.changed, true)
  assert.equal(r.mimetype, 'image/jpeg')
  assert.equal(r.ext, 'jpg')
  // Orientation 6 = rotated 90°, so the stored image is portrait.
  assert.deepEqual([r.width, r.height], [900, MAX_DIMENSION])
  assert.ok(r.bytes < r.originalBytes / 4)
  const meta = await sharp(r.buffer).metadata()
  assert.equal(meta.orientation, undefined)
  assert.equal(meta.exif, undefined)
})

test('transparent PNG stays PNG with its transparency', async () => {
  const logo = await sharp({ create: { width: 2400, height: 1800, channels: 4, background: { r: 58, g: 107, b: 53, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="2400" height="1800"><circle cx="1200" cy="900" r="700" fill="#3A6B35"/></svg>') }])
    .png().toBuffer()
  const r = await optimizeImage(logo, 'image/png')
  assert.equal(r.mimetype, 'image/png')
  assert.deepEqual([r.width, r.height], [1200, 900])
  assert.equal((await sharp(r.buffer).metadata()).hasAlpha, true)
})

test('opaque photo saved as PNG becomes JPEG; a flat screenshot stays PNG', async () => {
  // Random pixels scaled up: smooth, unpredictable gradients like a real photo.
  const rand = require('node:crypto').randomBytes(160 * 120 * 3)
  const photoPng = await sharp(rand, { raw: { width: 160, height: 120, channels: 3 } })
    .resize(1600, 1200).png().toBuffer()
  const photo = await optimizeImage(photoPng, 'image/png')
  assert.equal(photo.mimetype, 'image/jpeg')

  const shot = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#f0f0f0' } })
    .composite([{ input: Buffer.from('<svg width="1600" height="1000"><text x="50" y="200" font-size="80">Hello families</text></svg>') }])
    .png().toBuffer()
  const screenshot = await optimizeImage(shot, 'image/png')
  assert.equal(screenshot.mimetype, 'image/png')
  assert.equal(screenshot.width, 1200)
})

test('WebP is converted for Outlook even when small', async () => {
  const opaque = await optimizeImage(await noise(300, 200).webp().toBuffer(), 'image/webp')
  assert.equal(opaque.mimetype, 'image/jpeg')
  assert.equal(opaque.changed, true)
  const clear = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).webp().toBuffer()
  assert.equal((await optimizeImage(clear, 'image/webp')).mimetype, 'image/png')
})

test('small, already-good images and GIFs are kept byte-for-byte', async () => {
  const small = await noise(400, 300).jpeg({ quality: 80 }).toBuffer()
  const r = await optimizeImage(small, 'image/jpeg')
  assert.equal(r.changed, false)
  assert.equal(r.buffer, small)

  const gif = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: '#123456' } }).gif().toBuffer()
  const g = await optimizeImage(gif, 'image/gif')
  assert.equal(g.changed, false)
  assert.equal(g.buffer, gif)
})

test('keepFormat re-saves in the original format', async () => {
  const rand = require('node:crypto').randomBytes(160 * 120 * 3)
  const photoPng = await sharp(rand, { raw: { width: 160, height: 120, channels: 3 } }).resize(1600, 1200).png().toBuffer()
  const png = await optimizeImage(photoPng, 'image/png', { keepFormat: true })
  assert.equal(png.mimetype, 'image/png')
  assert.equal(png.width, 1200)
  const webp = await optimizeImage(await noise(2000, 1000).webp().toBuffer(), 'image/webp', { keepFormat: true })
  assert.equal(webp.mimetype, 'image/webp')
  assert.equal(webp.width, 1200)
})

test('a non-image is rejected', async () => {
  await assert.rejects(() => optimizeImage(Buffer.from('not an image'), 'image/png'))
})

test('withExtension swaps or adds the extension', () => {
  assert.equal(withExtension('Holiday Photo.WEBP', 'jpg'), 'Holiday Photo.jpg')
  assert.equal(withExtension('logo', 'png'), 'logo.png')
  assert.equal(withExtension('', 'png'), 'image.png')
})
