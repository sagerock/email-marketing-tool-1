'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { validateAudience, interpretAudience, AudienceError } = require('./audience-from-text')

const options = {
  tags: ['Pittcon 2026 Booth', 'Resource Download', 'Waldorf Parents'],
  campaigns: [{ id: 'sf-1', name: 'Pittcon 2026', type: 'Trade Show' }],
  products: [{ sku: 'ALC-1', name: 'Alconox 4 lb' }, { sku: 'LIQ-1', name: 'Liquinox' }],
}

test('validateAudience keeps only real values and fills the form shape', () => {
  const out = validateAudience({
    tags: ['pittcon 2026 booth', 'Made Up Tag'], audience: ['lead', 'customer', 'dealer'],
    salesforce_campaign_id: 'sf-999', min_spend: 500, min_orders: 0, recency_mode: 'within', recency_days: 0,
    product_mode: 'purchased', product_skus: ['LIQ-1', 'NOPE'], explanation: 'Booth visitors.', not_possible: '',
  }, options)
  assert.deepEqual(out.filters, {
    filter_tags: ['Pittcon 2026 Booth'],
    audience_filter: [],
    salesforce_campaign_id: '',
    purchase_filter: { min_spend: '500', min_orders: '', recency_mode: 'any', recency_days: '',
      product_mode: 'purchased', product_skus: ['LIQ-1'] },
  })
  assert.deepEqual(out.ignored, ['Made Up Tag', 'a Salesforce campaign', 'NOPE'])
})

test('validateAudience keeps a real campaign and a lapsed window', () => {
  const out = validateAudience({
    tags: [], audience: ['customer'], salesforce_campaign_id: 'sf-1', min_spend: -5, min_orders: 2,
    recency_mode: 'lapsed', recency_days: 365, product_mode: 'any', product_skus: [], explanation: 'x', not_possible: 'No opens filter.',
  }, options)
  assert.equal(out.filters.salesforce_campaign_id, 'sf-1')
  assert.deepEqual(out.filters.audience_filter, ['customer'])
  assert.equal(out.filters.purchase_filter.min_spend, '')
  assert.equal(out.filters.purchase_filter.min_orders, '2')
  assert.equal(out.filters.purchase_filter.recency_mode, 'lapsed')
  assert.equal(out.filters.purchase_filter.recency_days, '365')
  assert.equal(out.not_possible, 'No opens filter.')
})

test('interpretAudience sends the options and validates the reply', async () => {
  let sent
  const anthropic = { beta: { messages: { create: async params => {
    sent = params
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      tags: ['Waldorf Parents'], audience: [], salesforce_campaign_id: '', min_spend: 0, min_orders: 0,
      recency_mode: 'any', recency_days: 0, product_mode: 'any', product_skus: [], explanation: 'Parents.', not_possible: '' }) }] }
  } } } }
  const out = await interpretAudience({ anthropic, text: '  waldorf   parents ', ...options, tags: [...options.tags.map(name => ({ name, count: 5 })), { name: 'Empty Tag', count: 0 }] })
  assert.deepEqual(out.filters.filter_tags, ['Waldorf Parents'])
  assert.equal(sent.output_config.format.type, 'json_schema')
  assert.match(sent.messages[0].content, /Pittcon 2026 Booth/)
  assert.doesNotMatch(sent.messages[0].content, /Empty Tag/, 'tags nobody has are not offered')
  assert.match(sent.messages[0].content, /sf-1 \| Pittcon 2026 \(Trade Show\)/)
  assert.match(sent.messages[0].content, /<description>\nwaldorf parents\n<\/description>/)
  await assert.rejects(interpretAudience({ anthropic, text: '   ', ...options }), AudienceError)
})
