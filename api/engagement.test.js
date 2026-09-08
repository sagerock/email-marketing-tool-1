const test = require('node:test')
const assert = require('node:assert/strict')

const mountEngagement = require('./engagement')

test('overview returns a partial verification manifest instead of hiding the dashboard', async () => {
  let overviewHandler
  const app = {
    get(path, handler) {
      if (path === '/api/engagement/overview') overviewHandler = handler
    },
  }
  const freshness = {
    status: 'partial',
    expected_count: 4713,
    resolved_count: 4701,
    unresolved_count: 12,
    cohort_discovery_complete: true,
  }
  const reporting = {
    ensureFresh: async () => freshness,
    latestComplete: async () => {
      throw new Error('partial coverage must not be replaced with an older snapshot')
    },
  }
  const supabase = {
    rpc: async () => ({ data: { totals: { arrivals: 100 } }, error: null }),
  }
  mountEngagement(app, { supabase, reporting })

  const previous = process.env.ENGAGEMENT_REPORTING_ENABLED
  process.env.ENGAGEMENT_REPORTING_ENABLED = 'true'
  let response
  try {
    await overviewHandler(
      { query: { clientId: 'client-1', days: '30', waitDays: '3' } },
      {
        status(code) { response = { code }; return this },
        json(body) { response = { ...(response || { code: 200 }), body }; return this },
      },
    )
  } finally {
    if (previous === undefined) delete process.env.ENGAGEMENT_REPORTING_ENABLED
    else process.env.ENGAGEMENT_REPORTING_ENABLED = previous
  }

  assert.equal(response.code, 200)
  assert.equal(response.body.freshness, freshness)
  assert.equal(response.body.freshness.unresolved_count, 12)
})
