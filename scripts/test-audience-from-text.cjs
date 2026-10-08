// Browser regression for "Describe who should get this" on the campaign form:
// all of a client's tags load (more than one 1,000-row page), the description
// fills the tag / audience / Salesforce filters, a "Not included" warning is
// shown, the live count is re-run with the new filters, and undo restores the
// previous filters. Nothing is saved.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-audience-from-text.cjs
const assert = require('node:assert/strict')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const owner = {id:'ea7f1422-2d20-4299-85a7-c1201e953409',name:'Alconox'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
// 1,200 tags, the one we need is on the second page.
const tags = Array.from({ length: 1199 }, (_, i) => ({ name: `Tag ${String(i).padStart(4, '0')}` })).concat({ name: 'Zz Campaign: Pittcon 2026' })
const counts = []
const asks = []
let writes = 0

;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  try {
    const page = await browser.newPage()
    await page.setViewport({width:1366,height:900})
    await page.evaluateOnNewDocument(id=>localStorage.setItem('selectedClientId',id),owner.id)
    await page.setRequestInterception(true)
    page.on('request',req=>{
      const u = new URL(req.url())
      const reply = (body,status=200,headers={})=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS','Access-Control-Expose-Headers':'Content-Range',...headers},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(['POST','PATCH','DELETE'].includes(req.method())&&u.pathname.startsWith('/rest/v1/')&&!u.pathname.startsWith('/rest/v1/rpc/')) writes++
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([owner])
        if(u.pathname==='/rest/v1/tags'){
          const from = Number(u.searchParams.get('offset') || 0)
          const limit = Math.min(Number(u.searchParams.get('limit') || 1000), 1000) // PostgREST's row cap
          return reply(tags.slice(from, from + limit))
        }
        if(u.pathname==='/rest/v1/salesforce_campaigns')return reply([{id:'sf-2026',name:'Pittcon 2026',type:'Trade Show',client_id:owner.id}])
        if(u.pathname==='/rest/v1/rpc/count_campaign_recipients'){ const b = JSON.parse(req.postData()); counts.push(b); return reply(b.p_tags ? 47 : 2984) }
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/campaigns/audience-from-text'){
          asks.push(JSON.parse(req.postData()))
          return reply({ filters: { filter_tags: ['Zz Campaign: Pittcon 2026'], audience_filter: ['dealer'], salesforce_campaign_id: 'sf-2026',
            purchase_filter: { min_spend: '', min_orders: '', recency_mode: 'any', recency_days: '', product_mode: 'any', product_skus: [] } },
            explanation: 'Dealers in the Pittcon 2026 campaign.', not_possible: 'Opens can’t be filtered.', ignored: ['Old Tag'] })
        }
        if(u.pathname.startsWith('/api/'))return reply({templates:[],sentCampaigns:[],products:[]})
        return req.continue()
      }
      return req.abort()
    })
    await page.goto(`${base}/campaigns`)
    await page.waitForSelector('input[type=email]')
    await page.type('input[type=email]',user.email)
    await page.type('input[type=password]','test-password')
    await page.click('button[type=submit]')
    const [create] = await page.$$('xpath/.//button[contains(., "Create Campaign")]').then(async b => b.length ? b : (await page.waitForSelector('xpath/.//button[contains(., "Create Campaign")]'), page.$$('xpath/.//button[contains(., "Create Campaign")]')))
    await create.click()
    await page.waitForSelector('#audience-text')
    await page.waitForFunction(() => document.body.innerText.includes('Zz Campaign: Pittcon 2026'))
    console.log('Tags: all 1,200 load (second page included)')

    await page.type('#audience-text', 'dealers from Pittcon 2026 who opened recently')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.body.innerText.includes('Dealers in the Pittcon 2026 campaign.'))
    assert.equal(asks[0].clientId, owner.id)
    assert.equal(asks[0].text, 'dealers from Pittcon 2026 who opened recently')
    const state = await page.evaluate(() => ({
      sf: document.querySelector('select option[value="sf-2026"]')?.selected,
      dealer: [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'dealers')?.querySelector('input').checked,
      lead: [...document.querySelectorAll('label')].find(l => l.textContent.trim() === 'leads')?.querySelector('input').checked,
      text: document.body.innerText,
    }))
    assert.equal(state.sf, true, 'Salesforce campaign chosen')
    assert.equal(state.dealer, true)
    assert.equal(state.lead, false, 'audience limited to dealers')
    assert.match(state.text, /Not included: Opens can’t be filtered\./)
    assert.match(state.text, /Selected \(1\): Zz Campaign: Pittcon 2026/, 'chosen tags are listed above the tag wall')
    assert.match(state.text, /Left out because they don’t exist here: Old Tag/)
    for (let t = Date.now(); !counts.at(-1)?.p_tags && Date.now() - t < 5000;) await new Promise(r => setTimeout(r, 100))
    const last = counts.at(-1)
    assert.deepEqual(last.p_tags, ['Zz Campaign: Pittcon 2026'], 'the count is re-run with the new filters')
    assert.deepEqual(last.p_audience, ['dealer'])
    assert.equal(last.p_sf_campaign_id, 'sf-2026')
    console.log('Describe: filters filled, warning shown, count re-run')

    const [undo] = await page.$$('xpath/.//button[contains(., "Put the filters back")]')
    await undo.click()
    await page.waitForFunction(() => !document.querySelector('select option[value="sf-2026"]')?.selected)
    for (let t = Date.now(); counts.at(-1).p_tags !== null && Date.now() - t < 5000;) await new Promise(r => setTimeout(r, 100))
    const after = counts.at(-1)
    assert.equal(after.p_tags, null)
    assert.equal(after.p_audience, null)
    assert.equal(writes, 0, 'nothing was saved')
    console.log('Undo: filters back as they were; nothing saved')
    await page.screenshot({ path: '/tmp/audience-from-text.png' })
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exit(1)})
