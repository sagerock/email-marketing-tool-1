'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { mediaLibraryBlocks } = require('./builder-media')

async function png(width, height, color) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

function fakeS3(objects) {
  const gets = []
  return {
    gets,
    async send(cmd) {
      const name = cmd.constructor.name
      if (name === 'ListObjectsV2Command') {
        return { Contents: objects.map(o => ({ Key: o.key, ETag: o.etag || '"1"', LastModified: o.modified })) }
      }
      if (name === 'GetObjectCommand') {
        gets.push(cmd.input.Key)
        const o = objects.find(x => x.key === cmd.input.Key)
        if (o.broken) throw new Error('boom')
        return { Body: { transformToByteArray: async () => o.body } }
      }
      throw new Error(`unexpected ${name}`)
    },
  }
}

const url = key => `https://bucket.example/${key}`

test('labels newest images first with exact URL and full-size dimensions, plus thumbnails', async () => {
  const s3 = fakeS3([
    { key: 'school/old-garden.jpg', modified: '2026-01-01', body: await png(2000, 1000, '#3A6B35') },
    { key: 'school/logo.png', modified: '2026-10-07', body: await png(1200, 900, '#D4A853') },
    { key: 'school/notes.pdf', modified: '2026-10-07', body: Buffer.from('x') },
    { key: 'school/broken.png', modified: '2026-05-01', body: null, broken: true },
  ])
  const blocks = await mediaLibraryBlocks({ s3, bucket: 'b', s3Prefix: 'school', publicUrlForKey: url })
  const labels = blocks.filter(b => b.type === 'text').map(b => b.text)
  assert.match(labels[0], /^<media_library>/)
  assert.equal(labels[1], 'Image 1: https://bucket.example/school/logo.png — 1200×900px, file "logo.png"')
  assert.equal(labels[2], 'Image 2: https://bucket.example/school/old-garden.jpg — 2000×1000px, file "old-garden.jpg"')
  assert.equal(labels.at(-1), '</media_library>')
  assert.ok(!labels.join('\n').includes('notes.pdf'), 'non-images are skipped')
  assert.ok(!labels.join('\n').includes('broken.png'), 'unreadable images are skipped')

  const images = blocks.filter(b => b.type === 'image')
  assert.equal(images.length, 2)
  const thumb = await sharp(Buffer.from(images[1].source.data, 'base64')).metadata()
  assert.equal(images[1].source.media_type, 'image/jpeg')
  assert.deepEqual([thumb.width, thumb.height], [320, 160])
})

test('thumbnails are cached by key and ETag', async () => {
  const objects = [{ key: 'cache/a.png', etag: '"v1"', modified: '2026-10-07', body: await png(100, 100, '#ffffff') }]
  const s3 = fakeS3(objects)
  await mediaLibraryBlocks({ s3, bucket: 'b', s3Prefix: 'cache/', publicUrlForKey: url })
  await mediaLibraryBlocks({ s3, bucket: 'b', s3Prefix: 'cache/', publicUrlForKey: url })
  assert.equal(s3.gets.length, 1)
  objects[0].etag = '"v2"'
  await mediaLibraryBlocks({ s3, bucket: 'b', s3Prefix: 'cache/', publicUrlForKey: url })
  assert.equal(s3.gets.length, 2)
})

test('no prefix, empty library, or a listing failure yields no blocks', async () => {
  assert.deepEqual(await mediaLibraryBlocks({ s3: fakeS3([]), bucket: 'b', s3Prefix: null, publicUrlForKey: url }), [])
  assert.deepEqual(await mediaLibraryBlocks({ s3: fakeS3([]), bucket: 'b', s3Prefix: 'empty', publicUrlForKey: url }), [])
  const failing = { send: async () => { throw new Error('denied') } }
  assert.deepEqual(await mediaLibraryBlocks({ s3: failing, bucket: 'b', s3Prefix: 'x', publicUrlForKey: url }), [])
})
