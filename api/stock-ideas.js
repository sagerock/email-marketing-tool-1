'use strict'

// Stock photo ideas for the builder. Adobe Stock's API is only open to Stock
// for Enterprise, so the tool can't search or license for the user. Instead
// the model suggests Adobe Stock searches for each image in the email (and a
// few places a new photo could help); the panel opens them on stock.adobe.com,
// the user licenses with their own account, and drops the file into the chat.

const { builderParams, replyText } = require('./email-builder-model')

const MAX_IMAGES = 30
const ORIENTATIONS = ['horizontal', 'vertical', 'square', 'panoramic']

const IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['images', 'extra'],
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'skip', 'searches', 'orientation'],
        properties: {
          index: { type: 'integer' },
          skip: { type: 'boolean' },
          searches: { type: 'array', items: { type: 'string' } },
          orientation: { type: 'string', enum: ORIENTATIONS },
        },
      },
    },
    extra: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['idea', 'searches', 'orientation'],
        properties: {
          idea: { type: 'string' },
          searches: { type: 'array', items: { type: 'string' } },
          orientation: { type: 'string', enum: ORIENTATIONS },
        },
      },
    },
  },
}

const SYSTEM = `You help someone pick Adobe Stock photos for an email they're building.
For each image in the email, suggest up to three Adobe Stock search phrases that would find a
good replacement photo for that spot, based on what the email says around it and who it's for.

Search phrases:
- 2 to 5 plain words, concrete and visual: who or what is in the photo, the setting, the mood
  (e.g. "children planting school garden", "teacher reading aloud classroom").
- Vary them: one close match, one broader, one with a different angle or mood.
- No brand names, no words meant to appear as text in the image, no quotes or operators.
- Fit the organization's brand story when one is given (audience, feel, place).

Set skip true (and searches empty) for images that aren't photos and shouldn't come from stock:
logos, icons, social buttons, signatures, tracking pixels, spacers, charts, product shots.
orientation: the shape that fits the spot (use the width and height when given).

extra: up to three places where adding a photo would help an email that has few or none,
each with a short plain description of where it would go ("Beside the open house details")
and searches. Leave extra empty when the email already has enough photos.`

function str(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeRequest(body) {
  const images = (Array.isArray(body?.images) ? body.images : []).slice(0, MAX_IMAGES).map((img, i) => ({
    index: i,
    alt: str(img?.alt, 200),
    src: str(img?.src, 300),
    width: Number.isFinite(Number(img?.width)) ? Number(img.width) : null,
    height: Number.isFinite(Number(img?.height)) ? Number(img.height) : null,
    context: str(img?.context, 400),
  }))
  return {
    subject: str(body?.subject, 300),
    text: str(body?.text, 4000),
    images,
  }
}

function promptFor({ subject, text, images }, brandStory) {
  const list = images.length
    ? images.map(img => `Image ${img.index}: alt="${img.alt}" file="${img.src.split('/').pop()}"` +
      `${img.width ? ` ${img.width}x${img.height || '?'}` : ''}\n  Nearby text: ${img.context || '(none)'}`).join('\n')
    : '(no images yet)'
  return `${brandStory ? `${brandStory}\n` : ''}<email subject="${subject.replace(/"/g, "'")}">
${text}
</email>
<images>
${list}
</images>`
}

function cleanSearches(list) {
  const seen = new Set()
  const out = []
  for (const s of Array.isArray(list) ? list : []) {
    const q = str(s, 80).replace(/["“”]/g, '')
    if (q && !seen.has(q.toLowerCase())) { seen.add(q.toLowerCase()); out.push(q) }
    if (out.length === 3) break
  }
  return out
}

function validateIdeas(raw, imageCount) {
  const byIndex = new Map()
  for (const item of Array.isArray(raw?.images) ? raw.images : []) {
    if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= imageCount || byIndex.has(item.index)) continue
    const searches = item.skip ? [] : cleanSearches(item.searches)
    byIndex.set(item.index, {
      index: item.index,
      skip: Boolean(item.skip) || !searches.length,
      searches,
      orientation: ORIENTATIONS.includes(item.orientation) ? item.orientation : 'horizontal',
    })
  }
  const images = Array.from({ length: imageCount }, (_, i) => byIndex.get(i) || { index: i, skip: true, searches: [], orientation: 'horizontal' })
  const extra = (Array.isArray(raw?.extra) ? raw.extra : []).slice(0, 3)
    .map(e => ({ idea: str(e?.idea, 160), searches: cleanSearches(e?.searches), orientation: ORIENTATIONS.includes(e?.orientation) ? e.orientation : 'horizontal' }))
    .filter(e => e.idea && e.searches.length)
  return { images, extra }
}

async function stockIdeas({ anthropic, body, brandStory = '' }) {
  const request = normalizeRequest(body)
  const params = builderParams({ maxTokens: 8000, effort: 'low' })
  params.output_config = { ...params.output_config, format: { type: 'json_schema', schema: IDEAS_SCHEMA } }
  const message = await anthropic.beta.messages.create({
    ...params,
    system: SYSTEM,
    messages: [{ role: 'user', content: promptFor(request, brandStory) }],
  })
  return validateIdeas(JSON.parse(replyText(message)), request.images.length)
}

module.exports = { stockIdeas, validateIdeas, normalizeRequest, IDEAS_SCHEMA }
