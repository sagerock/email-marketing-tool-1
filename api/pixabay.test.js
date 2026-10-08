'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')

process.env.PIXABAY_API_KEY = 'test-key'
const { searchPhotos, usePhoto, PixabayError } = require('./pixabay')

const hit = (id, extra = {}) => ({
  id, tags: 'school, garden, children, nature, kids', user: 'Carola68', user_id: 42,
  pageURL: `https://pixabay.com/photos/school-${id}/`, webformatURL: `https://pixabay.com/get/g${id}_640.jpg`,
  largeImageURL: `https://pixabay.com/get/g${id}_1280.jpg`, imageWidth: 4000, imageHeight: 2000, ...extra,
})

function fakeFetch(routes) {
  const calls = []
  const fn = async url => {
    calls.push(url)
    for (const [match, body, status = 200] of routes) {
      if (url.includes(match)) return { ok: status < 400, status, json: async () => body, arrayBuffer: async () => body }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  fn.calls = calls
  return fn
}

test('searchPhotos asks for safe photos, credits Pixabay, and caches for a day', async () => {
  const f = fakeFetch([['pixabay.com/api/', { totalHits: 500, hits: [hit(101)] }]])
  const out = await searchPhotos({ query: ' school  garden ', orientation: 'vertical' }, f)
  const url = new URL(f.calls[0])
  assert.deepEqual(['q', 'image_type', 'orientation', 'safesearch', 'key'].map(k => url.searchParams.get(k)), ['school garden', 'photo', 'vertical', 'true', 'test-key'])
  assert.deepEqual(out.photos[0], { id: '101', alt: 'school, garden, children, nature', thumb: 'https://pixabay.com/get/g101_640.jpg', color: null,
    photographer: 'Carola68', photographer_url: 'https://pixabay.com/users/Carola68-42/', source_url: 'https://pixabay.com/photos/school-101/' })
  assert.equal(out.total_pages, 42)
  await searchPhotos({ query: 'School garden', orientation: 'vertical' }, f)
  assert.equal(f.calls.length, 1, 'cached')
})

test('usePhoto downloads, crops to the slot, stores it in the client library, and returns our URL', async () => {
  const big = await sharp({ create: { width: 1280, height: 640, channels: 3, background: '#2e7cc9' } }).png().toBuffer()
  const f = fakeFetch([['_1280.jpg', big], ['pixabay.com/api/', { hits: [hit(202)] }]])
  const puts = []
  const s3 = { send: async cmd => { puts.push(cmd.input) } }
  const out = await usePhoto({ id: '202', width: 510, height: 293, s3Prefix: 'sagerock', s3, bucket: 'b', publicUrlForKey: k => `https://cdn.test/${k}` }, f)
  assert.equal(puts.length, 1)
  assert.match(puts[0].Key, /^sagerock\/\d+-pixabay-202-school\.jpg$/)
  assert.equal(puts[0].ContentType, 'image/jpeg')
  const meta = await sharp(puts[0].Body).metadata()
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1020, 586], 'cropped to the 510x293 slot at 2x')
  assert.equal(out.url, `https://cdn.test/${puts[0].Key}`)
  assert.equal(out.height, 293)
  await assert.rejects(usePhoto({ id: 'abc', s3Prefix: 'x' }, f), PixabayError)
  await assert.rejects(usePhoto({ id: '1', s3Prefix: '' }, f), /media library/)
})

test('usePhoto refuses image URLs that are not Pixabay’s', async () => {
  const f = fakeFetch([['pixabay.com/api/', { hits: [hit(303, { largeImageURL: 'https://evil.example/x.jpg', webformatURL: '' })] }]])
  await assert.rejects(usePhoto({ id: '303', s3Prefix: 'p', s3: { send: async () => {} }, bucket: 'b', publicUrlForKey: k => k }, f), /Unexpected image address/)
})
