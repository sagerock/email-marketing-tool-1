'use strict'

// After the builder changes an email, render it the way a reader would see it
// and ask the model to look: did the requested change land, and is anything
// visibly broken? This catches the AI describing a change it didn't make, and
// layout problems that are invisible in the HTML.
//
// Rendering is locked down: no JavaScript, and only images, stylesheets and
// fonts may load, each from a public address (same guard as link checking).

const dns = require('node:dns').promises
const { isPublicAddress } = require('./link-check')
const { builderParams, replyText } = require('./email-builder-model')

const VIEW_WIDTH = 640
const SLICE_HEIGHT = 1000
const MAX_SLICES = 5
const RENDER_TIMEOUT_MS = 20000
const ALLOWED_TYPES = new Set(['image', 'stylesheet', 'font'])

async function publicUrl(raw) {
  let url
  try { url = new URL(raw) } catch { return false }
  if (url.protocol === 'data:') return true
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.port && url.port !== '80' && url.port !== '443') return false
  try {
    const answers = await dns.lookup(url.hostname, { all: true })
    return answers.length > 0 && answers.every(a => isPublicAddress(a.address))
  } catch {
    return false
  }
}

// Returns JPEG slices (base64) of the rendered email, top to bottom.
async function renderSlices(html, { puppeteer = require('puppeteer') } = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  try {
    const page = await browser.newPage()
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', async req => {
      try {
        const type = req.resourceType()
        const url = req.url()
        if (type === 'document' && (url === 'about:blank' || url.startsWith('data:'))) return req.continue()
        if (ALLOWED_TYPES.has(type) && await publicUrl(url)) return req.continue()
        return req.abort()
      } catch {
        // Already handled (e.g. the page closed); nothing to do.
      }
    })
    await page.setViewport({ width: VIEW_WIDTH, height: SLICE_HEIGHT })
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS })
      .catch(() => {}) // render whatever arrived in time
    const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight))
    const slices = []
    for (let y = 0; y < height && slices.length < MAX_SLICES; y += SLICE_HEIGHT) {
      const shot = await page.screenshot({
        type: 'jpeg',
        quality: 75,
        encoding: 'base64',
        captureBeyondViewport: true,
        clip: { x: 0, y, width: VIEW_WIDTH, height: Math.min(SLICE_HEIGHT, height - y) },
      })
      slices.push(shot)
    }
    return { slices, height, truncated: height > SLICE_HEIGHT * MAX_SLICES }
  } finally {
    await browser.close()
  }
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    looks_right: { type: 'boolean' },
    summary: { type: 'string' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { problem: { type: 'string' }, where: { type: 'string' } },
        required: ['problem', 'where'],
        additionalProperties: false,
      },
    },
  },
  required: ['looks_right', 'summary', 'problems'],
  additionalProperties: false,
}

const REVIEW_SYSTEM = `You check email designs the way a careful reader would see them.
You get screenshots of an email rendered at desktop width (top to bottom, in order), the user's
request, and what the email editor said it changed. Report:
1. Whether the requested change is visibly done. If the editor claimed something that isn't
   visible, that's a problem.
2. Clear visual defects only: broken or missing images, text cut off or overlapping, text that's
   hard to read against its background, a layout that's visibly broken or misaligned, leftover
   placeholder or filler text, buttons that look wrong.
Merge tags in double braces ({{first_name}}, {{last_name}}, {{email}}, {{mailing_address}},
{{unsubscribe_url}}, {{industry_link}}, {{campaign_name}}) are filled in per recipient at send time,
so seeing them raw is expected: never report them. Other {{...}} placeholders are leftovers.
Do not comment on taste, copy style, or things that are fine. Keep "summary" to one short sentence.
"where" names the spot in plain words ("the header", "the second button"). At most four problems.
If everything looks right, looks_right is true and problems is empty.`

async function reviewDesign({ anthropic, render, request, note }) {
  const content = [
    { type: 'text', text: `The user asked: ${String(request || '').slice(0, 2000)}` },
    { type: 'text', text: `The editor said: ${String(note || '(nothing)').slice(0, 2000)}` },
  ]
  render.slices.forEach((data, i) => {
    content.push({ type: 'text', text: `Screenshot ${i + 1} of ${render.slices.length}:` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })
  })
  if (render.truncated) content.push({ type: 'text', text: '(The email continues below the last screenshot; that part was not captured.)' })

  const params = builderParams({ maxTokens: 8000, effort: 'low' })
  params.output_config = { ...params.output_config, format: { type: 'json_schema', schema: VERDICT_SCHEMA } }
  const stream = anthropic.beta.messages.stream({ ...params, system: REVIEW_SYSTEM, messages: [{ role: 'user', content }] })
  const verdict = JSON.parse(replyText(await stream.finalMessage()))
  return {
    looks_right: Boolean(verdict.looks_right) && !(verdict.problems || []).length,
    summary: String(verdict.summary || '').slice(0, 300),
    problems: (verdict.problems || []).slice(0, 4).map(p => ({
      problem: String(p.problem || '').slice(0, 300),
      where: String(p.where || '').slice(0, 120),
    })),
  }
}

module.exports = { renderSlices, reviewDesign, publicUrl, VERDICT_SCHEMA }
