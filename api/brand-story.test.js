'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  BrandStoryError,
  normalizeBrandLook,
  normalizeBrandStoryInput,
  brandStoryPrompt,
  parseInterviewReply,
  validateInterviewMessages,
  runBrandInterview,
} = require('./brand-story')

test('normalizeBrandLook cleans colors, urls, and drops empties', () => {
  const look = normalizeBrandLook({
    logo_url: 'https://cdn.example.com/logo.png',
    website: 'alderbrook.example',
    fonts: '  Georgia,   serif ',
    colors: [{ name: 'Forest', hex: '2d5016' }, { hex: '#fa0' }, { name: 'blank', hex: '' }],
  })
  assert.deepEqual(look, {
    logo_url: 'https://cdn.example.com/logo.png',
    website: 'https://alderbrook.example/',
    fonts: 'Georgia, serif',
    colors: [{ name: 'Forest', hex: '#2D5016' }, { hex: '#FFAA00' }],
  })
  assert.deepEqual(normalizeBrandLook(null), {})
})

test('normalizeBrandLook rejects bad input', () => {
  assert.throws(() => normalizeBrandLook({ colors: [{ hex: 'green' }] }), BrandStoryError)
  assert.throws(() => normalizeBrandLook({ logo_url: 'http://x.example/logo.png' }), /https/)
  assert.throws(() => normalizeBrandLook({ logo_url: 'javascript:alert(1)' }), BrandStoryError)
  assert.throws(() => normalizeBrandLook({ colors: Array(9).fill({ hex: '#000000' }) }), /Up to 8/)
  assert.throws(() => normalizeBrandLook([]), BrandStoryError)
})

test('normalizeBrandStoryInput trims and caps the story', () => {
  assert.deepEqual(normalizeBrandStoryInput({ brand_story: '  \n ' }), { brand_story: null, brand_look: {} })
  assert.equal(normalizeBrandStoryInput({ brand_story: ' We grow. ' }).brand_story, 'We grow.')
  assert.throws(() => normalizeBrandStoryInput({ brand_story: 'x'.repeat(20001) }), /limited/)
})

test('brandStoryPrompt is empty without content and includes story and look with it', () => {
  assert.equal(brandStoryPrompt({ name: 'X', brand_story: '', brand_look: {} }), '')
  assert.equal(brandStoryPrompt(null), '')
  const prompt = brandStoryPrompt({
    name: 'Alderbrook',
    brand_story: 'A school in the woods.',
    brand_look: { colors: [{ name: 'Forest', hex: '#2D5016' }], logo_url: 'https://cdn.example.com/l.png' },
  })
  assert.match(prompt, /BRAND STORY for Alderbrook/)
  assert.match(prompt, /<brand_story>\nA school in the woods\.\n<\/brand_story>/)
  assert.match(prompt, /Colors: Forest #2D5016/)
  assert.match(prompt, /Logo \(hosted, use this exact URL\): https:\/\/cdn\.example\.com\/l\.png/)
  // Look-only clients still get guidance, without an empty story tag.
  const lookOnly = brandStoryPrompt({ brand_look: { fonts: 'Georgia' } })
  assert.doesNotMatch(lookOnly, /<brand_story>/)
  assert.match(lookOnly, /Fonts: Georgia/)
})

test('parseInterviewReply separates conversation from draft and validates look', () => {
  const plain = parseInterviewReply('Who are you writing to?')
  assert.deepEqual(plain, { reply: 'Who are you writing to?', draft: null })

  const withDraft = parseInterviewReply(`Here's a first draft!
<brand_story_draft>
Alderbrook sits at the edge of a prairie.
</brand_story_draft>
<brand_look_draft>{"colors":[{"name":"Forest","hex":"#2d5016"}],"logo_url":"https://evil.example/x.png"}</brand_look_draft>`)
  assert.equal(withDraft.reply, "Here's a first draft!")
  assert.equal(withDraft.draft.brand_story, 'Alderbrook sits at the edge of a prairie.')
  // The model is never trusted to supply a logo URL.
  assert.deepEqual(withDraft.draft.brand_look, { colors: [{ name: 'Forest', hex: '#2D5016' }] })

  const badLook = parseInterviewReply('<brand_story_draft>S</brand_story_draft><brand_look_draft>{nope</brand_look_draft>')
  assert.deepEqual(badLook.draft, { brand_story: 'S', brand_look: null })
})

test('validateInterviewMessages enforces roles and user-last', () => {
  assert.throws(() => validateInterviewMessages([]), BrandStoryError)
  assert.throws(() => validateInterviewMessages([{ role: 'system', content: 'x' }]), /role/)
  assert.throws(() => validateInterviewMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]), /last message/)
  const out = validateInterviewMessages([
    { role: 'assistant', content: 'Welcome!' },
    { role: 'user', content: 'We are a school.' },
  ])
  assert.deepEqual(out, [{ role: 'user', content: 'We are a school.' }])
})

test('runBrandInterview sends the existing story and returns parsed output', async () => {
  let sent
  const anthropic = {
    beta: {
      messages: {
        create: async (req) => {
          sent = req
          return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Tell me more about your families.' }] }
        },
      },
    },
  }
  const result = await runBrandInterview({
    anthropic,
    client: { name: 'Alderbrook', brand_story: 'Outdoorsy school.', brand_look: {} },
    messages: [{ role: 'user', content: 'Start the interview' }],
  })
  assert.deepEqual(result, { reply: 'Tell me more about your families.', draft: null })
  assert.match(sent.system, /The organization is: Alderbrook/)
  assert.match(sent.system, /Outdoorsy school\./)
  assert.equal(sent.messages.length, 1)
  assert.equal(sent.model, 'claude-sonnet-5-5')
  assert.deepEqual(sent.output_config, { effort: 'low' })
})
