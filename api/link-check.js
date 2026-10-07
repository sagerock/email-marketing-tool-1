'use strict'

// Checks whether links in an email actually load, without letting a link reach
// anything but the public internet. Every hostname is resolved through a
// lookup that rejects private, loopback, link-local and other non-public
// addresses, and the same lookup is used for the connection itself, so a DNS
// answer can't change between the check and the request. Redirects are
// followed by hand (each hop re-checked), only on ports 80/443.

const dns = require('node:dns')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')

const TIMEOUT_MS = 8000
const MAX_HOPS = 4
const MAX_URLS = 40
const CONCURRENCY = 5
const CACHE_MS = 10 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (compatible; SageRockMailLinkCheck/1.0; +https://mail.sagerock.com)'

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||  // carrier-grade NAT
    (a === 169 && b === 254) ||            // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
}

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return !ipv4Private(ip)
  if (!net.isIPv6(ip)) return false
  const v6 = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped) return !ipv4Private(mapped[1])
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith('64:ff9b:'))
}

class BlockedAddressError extends Error {
  constructor(host) {
    super(`${host} points to a private or reserved network address`)
    this.code = 'EBLOCKED'
  }
}

// dns.lookup-compatible, refusing any non-public answer.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }]
    if (!list.length || list.some(a => !isPublicAddress(a.address))) return callback(new BlockedAddressError(hostname))
    if (options.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

const refuse = message => Object.assign(new Error(message), { code: 'EBLOCKED' })

function assertFetchable(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('only http and https links can be checked')
  if (url.port && url.port !== '80' && url.port !== '443') throw refuse('only standard web ports can be checked')
  if (url.username || url.password) throw refuse('links with credentials are not checked')
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new BlockedAddressError(url.hostname)
  }
}

// One request; resolves with the status and Location header, never the body.
function requestOnce(url, method) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method,
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8' },
    }, res => {
      resolve({ status: res.statusCode, location: res.headers.location })
      res.destroy()
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

// Outcome: ok | broken (404/410, no such site, refused) | unverified (blocked by
// the site, rate-limited, server error, timeout) | blocked (private address).
async function checkUrl(rawUrl, request = requestOnce) {
  let url
  try { url = new URL(rawUrl) } catch { return { url: rawUrl, outcome: 'broken', detail: 'not a valid web address' } }
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    try {
      assertFetchable(url)
      let res = await request(url, 'HEAD')
      // Plenty of sites refuse HEAD; ask again the normal way.
      if ([400, 403, 405, 501].includes(res.status)) res = await request(url, 'GET')
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = new URL(res.location, url)
        continue
      }
      if (res.status < 300) return { url: rawUrl, outcome: 'ok', status: res.status, finalUrl: url.toString() }
      if (res.status === 404 || res.status === 410) return { url: rawUrl, outcome: 'broken', status: res.status, detail: `the page returns ${res.status} (not found)` }
      return { url: rawUrl, outcome: 'unverified', status: res.status, detail: `the site answered ${res.status}` }
    } catch (err) {
      if (err.code === 'EBLOCKED') return { url: rawUrl, outcome: 'blocked', detail: err.message }
      if (err.code === 'ENOTFOUND') return { url: rawUrl, outcome: 'broken', detail: `${url.hostname} doesn’t exist` }
      if (err.code === 'ECONNREFUSED') return { url: rawUrl, outcome: 'broken', detail: `${url.hostname} refused the connection` }
      if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /certificate/i.test(err.message)) {
        return { url: rawUrl, outcome: 'unverified', detail: 'the site’s security certificate is invalid' }
      }
      return { url: rawUrl, outcome: 'unverified', detail: err.code === 'ETIMEDOUT' ? 'the site took too long to answer' : err.message }
    }
  }
  return { url: rawUrl, outcome: 'unverified', detail: 'too many redirects' }
}

const cache = new Map()

async function checkLinks(urls, { request = requestOnce, now = Date.now } = {}) {
  const unique = [...new Set((Array.isArray(urls) ? urls : []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2000))]
    .slice(0, MAX_URLS)
  const results = {}
  const todo = []
  for (const u of unique) {
    const hit = cache.get(u)
    if (hit && now() - hit.at < CACHE_MS) results[u] = hit.result
    else todo.push(u)
  }
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length) {
      const u = todo[next++]
      const result = await checkUrl(u, request)
      results[u] = result
      if (cache.size > 2000) cache.delete(cache.keys().next().value)
      cache.set(u, { at: now(), result })
    }
  }))
  return results
}

module.exports = { checkLinks, checkUrl, isPublicAddress, safeLookup, assertFetchable, MAX_URLS }
