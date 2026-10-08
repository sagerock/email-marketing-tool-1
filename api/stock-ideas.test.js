'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { stockIdeas, validateIdeas, normalizeRequest } = require('./stock-ideas')

test('normalizeRequest trims and caps what the browser sends', () => {
  const r = normalizeRequest({ subject: ' Open   House ', text: 'x'.repeat(5000),
    images: Array.from({ length: 40 }, (_, i) => ({ alt: `a${i}`, src: `https://x/y/${i}.jpg`, width: '600', height: 'auto' })) })
  assert.equal(r.subject, 'Open House')
  assert.equal(r.text.length, 4000)
  assert.equal(r.images.length, 30)
  assert.deepEqual(r.images[2], { index: 2, alt: 'a2', src: 'https://x/y/2.jpg', width: 600, height: null, context: '' })
})

test('validateIdeas fills every image, drops bad indexes, cleans searches', () => {
  const out = validateIdeas({
    images: [
      { index: 0, skip: true, searches: ['logo'], orientation: 'square' },
      { index: 1, skip: false, searches: ['"kids  gardening"', 'Kids gardening', 'school garden', 'fourth', 'fifth'], orientation: 'sideways' },
      { index: 1, skip: false, searches: ['dupe'], orientation: 'vertical' },
      { index: 9, skip: false, searches: ['out of range'], orientation: 'vertical' },
    ],
    extra: [{ idea: 'Beside the dates', searches: ['autumn festival'], orientation: 'vertical' }, { idea: '', searches: ['x'], orientation: 'square' }],
  }, 3)
  assert.deepEqual(out.images, [
    { index: 0, skip: true, searches: [], orientation: 'square' },
    { index: 1, skip: false, searches: ['kids gardening', 'school garden', 'fourth'], orientation: 'horizontal' },
    { index: 2, skip: true, searches: [], orientation: 'horizontal' },
  ])
  assert.deepEqual(out.extra, [{ idea: 'Beside the dates', searches: ['autumn festival'], orientation: 'vertical' }])
})

test('stockIdeas sends the email, images and brand story', async () => {
  let sent
  const anthropic = { beta: { messages: { create: async p => {
    sent = p
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ images: [{ index: 0, skip: false, searches: ['teacher reading aloud'], orientation: 'horizontal' }], extra: [] }) }] }
  } } } }
  const out = await stockIdeas({ anthropic, brandStory: 'BRAND STORY for Alderbrook', body: {
    subject: 'Fall news', text: 'Our teachers read aloud every morning.', images: [{ alt: 'Reading', src: 'https://cdn/x/read.jpg', width: 600, height: 300, context: 'Read aloud' }] } })
  assert.equal(out.images[0].searches[0], 'teacher reading aloud')
  assert.equal(sent.output_config.format.type, 'json_schema')
  assert.match(sent.messages[0].content, /BRAND STORY for Alderbrook/)
  assert.match(sent.messages[0].content, /Image 0: alt="Reading" file="read\.jpg" 600x300\n  Nearby text: Read aloud/)
})
