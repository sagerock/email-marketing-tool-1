// One-time shrink of images already in the media library (uploads made before
// api/image-optimize.js ran on upload). PNGs are recompressed losslessly (and
// resized if over 1200px); JPEG/WebP are only touched when over 1200px. Rewrites each file IN PLACE, same key and
// same format, so every email already linking to it keeps working. The original
// bytes are copied to _originals/<key> first; --restore puts them back.
//
//   node scripts/optimize-media-library.mjs                 # dry run, all clients
//   node scripts/optimize-media-library.mjs --client=alderbrook-waldorf-school
//   node scripts/optimize-media-library.mjs --apply         # back up + rewrite
//   node scripts/optimize-media-library.mjs --restore [--client=prefix]
//
// Uses the default AWS credential chain (local profile or AWS_* env vars).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../api/package.json', import.meta.url))
require('dotenv').config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
const {
  ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand, CopyObjectCommand,
} = require('@aws-sdk/client-s3')
const { createClient } = require('@supabase/supabase-js')
const { s3, BUCKET } = require('./s3-client')
const { optimizeImage, MAX_DIMENSION } = require('./image-optimize')
const sharp = require('sharp')

const BACKUP_ROOT = '_originals/'
// Only rewrite when it's clearly worth it.
const MIN_SAVED_BYTES = 30 * 1024
const MAX_KEPT_RATIO = 0.75
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const restore = args.includes('--restore')
const onlyClient = args.find(a => a.startsWith('--client='))?.split('=')[1]

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { data: clients, error } = await supabase.from('clients').select('name, s3_prefix').not('s3_prefix', 'is', null)
if (error) throw error
const prefixes = clients.map(c => c.s3_prefix).filter(p => !onlyClient || p === onlyClient)
if (onlyClient && !prefixes.length) throw new Error(`No client has s3_prefix ${onlyClient}`)

async function listKeys(prefix) {
  const keys = []
  let token
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }))
    for (const o of page.Contents || []) keys.push({ key: o.Key, size: o.Size })
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function exists(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true }
  catch (err) { if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return false; throw err }
}

const kb = n => `${Math.round(n / 1024).toLocaleString()} KB`

if (restore) {
  let restored = 0
  for (const prefix of prefixes) {
    for (const { key } of await listKeys(`${BACKUP_ROOT}${prefix}/`)) {
      const target = key.slice(BACKUP_ROOT.length)
      await s3.send(new CopyObjectCommand({
        Bucket: BUCKET, Key: target, CopySource: `${BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
        MetadataDirective: 'COPY',
      }))
      console.log(`restored ${target}`)
      restored++
    }
  }
  console.log(`Restored ${restored} original(s).`)
  process.exit(0)
}

let scanned = 0, candidates = 0, before = 0, after = 0
for (const prefix of prefixes) {
  for (const { key, size } of await listKeys(`${prefix}/`)) {
    scanned++
    if (size < MIN_SAVED_BYTES) continue
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const mimetype = obj.ContentType
    if (!IMAGE_MIMES.has(mimetype)) continue
    const original = Buffer.from(await obj.Body.transformToByteArray())
    // PNG recompression is lossless. JPEG/WebP re-encoding is lossy, so files
    // already within email dimensions (often hand-exported for a live
    // campaign) are left exactly as they are.
    if (mimetype !== 'image/png') {
      const { width, height } = await sharp(original).metadata()
      if (Math.max(width, height) <= MAX_DIMENSION) continue
    }
    let r
    try { r = await optimizeImage(original, mimetype, { keepFormat: true }) }
    catch (err) { console.log(`skip ${key}: ${err.message}`); continue }
    if (!r.changed || original.length - r.bytes < MIN_SAVED_BYTES || r.bytes > original.length * MAX_KEPT_RATIO) continue

    candidates++
    before += original.length
    after += r.bytes
    console.log(`${apply ? 'shrink' : 'would shrink'} ${key}: ${kb(original.length)} -> ${kb(r.bytes)} (${r.width}x${r.height})`)
    if (!apply) continue

    const backupKey = `${BACKUP_ROOT}${key}`
    if (await exists(backupKey)) { console.log(`  backup already exists, leaving ${key} alone`); continue }
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: backupKey, Body: original, ContentType: mimetype, CacheControl: obj.CacheControl,
    }))
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: r.buffer, ContentType: mimetype, CacheControl: obj.CacheControl,
    }))
  }
}

console.log(`\nScanned ${scanned} file(s) across ${prefixes.length} client folder(s).`)
console.log(`${candidates} worth shrinking: ${kb(before)} -> ${kb(after)}${apply ? '' : '. Dry run; pass --apply to back up and rewrite.'}`)
