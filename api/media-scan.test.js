// api/media-scan.test.js
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extractImageUrls, filenameFromUrl } = require('./media-scan')

test('extractImageUrls finds src URLs in <img> tags', () => {
  const html = `
    <p>Hello</p>
    <img src="https://example.com/a.png" alt="a">
    <img alt="b" src='https://example.com/b.jpg'>
    <img src="https://example.com/c.gif?v=1">
  `
  const urls = extractImageUrls(html)
  assert.deepEqual(urls, [
    'https://example.com/a.png',
    'https://example.com/b.jpg',
    'https://example.com/c.gif?v=1',
  ])
})

test('extractImageUrls returns [] for empty or non-HTML input', () => {
  assert.deepEqual(extractImageUrls(''), [])
  assert.deepEqual(extractImageUrls(null), [])
  assert.deepEqual(extractImageUrls('no images here'), [])
})

test('extractImageUrls deduplicates within a single document', () => {
  const html = `
    <img src="https://example.com/a.png">
    <img src="https://example.com/a.png">
  `
  assert.deepEqual(extractImageUrls(html), ['https://example.com/a.png'])
})

test('extractImageUrls skips data: URLs', () => {
  const html = `
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQYV2NgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==">
    <img src="https://example.com/real.png">
  `
  assert.deepEqual(extractImageUrls(html), ['https://example.com/real.png'])
})

test('filenameFromUrl strips query string and returns last path segment', () => {
  assert.equal(filenameFromUrl('https://example.com/a/b/c.png?v=1'), 'c.png')
  assert.equal(filenameFromUrl('https://example.com/'), '')
  assert.equal(filenameFromUrl('not-a-url'), 'not-a-url')
})
