'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { normalizeAttachments, attachmentBlocks } = require('./builder-attachments')

const prefix = 'guids/CABINET_abc/images'

test('normalizeAttachments keeps only images and PDFs under the client prefix', () => {
  const out = normalizeAttachments([
    { key: `${prefix}/1-flyer.pdf`, name: 'Flyer.pdf' },
    { key: `${prefix}/2-photo.jpg`, name: 'Photo "big".jpg' },
    { key: 'guids/OTHER/images/3-x.png' },
    { key: `${prefix}/../OTHER/4-x.png` },
    { key: `${prefix}/5-notes.docx` },
    { key: 42 },
  ], prefix)
  assert.deepEqual(out, [
    { key: `${prefix}/1-flyer.pdf`, kind: 'pdf', name: 'Flyer.pdf' },
    { key: `${prefix}/2-photo.jpg`, kind: 'image', name: 'Photo  big .jpg' },
  ])
  assert.deepEqual(normalizeAttachments('nope', prefix), [])
  assert.deepEqual(normalizeAttachments([{ key: `${prefix}/a.png` }], null), [])
  assert.equal(normalizeAttachments(Array.from({ length: 9 }, (_, i) => ({ key: `${prefix}/${i}.png` })), prefix).length, 6)
})

test('attachmentBlocks shows images, reads PDFs, and labels each with its URL', async () => {
  const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#2e7cc9' } }).png().toBuffer()
  const pdf = Buffer.from('%PDF-1.4\n%fake\n')
  const objects = { [`${prefix}/a.png`]: png, [`${prefix}/b.pdf`]: pdf }
  const s3 = { send: async cmd => {
    const body = objects[cmd.input.Key]
    if (!body) throw new Error('NoSuchKey')
    return { ContentLength: body.length, Body: { transformToByteArray: async () => body } }
  } }
  const blocks = await attachmentBlocks({
    s3, bucket: 'b', publicUrlForKey: k => `https://cdn.test/${k}`,
    attachments: [
      { key: `${prefix}/a.png`, kind: 'image', name: 'a.png' },
      { key: `${prefix}/b.pdf`, kind: 'pdf', name: 'b.pdf' },
      { key: `${prefix}/missing.png`, kind: 'image', name: 'missing.png' },
    ],
  })
  assert.match(blocks[0].text, /https:\/\/cdn\.test\/.*a\.png — 2400×1200px/)
  assert.equal(blocks[1].type, 'image')
  const view = await sharp(Buffer.from(blocks[1].source.data, 'base64')).metadata()
  assert.equal(view.width, 1000, 'big images are shrunk for the model')
  assert.match(blocks[2].text, /Attached PDF "b\.pdf", hosted at https:\/\/cdn\.test\/.*b\.pdf/)
  assert.deepEqual(blocks[3].source, { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') })
  assert.match(blocks[4].text, /"missing\.png" couldn't be opened/)
})
