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

test('edits in a ```html fence or with no fence still apply (2026-10-07 Alderbrook reply)', () => {
  const header = '<!DOCTYPE html><html><body><table><tr>\n          <td align="center" style="background-color:#3A6B35;padding:28px 40px 24px 40px">\n            <img src="logo.png" alt="Alderbrook">\n          </td>\n</tr></table></body></html>'
  const email = { html_content: header, subject: 'A quiet place', preview_text: '' }
  const pair = '<<<<<<< FIND\n          <td align="center" style="background-color:#3A6B35;padding:28px 40px 24px 40px">\n=======\n          <td align="center" style="background-color:#F7F3ED;padding:28px 40px 24px 40px">\n>>>>>>> REPLACE'
  const note = 'Changed the header background from forest green to parchment.'
  for (const reply of [`${note}\n\n${pair}`, `${note}\n\n\`\`\`html\n${pair}\n\`\`\``]) {
    const r = resolveDesign(reply, email)
    assert.equal(r.kind, 'edits', reply.slice(0, 80))
    assert.ok(r.design.html_content.includes('background-color:#F7F3ED'))
    assert.ok(!r.design.html_content.includes('#3A6B35'))
    assert.equal(conversationalText(reply), note)
  }
  // Without a fence, a SUBJECT: line in the note is never treated as a change.
  const r = resolveDesign(`SUBJECT: just chatting\n${pair}`, email)
  assert.equal(r.design.subject, 'A quiet place')
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

test('a selected part: edits must land inside it, and the span tracks the change', () => {
  const { normalizeSelection } = require('./email-builder-edits')
  const html = '<table><tr><td>Hello</td></tr><tr><td><a style="background:#3A6B35">Visit</a></td></tr><tr><td>Hello</td></tr></table>'
  const email = { html_content: html, subject: 'S', preview_text: '' }
  const start = html.indexOf('<tr><td><a')
  const end = html.indexOf('</tr>', start) + 5
  const selection = normalizeSelection({ start, end, label: 'Button: "Visit"' }, email)
  assert.deepEqual(selection, { start, end, label: 'Button: "Visit"' })

  // "Hello" appears twice in the email, but the FIND only has to be unique inside the selection.
  const inside = resolveDesign('```edits\n<<<<<<< FIND\n#3A6B35\n=======\n#D4A853\n>>>>>>> REPLACE\n<<<<<<< FIND\nVisit\n=======\nCome visit us\n>>>>>>> REPLACE\n```', email, selection)
  assert.equal(inside.kind, 'edits')
  assert.equal(inside.design.html_content, html.replace('#3A6B35', '#D4A853').replace('Visit', 'Come visit us'))
  assert.deepEqual(inside.selection, { start, end: end + 'Come visit us'.length - 'Visit'.length })
  assert.equal(inside.design.html_content.slice(inside.selection.start, inside.selection.end),
    '<tr><td><a style="background:#D4A853">Come visit us</a></td></tr>')

  const outside = resolveDesign('```edits\n<<<<<<< FIND\nHello\n=======\nHi\n>>>>>>> REPLACE\n```', email, selection)
  assert.equal(outside.kind, 'failed')
  assert.match(outside.reason, /was not found in the selected part/)
})

test('a full rewrite with a selection is accepted only if the rest is untouched', () => {
  const html = '<p>Top</p><div>Middle</div><p>Bottom</p>'
  const email = { html_content: html, subject: 'S', preview_text: '' }
  const selection = { start: html.indexOf('<div>'), end: html.indexOf('</div>') + 6, label: 'Block' }
  const json = h => '```json\n' + JSON.stringify({ subject: 'S', preview_text: '', html_content: h }) + '\n```'
  const ok = resolveDesign(json('<p>Top</p><div>New middle</div><p>Bottom</p>'), email, selection)
  assert.equal(ok.kind, 'full')
  assert.deepEqual(ok.selection, { start: selection.start, end: selection.start + '<div>New middle</div>'.length })
  assert.equal(resolveDesign(json('<p>TOP</p><div>New</div><p>Bottom</p>'), email, selection).kind, 'failed')
})

test('selection input is validated and the prompt block includes the part', () => {
  const { normalizeSelection } = require('./email-builder-edits')
  const email = { html_content: '<p>abc</p>', subject: '', preview_text: '' }
  assert.equal(normalizeSelection({ start: 0, end: 99 }, email), null)
  assert.equal(normalizeSelection({ start: 3, end: 3 }, email), null)
  assert.equal(normalizeSelection({ start: '0', end: 5 }, email), null)
  assert.equal(normalizeSelection({ start: 0, end: 5 }, null), null)
  const block = currentEmailBlock(email, { start: 0, end: 10, label: 'Text: "abc"' })
  assert.match(block, /<\/current_email>\n<selected_part label="Text: &quot;abc&quot;">\n<p>abc<\/p>\n<\/selected_part>$/)
})
