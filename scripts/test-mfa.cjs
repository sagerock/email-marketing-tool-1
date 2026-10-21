// Browser regression for two-factor authentication (2026-10-21). Build with dummy Supabase values:
//   VITE_SUPABASE_URL=https://mfa-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-mfa-ui-build
//   node scripts/test-mfa.cjs
// Mocks Supabase Auth (password grant, /user, factors enroll/challenge/verify/unenroll) and REST.
// Scenarios: super admin without a factor is forced to enroll; an enrolled user is asked for a
// code each session, then can see and turn off the factor in Settings; a client admin passes through.
const assert = require('node:assert/strict')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')

const BUILD = process.env.MFA_TEST_BUILD || '/tmp/sagerock-mfa-ui-build'
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))

const userId = '00000000-0000-4000-8000-000000000002'
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url'), 'test'].join('.')
const sessionFor = (aal, user) => ({ access_token: jwt({ aal, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }].concat(aal === 'aal2' ? [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] : []) }), refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user })
const verifiedFactor = { id: 'factor-verified', factor_type: 'totp', friendly_name: 'Authenticator app (test)', status: 'verified', created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' }

function scenario({ role, factors, aal }) {
  const state = { role, factors: [...factors], aal, calls: [] }
  state.user = () => ({ id: userId, email: 'rocky@sagerock.com', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(), factors: state.factors })
  state.handle = (req, reply) => {
    const u = new URL(req.url())
    const m = req.method()
    state.calls.push(`${m} ${u.pathname}`)
    if (m === 'OPTIONS') return reply({})
    if (u.pathname === '/auth/v1/token') return reply(sessionFor(state.aal, state.user()))
    if (u.pathname === '/auth/v1/user') return reply(state.user())
    if (u.pathname === '/auth/v1/logout') return reply({}, 204)
    if (u.pathname === '/auth/v1/factors' && m === 'POST') {
      const body = JSON.parse(req.postData() || '{}')
      assert.equal(body.factor_type, 'totp')
      state.factors.push({ id: 'factor-new', factor_type: 'totp', friendly_name: body.friendly_name, status: 'unverified', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      return reply({ id: 'factor-new', type: 'totp', friendly_name: body.friendly_name, totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/SageRock:rocky?secret=JBSWY3DPEHPK3PXP' } })
    }
    const fm = u.pathname.match(/^\/auth\/v1\/factors\/([^/]+)(?:\/(challenge|verify))?$/)
    if (fm) {
      const [, id, action] = fm
      if (action === 'challenge') return reply({ id: 'challenge-1', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 })
      if (action === 'verify') {
        const body = JSON.parse(req.postData() || '{}')
        if (body.code !== '123456') return reply({ error: 'invalid_code', msg: 'Invalid TOTP code entered' }, 422)
        state.factors = state.factors.map((f) => f.id === id ? { ...f, status: 'verified' } : f)
        state.aal = 'aal2'
        return reply(sessionFor('aal2', state.user()))
      }
      if (m === 'DELETE') { state.factors = state.factors.filter((f) => f.id !== id); state.aal = 'aal1'; return reply({ id }) }
    }
    if (u.pathname === '/rest/v1/admin_users') return reply({ id: 'admin', user_id: userId, email: 'rocky@sagerock.com', role: state.role, client_id: null })
    if (u.pathname === '/rest/v1/clients') return reply([])
    return reply([])
  }
  return state
}

async function login(page, base) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle0' })
  await page.type('input[type=email]', 'rocky@sagerock.com')
  await page.type('input[type=password]', 'correct horse battery staple')
  await Promise.all([page.click('button[type=submit]'), page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})])
}

const nav = (page) => page.waitForFunction(() => Array.from(document.querySelectorAll('a, button')).some((el) => el.textContent?.trim() === 'Newsletters'), { timeout: 15000 })
const testid = (page, id, timeout = 15000) => page.waitForSelector(`[data-testid="${id}"]`, { timeout })

async function enterCode(page, code) {
  const input = await testid(page, 'mfa-code')
  await input.click({ clickCount: 3 })
  await input.type(code)
  await page.keyboard.press('Enter')
}

;(async () => {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const run = async (name, state, body) => {
      const context = await browser.createBrowserContext()
      const page = await context.newPage()
      await page.setViewport({ width: 1300, height: 900 })
      page.on('dialog', (d) => d.accept())
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const u = new URL(req.url())
        const reply = (data, status = 200) => req.respond({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' }, body: status === 204 ? '' : JSON.stringify(data) })
        if (u.hostname === 'mfa-test.supabase.co') return state.handle(req, reply)
        if (u.origin === base) {
          if (u.pathname.startsWith('/api/')) return reply({})
          return req.continue()
        }
        return req.abort()
      })
      try { await body(page, state); console.log(`PASS ${name}`) } finally { await context.close() }
    }

    await run('super admin without a factor must enroll before seeing the app', scenario({ role: 'super_admin', factors: [], aal: 'aal1' }), async (page) => {
      await login(page, base)
      await testid(page, 'mfa-enroll')
      await testid(page, 'mfa-qr')
      const secret = await page.$eval('[data-testid="mfa-secret"]', (el) => el.textContent)
      assert.equal(secret, 'JBSWY3DPEHPK3PXP')
      assert.equal(await page.$('a[href="/contacts"]'), null, 'app nav must not render before enrollment')
      await enterCode(page, '000000')
      await page.waitForFunction(() => document.body.textContent.includes('Invalid TOTP code'), { timeout: 10000 })
      await enterCode(page, '123456')
      await nav(page)
      assert.equal(await page.$('[data-testid="mfa-shell"]'), null)
    })

    await run('enrolled user is asked for a code each session, then manages it in Settings', scenario({ role: 'super_admin', factors: [verifiedFactor], aal: 'aal1' }), async (page, state) => {
      await login(page, base)
      await testid(page, 'mfa-verify')
      assert.equal(await page.$('[data-testid="mfa-enroll"]'), null, 'an enrolled user gets the code prompt, not setup')
      await enterCode(page, '123456')
      await nav(page)
      await page.goto(`${base}/settings`, { waitUntil: 'networkidle0' })
      await testid(page, 'security-card')
      await page.waitForFunction(() => document.querySelector('[data-testid="security-card"]')?.textContent.includes('Authenticator app (test)'), { timeout: 10000 })
      const text = await page.$eval('[data-testid="security-card"]', (el) => el.textContent)
      assert.match(text, /Two-factor authentication/)
      assert.match(text, /Required for super admins/)
      const [turnOff] = await page.$$('xpath/.//*[@data-testid="security-card"]//button[contains(., "Turn off")]')
      assert.ok(turnOff, 'Turn off button')
      await turnOff.click()
      // Factor removed → super admin is sent straight back to setup by the gate.
      await testid(page, 'mfa-enroll')
      assert.ok(state.calls.some((c) => c === 'DELETE /auth/v1/factors/factor-verified'), 'unenroll was called')
    })

    await run('client admin without a factor passes straight through and can opt in', scenario({ role: 'client_admin', factors: [], aal: 'aal1' }), async (page) => {
      await login(page, base)
      await nav(page)
      assert.equal(await page.$('[data-testid="mfa-shell"]'), null)
      await page.goto(`${base}/settings`, { waitUntil: 'networkidle0' })
      await testid(page, 'security-card')
      await page.waitForFunction(() => document.querySelector('[data-testid="security-card"]')?.textContent.includes('Set up two-factor'), { timeout: 10000 })
      const text = await page.$eval('[data-testid="security-card"]', (el) => el.textContent)
      assert.doesNotMatch(text, /Required for super admins/)
      const [setup] = await page.$$('xpath/.//*[@data-testid="security-card"]//button[contains(., "Set up two-factor")]')
      await setup.click()
      await testid(page, 'mfa-qr')
      await enterCode(page, '123456')
      await page.waitForFunction(() => document.querySelector('[data-testid="security-card"]')?.textContent.includes('On'), { timeout: 10000 })
    })
    console.log('ALL PASS')
  } finally {
    await browser.close()
    server.close()
  }
})().catch((err) => { console.error('FAIL', err); process.exit(1) })

