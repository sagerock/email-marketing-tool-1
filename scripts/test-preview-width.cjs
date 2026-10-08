// Browser regression for the builder's desktop preview width: on laptop-size
// screens the email frame stays 620px (so a 600px mobile breakpoint never
// fires), and "Hide chat" gives the preview the whole width.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-preview-width.cjs email.html
const assert = require('node:assert/strict')
const fs = require('node:fs')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const file = process.argv[2]
if (!file) throw new Error('Pass an email HTML file')
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'SageRock'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const html = fs.readFileSync(file, 'utf8')

;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  try {
    for (const width of [1280, 1366, 1440, 1920]) {
      const context = await browser.createBrowserContext()
      const page = await context.newPage()
      await page.setViewport({width,height:850})
      await page.evaluateOnNewDocument(id=>localStorage.setItem('selectedClientId',id),owner.id)
      await page.setRequestInterception(true)
      page.on('request',req=>{
        const u = new URL(req.url())
        const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS'},body:JSON.stringify(body)})
        if(u.hostname==='newsletter-test.supabase.co'){
          if(req.method()==='OPTIONS')return reply({})
          if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
          if(u.pathname==='/auth/v1/user')return reply(user)
          if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
          if(u.pathname==='/rest/v1/clients')return reply([owner])
          if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'Newsletter',subject:'October',preview_text:'News',html_content:html})
          return reply([])
        }
        if(u.origin===base){
          if(u.pathname==='/api/brand-story')return reply({brand_story:'x'})
          if(u.pathname.startsWith('/api/'))return reply({templates:[],sentCampaigns:[],results:{}})
          return req.continue()
        }
        return req.abort()
      })
      await page.goto(`${base}/email-builder?templateId=${draftId}`)
      await page.waitForSelector('input[type=email]')
      await page.type('input[type=email]',user.email)
      await page.type('input[type=password]','test-password')
      await page.click('button[type=submit]')
      await page.waitForSelector('iframe[title="Email preview"]')
      await new Promise(r=>setTimeout(r,600))
      const frameWidth = () => page.$eval('iframe[title="Email preview"]', f => f.contentWindow.innerWidth)
      const before = await frameWidth()
      assert.ok(before >= 601, `${width}px screen: preview is ${before}px, which triggers the 600px mobile layout`)
      await page.screenshot({path:`/tmp/preview-width-${width}.png`})
      const [hide] = await page.$$('xpath/.//button[contains(., "Hide chat")]')
      await hide.click()
      await new Promise(r=>setTimeout(r,400))
      assert.equal(await page.$('textarea') === null || !(await page.$eval('textarea', t => t.offsetParent)), true, 'chat is hidden')
      await page.screenshot({path:`/tmp/preview-width-${width}-wide.png`})
      const [show] = await page.$$('xpath/.//button[contains(., "Show chat")]')
      await show.click()
      assert.ok(await page.$eval('textarea', t => !!t.offsetParent), 'chat comes back')
      console.log(`${width}px screen: preview ${before}px wide, hide/show chat works`)
      await context.close()
    }
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exit(1)})
