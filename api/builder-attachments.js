'use strict'

// Files a user attaches in the builder chat (images and PDFs). They are
// uploaded to the client's media library first (POST /api/media/upload), so a
// chat message only carries S3 keys. Here each key is checked against the
// client's prefix, read back from S3, and turned into content blocks: images
// as a picture the model can look at, PDFs as a document it can read. Both
// come with the file's exact public URL so the model can show or link it.

const { GetObjectCommand } = require('@aws-sdk/client-s3')

let sharp = null
try { sharp = require('sharp') } catch { /* images are labeled but not shown */ }

const MAX_PER_MESSAGE = 6
const MAX_PDF_BYTES = 20 * 1024 * 1024
const VIEW_MAX = 1000 // big enough to read a flyer, small enough to stay cheap
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const PDF_EXT = /\.pdf$/i

function attachmentKind(key) {
  if (PDF_EXT.test(key)) return 'pdf'
  if (IMAGE_EXT.test(key)) return 'image'
  return null
}

// Keeps only well-formed attachments under this client's prefix.
function normalizeAttachments(list, s3Prefix) {
  if (!Array.isArray(list) || !s3Prefix) return []
  const prefix = s3Prefix.endsWith('/') ? s3Prefix : `${s3Prefix}/`
  const out = []
  for (const item of list) {
    const key = typeof item?.key === 'string' ? item.key : ''
    if (!key.startsWith(prefix) || key.includes('..') || key.length > 500) continue
    const kind = attachmentKind(key)
    if (!kind) continue
    const name = String(item?.name || key.split('/').pop()).replace(/[\r\n"<>]/g, ' ').slice(0, 120)
    out.push({ key, kind, name })
    if (out.length === MAX_PER_MESSAGE) break
  }
  return out
}

const cache = new Map()
const CACHE_LIMIT = 40

async function readObject(s3, bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (res.ContentLength > MAX_PDF_BYTES) throw new Error('file is too large')
  return Buffer.from(await res.Body.transformToByteArray())
}

async function blocksFor(s3, bucket, publicUrlForKey, file) {
  if (cache.has(file.key)) return cache.get(file.key)
  const url = publicUrlForKey(file.key)
  const buffer = await readObject(s3, bucket, file.key)
  let blocks
  if (file.kind === 'pdf') {
    blocks = [
      { type: 'text', text: `Attached PDF "${file.name}", hosted at ${url}. Read it for content. If the email should link to it (for example a "Download the flyer" button), use this exact URL.` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }, title: file.name },
    ]
  } else {
    let size = ''
    let view = null
    if (sharp) {
      const meta = await sharp(buffer, { failOn: 'error' }).metadata()
      size = ` — ${meta.autoOrient?.width || meta.width}×${meta.autoOrient?.height || meta.height}px`
      view = await sharp(buffer, { failOn: 'error' })
        .rotate()
        .resize({ width: VIEW_MAX, height: VIEW_MAX, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 75 })
        .toBuffer()
    }
    blocks = [{ type: 'text', text: `Attached image "${file.name}", hosted at ${url}${size}. To show it in the email, use this exact URL.` }]
    if (view) blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: view.toString('base64') } })
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(file.key, blocks)
  return blocks
}

// Content blocks for one message's attachments. A file that can't be read is
// reported to the model by name rather than failing the whole request.
async function attachmentBlocks({ s3, bucket, publicUrlForKey, attachments }) {
  const blocks = []
  for (const file of attachments) {
    try {
      blocks.push(...await blocksFor(s3, bucket, publicUrlForKey, file))
    } catch (err) {
      console.error(`[builder-attachments] could not read ${file.key}:`, err.message)
      blocks.push({ type: 'text', text: `(The attached file "${file.name}" couldn't be opened. Tell the user so they can try attaching it again.)` })
    }
  }
  return blocks
}

module.exports = { normalizeAttachments, attachmentBlocks, attachmentKind, MAX_PER_MESSAGE }
