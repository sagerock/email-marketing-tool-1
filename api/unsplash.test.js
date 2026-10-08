'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.UNSPLASH_ACCESS_KEY = 'test-key'
const { searchPhotos, usePhoto, emailUrl, UnsplashError } = require('./unsplash')

const photo = (id, extra = {}) => ({
  id, width: 6000, height: 4000, alt_description: 'kids in a garden', color: '#336633',
  urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc`, small: `https://images.unsplash.com/photo-${id}?w=400` },
  user: { name: 'Ana Ruiz', links: { html: 'https://unsplash.com/@ana' } },
  links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download?ixid=abc` },
  ...extra,
})

function fakeFetch(routes) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization })
    for (const [match, body, status = 200] of routes) {
      if (url.includes(match)) return { ok: status < 400, status, json: async () => body }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  fn.calls = calls
  return fn
}

test('searchPhotos maps orientation, drops Unsplash+ photos, credits with UTM, and caches', async () => {
  const f = fakeFetch([['/search/photos', { total_pages: 3, results: [photo('aaaaa1'), photo('bbbbb2', { premium: true }), photo('ccccc3', { urls: { raw: 'https://plus.unsplash.com/x' } })] }]])
  const out = await searchPhotos({ query: '  school   garden ', orientation: 'vertical' }, f)
  assert.equal(out.photos.length, 1)
  assert.equal(out.photos[0].photographer_url, 'https://unsplash.com/@ana?utm_source=sagerock_email_tool&utm_medium=referral')
  const url = new URL(f.calls[0].url)
  assert.equal(url.searchParams.get('query'), 'school garden')
  assert.equal(url.searchParams.get('orientation'), 'portrait')
  assert.equal(f.calls[0].auth, 'Client-ID test-key')
  await searchPhotos({ query: 'School garden', orientation: 'vertical' }, f)
  assert.equal(f.calls.length, 1, 'same search is served from cache')
  await assert.rejects(searchPhotos({ query: ' ' }, f), UnsplashError)
})

test('emailUrl crops to the slot shape, or scales to its width, always JPEG', () => {
  const crop = new URL(emailUrl('https://images.unsplash.com/photo-x?ixid=abc', 600, 300))
  assert.equal(crop.searchParams.get('ixid'), 'abc')
  assert.deepEqual(['w', 'h', 'fit', 'fm'].map(k => crop.searchParams.get(k)), ['1200', '600', 'crop', 'jpg'])
  const scale = new URL(emailUrl('https://images.unsplash.com/photo-x', 280, null))
  assert.deepEqual(['w', 'h', 'fit'].map(k => scale.searchParams.get(k)), ['560', null, 'max'])
})

test('usePhoto looks the photo up, pings its download, and returns the email URL', async () => {
  const f = fakeFetch([['/photos/aaaaa1/download', {}], ['/photos/aaaaa1', photo('aaaaa1')]])
  const out = await usePhoto({ id: 'aaaaa1', width: 600, height: null }, f)
  assert.ok(f.calls.some(c => c.url === 'https://api.unsplash.com/photos/aaaaa1/download?ixid=abc'), 'download recorded')
  assert.match(out.url, /^https:\/\/images\.unsplash\.com\/photo-aaaaa1\?ixid=abc&fm=jpg/)
  assert.equal(out.height, 400, 'height follows the photo when the slot has none')
  await assert.rejects(usePhoto({ id: '../../me' }, f), UnsplashError)
  const plus = fakeFetch([['/photos/zzzzz9', photo('zzzzz9', { premium: true })]])
  await assert.rejects(usePhoto({ id: 'zzzzz9' }, plus), /Unsplash\+/)
})

test('a rate limit becomes a friendly 429', async () => {
  const f = fakeFetch([['/search/photos', {}, 403]])
  await assert.rejects(searchPhotos({ query: 'rate limited query' }, f), e => e.status === 429 && /hourly limit/.test(e.message))
})
