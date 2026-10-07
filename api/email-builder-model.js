'use strict'

// Model settings for the interactive email builder and the Brand Story
// interview. EMAIL_BUILDER_MODEL / EMAIL_BUILDER_EFFORT on Railway override
// them, so a model change can be rolled back without a deploy.
//
// Claude Sonnet 5.5 notes: thinking is on by default and counts toward
// max_tokens (hence the larger cap); effort is set explicitly because its
// levels were recalibrated; a safety decline arrives as stop_reason "refusal"
// rather than an error, and server-side fallback reroutes the categories it can.

const BUILDER_MODEL = process.env.EMAIL_BUILDER_MODEL || 'claude-sonnet-5-5'
const BUILDER_EFFORT = process.env.EMAIL_BUILDER_EFFORT || 'medium'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

const supportsFallbacks = model => model === 'claude-sonnet-5-5'

// Request params shared by builder calls. Use with client.beta.messages.* so
// the fallback beta header can be sent.
function builderParams({ maxTokens = 64000, effort = BUILDER_EFFORT } = {}) {
  const params = {
    model: BUILDER_MODEL,
    max_tokens: maxTokens,
    output_config: { effort },
  }
  if (supportsFallbacks(BUILDER_MODEL)) {
    params.betas = [FALLBACK_BETA]
    params.fallbacks = 'default'
  }
  return params
}

function textOf(message) {
  return (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
}

class BuilderRefusal extends Error {
  constructor(details) {
    super('The AI declined this request')
    this.category = details?.category || null
  }
}

// Text of a finished message; throws BuilderRefusal on a safety decline.
function replyText(message) {
  if (message.stop_reason === 'refusal') throw new BuilderRefusal(message.stop_details)
  return textOf(message)
}

module.exports = { BUILDER_MODEL, BUILDER_EFFORT, builderParams, replyText, BuilderRefusal }
