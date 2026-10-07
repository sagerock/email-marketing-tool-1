'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkLinks, checkUrl, isPublicAddress, safeLookup, assertFetchable } = require('./link-check')

test('only public addresses pass', () => {
  for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5']) assert.equal(isPublicAddress(ip), true, ip)
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
})

test('names that resolve to private addresses are refused at lookup', async () => {
  const err = await new Promise(resolve => safeLookup('localhost', {}, e => resolve(e)))
  assert.equal(err?.code, 'EBLOCKED')
})

test('IP literals, odd ports, credentials and other schemes are refused before any request', () => {
  assert.throws(() => assertFetchable(new URL('http://169.254.169.254/latest/meta-data')), /private or reserved/)
  assert.throws(() => assertFetchable(new URL('http://[::1]/')), /private or reserved/)
  assert.throws(() => assertFetchable(new URL('https://example.com:8443/')), /standard web ports/)
  assert.throws(() => assertFetchable(new URL('https://user:pw@example.com/')), /credentials/)
  assert.throws(() => assertFetchable(new URL('ftp://example.com/')), /http and https/)
  assert.doesNotThrow(() => assertFetchable(new URL('https://example.com/page')))
})

function fakeRequest(routes) {
  const calls = []
  const request = async (url, method) => {
    calls.push(`${method} ${url}`)
    const r = routes[`${method} ${url}`] ?? routes[url.toString()]
    if (r instanceof Error) throw r
    return r || { status: 404 }
  }
  return { request, calls }
}

test('outcomes: ok, not found, redirects, HEAD refused, bot-blocked, missing site', async () => {
  const err = code => Object.assign(new Error(code), { code })
  const { request, calls } = fakeRequest({
    'https://a.test/': { status: 200 },
    'https://a.test/gone': { status: 404 },
    'https://a.test/old': { status: 301, location: '/new' },
    'https://a.test/new': { status: 200 },
    'HEAD https://b.test/': { status: 405 },
    'GET https://b.test/': { status: 200 },
    'https://c.test/': { status: 403 },
    'https://nope.test/': err('ENOTFOUND'),
    'https://redir.test/': { status: 302, location: 'http://127.0.0.1/admin' },
  })
  assert.equal((await checkUrl('https://a.test/', request)).outcome, 'ok')
  assert.deepEqual(await checkUrl('https://a.test/gone', request), { url: 'https://a.test/gone', outcome: 'broken', status: 404, detail: 'the page returns 404 (not found)' })
  const moved = await checkUrl('https://a.test/old', request)
  assert.equal(moved.outcome, 'ok')
  assert.equal(moved.finalUrl, 'https://a.test/new')
  assert.equal((await checkUrl('https://b.test/', request)).outcome, 'ok')
  assert.ok(calls.includes('GET https://b.test/'))
  assert.equal((await checkUrl('https://c.test/', request)).outcome, 'unverified')
  assert.equal((await checkUrl('https://nope.test/', request)).outcome, 'broken')
  // A redirect into a private address is stopped before it's requested.
  const sneaky = await checkUrl('https://redir.test/', request)
  assert.equal(sneaky.outcome, 'blocked')
  assert.ok(!calls.some(c => c.includes('127.0.0.1')))
})

test('checkLinks dedupes, caps, skips non-web links, and caches', async () => {
  const { request, calls } = fakeRequest({ 'https://a.test/x': { status: 200 } })
  let t = 0
  const now = () => t
  const urls = ['https://a.test/x', 'https://a.test/x', 'mailto:hi@a.test', '{{unsubscribe_url}}', 42]
  const first = await checkLinks(urls, { request, now })
  assert.deepEqual(Object.keys(first), ['https://a.test/x'])
  await checkLinks(['https://a.test/x'], { request, now })
  assert.equal(calls.length, 1, 'second check served from cache')
  t = 11 * 60 * 1000
  await checkLinks(['https://a.test/x'], { request, now })
  assert.equal(calls.length, 2, 'cache expires')
  const many = await checkLinks(Array.from({ length: 60 }, (_, i) => `https://many.test/${i}`), { request, now })
  assert.equal(Object.keys(many).length, 40)
})
