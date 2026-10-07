'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { renderSlices, reviewDesign, publicUrl } = require('./visual-check')

test('only public http(s) and data: URLs may load', async () => {
  assert.equal(await publicUrl('data:image/png;base64,AAAA'), true)
  assert.equal(await publicUrl('http://127.0.0.1/x.png'), false)
  assert.equal(await publicUrl('http://localhost/x.png'), false)
  assert.equal(await publicUrl('https://example.com:8443/x.png'), false)
  assert.equal(await publicUrl('file:///etc/passwd'), false)
})

test('renders slices in a locked-down browser that never reaches private addresses', async () => {
  const hits = []
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url} ${req.headers['user-agent'] || ''}`.slice(0, 160)); res.end('x') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const tall = '<p style="height:1400px;margin:0;background:#3A6B35">tall</p>'
    const html = `<!DOCTYPE html><html><body style="margin:0">
      <img src="http://127.0.0.1:${port}/private.png" width="10" height="10">
      <img src="http://localhost:${port}/also-private.png" width="10" height="10">
      <link rel="stylesheet" href="http://127.0.0.1:${port}/x.css">
      <script>fetch('http://127.0.0.1:${port}/script')</script>
      ${tall}<p>end</p></body></html>`
    const render = await renderSlices(html)
    // Only the email's own addresses count: other local tools (e.g. editor
    // port-forwarding) sometimes probe a freshly opened port with GET /.
    const fromEmail = hits.filter(h => /\/(private\.png|also-private\.png|x\.css|script)\b/.test(h))
    assert.equal(fromEmail.length, 0, `private address was requested: ${fromEmail.join(', ')}`)
    assert.equal(render.slices.length, 2)
    assert.ok(render.height > 1400)
    assert.equal(render.truncated, false)
    assert.ok(Buffer.from(render.slices[0], 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'JPEG')
  } finally {
    server.close()
  }
})

test('review sends the screenshots in order and normalizes the verdict', async () => {
  let sent
  const anthropic = { beta: { messages: { stream: args => {
    sent = args
    return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      looks_right: true, summary: 'The header is parchment but the bar did not move.',
      problems: [{ problem: 'The gold bar is still above the logo', where: 'the header' }],
    }) }] }) }
  } } } }
  const verdict = await reviewDesign({ anthropic, render: { slices: ['AAA', 'BBB'], truncated: true }, request: 'Move the gold bar', note: 'Moved the bar.' })
  // A "looks right" with problems listed is not looks right.
  assert.equal(verdict.looks_right, false)
  assert.equal(verdict.problems.length, 1)
  const images = sent.messages[0].content.filter(b => b.type === 'image').map(b => b.source.data)
  assert.deepEqual(images, ['AAA', 'BBB'])
  assert.match(JSON.stringify(sent.messages[0].content), /Move the gold bar[\s\S]*Moved the bar[\s\S]*not captured/)
  assert.equal(sent.output_config.format.type, 'json_schema')
  assert.equal(sent.output_config.effort, 'low')
})
