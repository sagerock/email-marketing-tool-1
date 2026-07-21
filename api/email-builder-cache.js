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
  }
}

module.exports = { markConversationTailForCaching }
