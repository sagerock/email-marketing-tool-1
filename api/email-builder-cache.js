'use strict'

function markConversationTailForCaching(messages, messageCount, hasEphemeralReferences) {
  if (messageCount > 8 || hasEphemeralReferences) return

  const last = messages[messages.length - 1]
  if (last && typeof last.content === 'string') {
    last.content = [{
      type: 'text',
      text: last.content,
      cache_control: { type: 'ephemeral' },
    }]
  } else if (last && Array.isArray(last.content) && last.content.length) {
    // First turn with the media library attached: content is already blocks.
    const blocks = last.content
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } }
  }
}

module.exports = { markConversationTailForCaching }
