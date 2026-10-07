'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { markConversationTailForCaching } = require('./email-builder-cache')

test('marks the conversation tail when no ephemeral references are present', () => {
  const messages = [{ role: 'user', content: 'Build an email' }]

  markConversationTailForCaching(messages, messages.length, false)

  assert.deepEqual(messages[0].content, [{
    type: 'text',
    text: 'Build an email',
    cache_control: { type: 'ephemeral' },
  }])
})

test('does not mark the conversation tail when ephemeral references are present', () => {
  const messages = [{ role: 'user', content: '<reference_email>...</reference_email>\n\nRevise it' }]

  markConversationTailForCaching(messages, messages.length, true)

  assert.equal(messages[0].content, '<reference_email>...</reference_email>\n\nRevise it')
})

test('marks the last block when the tail is already content blocks', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'library' }, { type: 'text', text: 'Build an email' }] }]

  markConversationTailForCaching(messages, messages.length, false)

  assert.deepEqual(messages[0].content[0], { type: 'text', text: 'library' })
  assert.deepEqual(messages[0].content[1], { type: 'text', text: 'Build an email', cache_control: { type: 'ephemeral' } })
})
