'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseEditBlock, applyEdits, resolveDesign, conversationalText, currentEmailBlock,
  normalizeCurrentEmail, OUTPUT_FORMAT_PROMPT,
} = require('./email-builder-edits')

const HTML = `<!DOCTYPE html>
<html>
<body>
  <table>
    <tr>
      <td style="color:#333333">Welcome, families!</td>
    </tr>
    <tr>
      <td><a href="https://alderbrook.example/tour" style="background:#3A6B35;color:#ffffff">Schedule a Tour</a></td>
    </tr>
    <tr>
      <td><a href="{{unsubscribe_url}}">Unsubscribe</a> {{mailing_address}}</td>
    </tr>
  </table>
</body>
</html>`

const EMAIL = { html_content: HTML, subject: 'Hello', preview_text: 'Come visit' }

test('parses an edits block with subject, preview, replacements, and a deletion', () => {
  const reply = `Made the button gold and tightened the greeting.
\`\`\`edits
SUBJECT: Come walk the grounds
<<<<<<< FIND
style="background:#3A6B35;color:#ffffff"
=======
style="background:#D4A853;color:#ffffff"
>>>>>>> REPLACE
<<<<<<< FIND
Welcome, families!
=======
>>>>>>> REPLACE
\`\`\``
  const parsed = parseEditBlock(reply)
  assert.equal(parsed.subject, 'Come walk the grounds')
  assert.equal(parsed.preview_text, undefined)
  assert.deepEqual(parsed.edits, [
    { find: 'style="background:#3A6B35;color:#ffffff"', replace: 'style="background:#D4A853;color:#ffffff"' },
    { find: 'Welcome, families!', replace: '' },
  ])
  assert.equal(conversationalText(reply), 'Made the button gold and tightened the greeting.')
})

test('applies edits in order and leaves everything else byte-identical', () => {
  const r = applyEdits(HTML, [
    { find: 'Schedule a Tour', replace: 'Visit Alderbrook' },
    { find: '#3A6B35', replace: '#D4A853' },
  ])
  assert.equal(r.ok, true)
  assert.equal(r.html, HTML.replace('Schedule a Tour', 'Visit Alderbrook').replace('#3A6B35', '#D4A853'))
})

test('replacement text containing $ patterns is inserted literally', () => {
  const r = applyEdits(HTML, [{ find: 'Schedule a Tour', replace: 'Save $& now $1' }])
  assert.ok(r.html.includes('Save $& now $1'))
})

test('tolerates whitespace differences but not ambiguity or missing text', () => {
  const loose = applyEdits(HTML, [{ find: '<tr>\n  <td style="color:#333333">Welcome, families!</td>', replace: '<tr><td>Hi!</td>' }])
  assert.equal(loose.ok, true)
  assert.ok(loose.html.includes('<tr><td>Hi!</td>'))
  assert.ok(!loose.html.includes('Welcome, families!'))

  const crlf = HTML.replace(/\n/g, '\r\n')
  assert.equal(applyEdits(crlf, [{ find: '<tr>\n      <td style="color:#333333">', replace: '<tr><td>' }]).ok, true)

  const ambiguous = applyEdits(HTML, [{ find: '<tr>', replace: '<tr class="x">' }])
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.reason, /Edit 1's FIND text appears more than once/)

  const missing = applyEdits(HTML, [{ find: 'Apply Now', replace: 'x' }])
  assert.match(missing.reason, /was not found/)
})

test('resolveDesign: edits, full JSON, failure, and plain conversation', () => {
  const edited = resolveDesign('Done.\n```edits\nPREVIEW: See you soon\n<<<<<<< FIND\nSchedule a Tour\n=======\nBook a Visit\n>>>>>>> REPLACE\n```', EMAIL)
  assert.equal(edited.kind, 'edits')
  assert.equal(edited.count, 1)
  assert.equal(edited.design.subject, 'Hello')
  assert.equal(edited.design.preview_text, 'See you soon')
  assert.ok(edited.design.html_content.includes('Book a Visit'))

  const fullText = 'New one.\n```json\n' + JSON.stringify({ subject: 'S', preview_text: 'P', html_content: '<!DOCTYPE html><html></html>' }) + '\n```'
  const full = resolveDesign(fullText, EMAIL)
  assert.equal(full.kind, 'full')
  assert.equal(full.design.subject, 'S')

  const failed = resolveDesign('```edits\n<<<<<<< FIND\nnot there\n=======\nx\n>>>>>>> REPLACE\n```', EMAIL)
  assert.equal(failed.kind, 'failed')

  assert.equal(resolveDesign('What colors do you like?', EMAIL).kind, 'none')
  // Without a current email, an edits block can't apply and is ignored.
  assert.equal(resolveDesign('```edits\n<<<<<<< FIND\na\n=======\nb\n>>>>>>> REPLACE\n```', null).kind, 'none')
})

test('an unterminated edits block (reply cut off) still parses what arrived', () => {
  const parsed = parseEditBlock('```edits\n<<<<<<< FIND\nSchedule a Tour\n=======\nBook a Visit\n>>>>>>> REPLACE\n')
  assert.equal(parsed.edits.length, 1)
})

test('current email block and input normalization', () => {
  assert.equal(normalizeCurrentEmail(null), null)
  assert.equal(normalizeCurrentEmail({ html_content: '  ' }), null)
  assert.equal(normalizeCurrentEmail({ html_content: 'x'.repeat(500001) }), null)
  const block = currentEmailBlock({ html_content: '<html></html>', subject: 'Say "hi"', preview_text: '' })
  assert.equal(block, '<current_email subject="Say &quot;hi&quot;" preview_text="">\n<html></html>\n</current_email>')
  assert.match(OUTPUT_FORMAT_PROMPT, /<<<<<<< FIND/)
})
