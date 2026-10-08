'use strict'

// "Describe who should get this": turns a plain-language description of a
// campaign's recipients into the campaign form's existing filters (tags,
// audience, Salesforce campaign, purchase history). It only fills the form;
// the user sees the filters and the live recipient count before saving, and
// nothing here saves or sends. Every value the model returns is checked
// against the client's real tags, campaigns and products.

const { builderParams, replyText } = require('./email-builder-model')

const MAX_TEXT = 1000
const MAX_TAGS_IN_PROMPT = 3000
const AUDIENCES = ['lead', 'customer', 'dealer']

class AudienceError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const AUDIENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tags', 'audience', 'salesforce_campaign_id', 'min_spend', 'min_orders', 'recency_mode',
    'recency_days', 'product_mode', 'product_skus', 'explanation', 'not_possible'],
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
    audience: { type: 'array', items: { type: 'string', enum: AUDIENCES } },
    salesforce_campaign_id: { type: 'string' },
    min_spend: { type: 'number' },
    min_orders: { type: 'integer' },
    recency_mode: { type: 'string', enum: ['any', 'within', 'lapsed'] },
    recency_days: { type: 'integer' },
    product_mode: { type: 'string', enum: ['any', 'purchased', 'not_purchased'] },
    product_skus: { type: 'array', items: { type: 'string' } },
    explanation: { type: 'string' },
    not_possible: { type: 'string' },
  },
}

const SYSTEM = `You turn a marketer's description of who should receive an email campaign into the
campaign form's recipient filters. Use only the filters below, and only values from the lists given.

How the filters combine (this is fixed; you can't change it):
- tags: contacts with ANY of the chosen tags (OR within tags). Empty = no tag filter.
- audience: lead / customer / dealer; ANY of the chosen. Empty = everyone.
- salesforce_campaign_id: members of that one Salesforce campaign. "" = no campaign filter.
- purchase history: min_spend (total $, 0 = none), min_orders (0 = none), recency_mode
  within/lapsed with recency_days (bought within N days / hasn't bought in N days; "any" = none),
  product_mode purchased/not_purchased with product_skus (ANY of them; "any" = none).
- The groups (tags, audience, campaign, purchase history) combine with AND.
- Unsubscribed and hard-bounced contacts are always left out automatically.

Rules:
- Pick tags by meaning, not just exact words (e.g. "tradeshow people" can match "Pittcon 2026 Booth").
  When several tags fit, include all that clearly fit and none that don't. Prefer the most specific
  tag for the request (e.g. "Downloaded: <resource>" for people who downloaded that resource).
- A Salesforce campaign is a good fit when the request names one specific event or campaign.
  Tags named "Campaign: <name>" mirror Salesforce campaign membership, so several campaigns
  (e.g. every year of a show) are reached by choosing all of those tags instead.
- Never quietly widen the audience. If a part of the request matches several tags or campaigns
  (e.g. several years of the same show) and nothing says which, include ALL the matching tags
  (tags are OR) and say so in the explanation. Only if a part can't be matched at all, leave it out
  and say so in not_possible.
- If part of the request can't be expressed with these filters (for example opens or clicks,
  location, job title, or "tag A but not tag B", or an OR across different groups), set the
  filters for the part you can do and say plainly in not_possible what's missing, in one sentence.
  Leave not_possible "" when everything fits.
- explanation: one or two short sentences in plain words describing who will get it, naming
  the tags/campaign/products chosen. No jargon.
- Never invent tags, campaign ids or SKUs.`

function cleanText(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!value) throw new AudienceError('Describe who should get this campaign')
  if (value.length > MAX_TEXT) throw new AudienceError(`Please keep it under ${MAX_TEXT} characters`)
  return value
}

function cleanProducts(products) {
  if (!Array.isArray(products)) return []
  return products
    .filter(p => p && typeof p.sku === 'string' && p.sku.trim())
    .slice(0, 500)
    .map(p => ({ sku: p.sku.trim().slice(0, 100), name: String(p.name || p.sku).slice(0, 150) }))
}

// Tags arrive as { name, count } (count = contacts with the tag, or null when
// unknown). Empty tags are left out of the prompt: nobody would receive mail.
function normalizeTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map(t => (typeof t === 'string' ? { name: t, count: null } : { name: String(t?.name || ''), count: Number.isFinite(t?.count) ? t.count : null }))
    .filter(t => t.name)
}

