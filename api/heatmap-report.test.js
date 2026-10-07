'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildHeatmapReport, matchClicks, normalizeUrl, tagLinks, fillMergeTags } = require('./heatmap-report')

test('URLs match exactly apart from UTM tags, case of host, www and a trailing slash', () => {
  assert.equal(normalizeUrl('https://WWW.Alconox.com/contact-us/?utm_source=x&utm_campaign=y'), normalizeUrl('https://alconox.com/contact-us'))
  assert.notEqual(normalizeUrl('https://alconox.com/'), normalizeUrl('https://alconox.com/products'))
  assert.notEqual(normalizeUrl('https://alconox.com/a?id=1'), normalizeUrl('https://alconox.com/a?id=2'))
  assert.equal(normalizeUrl('{{unsubscribe_url}}'), null)
})

test('clicks attach to the right links; similar URLs never share; edited-away links are reported', () => {
  const hrefs = [
    'https://alconox.com/?utm_source=nl', 'https://alconox.com/products', 'https://alconox.com/products/',
    'mailto:x@alconox.com', '{{unsubscribe_url}}', 'https://instagram.com/alconoxllc/',
  ]
  const stats = [
    { url: 'https://alconox.com/', unique_clicks: 3, total_clicks: 4 },
    { url: 'https://alconox.com/products', unique_clicks: 9, total_clicks: 12 },
    { url: 'https://www.instagram.com/alconoxinc/', unique_clicks: 5, total_clicks: 5 },
    { url: 'https://mail.sagerock.com/unsubscribe?x=1', unique_clicks: 2, total_clicks: 2 },
  ]
  const { rows, unmatched } = matchClicks(hrefs, stats, ['Home', 'Products', 'See products'])
  assert.deepEqual(rows.map(r => [r.url, r.unique, r.rank, r.indices]), [
    ['https://alconox.com/products', 9, 1, [1, 2]],
    ['https://alconox.com/?utm_source=nl', 3, 2, [0]],
    ['https://instagram.com/alconoxllc/', 0, null, [5]],
  ])
  assert.equal(rows[0].text, 'Products')
  assert.deepEqual(unmatched, [{ url: 'https://www.instagram.com/alconoxinc/', unique: 5 }])
})

test('links are tagged for measuring and merge tags read naturally', () => {
  const { tagged, hrefs } = tagLinks('<a href="https://a.test/?x=1&amp;y=2">A</a><a class="b" href=\'mailto:z@a.test\'>B</a><a>C</a>')
  assert.deepEqual(hrefs, ['https://a.test/?x=1&y=2', 'mailto:z@a.test', ''])
  assert.match(tagged, /<a data-hm="0" href=/)
  assert.match(tagged, /<a data-hm="2">C/)
  const filled = fillMergeTags('Hi {{first_name}}, {{mailing_address}} <a href="{{unsubscribe_url}}">x</a>', { mailing_address: '30 Glenn St. <b>' })
  assert.equal(filled, 'Hi there, 30 Glenn St. &lt;b&gt; <a href="#unsubscribe">x</a>')
})

test('renders a PNG and a one-page PDF report', async () => {
  const html = `<!DOCTYPE html><html><body style="margin:0;font-family:Arial">
    <table width="600"><tr><td style="padding:20px">
      <h1>Hello {{first_name}}</h1>
      <p><a href="https://alconox.com/products?utm_source=nl">Shop products</a></p>
      <p><a href="https://alconox.com/contact-us/">Contact us</a></p>
      <p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
    </td></tr></table></body></html>`
  const input = {
    campaign: { name: 'Test Scoop', subject: 'Hi', sent_at: '2026-09-17T14:00:00Z' },
    client: { name: 'Alconox', mailing_address: '30 Glenn St.' },
    html,
    linkStats: [{ url: 'https://alconox.com/products', unique_clicks: 7, total_clicks: 9 }],
    summary: { sent: 100, delivered: 98, clickers: 7 },
  }
  const png = await buildHeatmapReport({ ...input, format: 'png' })
  assert.equal(png.contentType, 'image/png')
  assert.equal(png.filename, 'heatmap-test-scoop.png')
  assert.ok(png.buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
  assert.equal(png.rows[0].rank, 1)
  const pdf = await buildHeatmapReport({ ...input, format: 'pdf' })
  assert.equal(pdf.contentType, 'application/pdf')
  assert.equal(pdf.buffer.subarray(0, 5).toString(), '%PDF-')
  assert.equal((pdf.buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1, 'one page')
})