function optionsPrompt({ tags, campaigns, products }) {
  const lines = []
  const offered = tags.filter(t => t.count !== 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, MAX_TAGS_IN_PROMPT)
    .sort((a, b) => a.name.localeCompare(b.name))
  lines.push(`<tags> (name, then how many contacts have it)\n${offered.length
    ? offered.map(t => (t.count == null ? t.name : `${t.name} (${t.count})`)).join('\n')
    : '(none)'}\n</tags>`)
  lines.push(`<salesforce_campaigns>\n${campaigns.length
    ? campaigns.map(c => `${c.id} | ${c.name}${c.type ? ` (${c.type})` : ''}${c.status ? ` [${c.status}]` : ''}`).join('\n')
    : '(none)'}\n</salesforce_campaigns>`)
  lines.push(`<products>\n${products.length ? products.map(p => `${p.sku} | ${p.name}`).join('\n') : '(none; purchase filters unavailable)'}\n</products>`)
  return lines.join('\n')
}

// Keeps only values that exist for this client, in the campaign form's shape.
function validateAudience(raw, { tags, campaigns, products }) {
  const tagByLower = new Map(normalizeTags(tags).map(t => [t.name.toLowerCase(), t.name]))
  const pickedTags = [...new Set((raw.tags || []).map(t => tagByLower.get(String(t).toLowerCase())).filter(Boolean))]
  let audience = [...new Set((raw.audience || []).filter(a => AUDIENCES.includes(a)))]
  if (audience.length === AUDIENCES.length) audience = []
  const campaign = campaigns.find(c => c.id === raw.salesforce_campaign_id)
  const skus = new Set(products.map(p => p.sku))
  const productSkus = [...new Set((raw.product_skus || []).filter(s => skus.has(s)))]
  const num = (v, max) => (Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0)
  const recencyDays = Math.round(num(raw.recency_days, 3650))
  const recencyMode = ['within', 'lapsed'].includes(raw.recency_mode) && recencyDays ? raw.recency_mode : 'any'
  const productMode = ['purchased', 'not_purchased'].includes(raw.product_mode) && productSkus.length ? raw.product_mode : 'any'
  const minSpend = num(raw.min_spend, 10_000_000)
  const minOrders = Math.round(num(raw.min_orders, 100_000))
  const dropped = [
    ...(raw.tags || []).filter(t => !tagByLower.has(String(t).toLowerCase())),
    ...(raw.salesforce_campaign_id && !campaign ? ['a Salesforce campaign'] : []),
    ...(raw.product_skus || []).filter(s => !skus.has(s)),
  ]
  return {
    filters: {
      filter_tags: pickedTags,
      audience_filter: audience,
      salesforce_campaign_id: campaign ? campaign.id : '',
      purchase_filter: {
        min_spend: minSpend ? String(minSpend) : '',
        min_orders: minOrders ? String(minOrders) : '',
        recency_mode: recencyMode,
        recency_days: recencyMode === 'any' ? '' : String(recencyDays),
        product_mode: productMode,
        product_skus: productMode === 'any' ? [] : productSkus,
      },
    },
    explanation: String(raw.explanation || '').slice(0, 500),
    not_possible: String(raw.not_possible || '').slice(0, 300),
    ignored: dropped.map(String).slice(0, 10),
  }
}

async function interpretAudience({ anthropic, text, tags, campaigns, products }) {
  const description = cleanText(text)
  const options = { tags: normalizeTags(tags), campaigns, products: cleanProducts(products) }
  const params = builderParams({ maxTokens: 8000, effort: 'low' })
  params.output_config = { ...params.output_config, format: { type: 'json_schema', schema: AUDIENCE_SCHEMA } }
  const message = await anthropic.beta.messages.create({
    ...params,
    system: SYSTEM,
    messages: [{ role: 'user', content: `${optionsPrompt(options)}\n\n<description>\n${description}\n</description>` }],
  })
  return validateAudience(JSON.parse(replyText(message)), options)
}

module.exports = { interpretAudience, validateAudience, AudienceError, AUDIENCE_SCHEMA }
