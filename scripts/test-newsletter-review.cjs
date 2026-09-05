// Browser regression for emailed review links. Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-newsletter-review.cjs
const assert = require('node:assert/strict')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const app = express()
app.use(express.static(process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'))
app.get('*', (_, res) => res.sendFile((process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build') + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'dab0af79-80db-4e91-854c-be1b5ccd7288',name:'SageRock'}
const other = {id:'00000000-0000-4000-8000-000000000001',name:'Another Client'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'rocky@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  let denied = false
  try {
    const page = await browser.newPage()
    await page.setViewport({width:1400,height:950})
    await page.evaluateOnNewDocument(id=>localStorage.setItem('selectedClientId',id),other.id)
    await page.setRequestInterception(true)
    page.on('request',req=>{
      const u = new URL(req.url())
      const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS'},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([other,owner])
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id')){
          assert.equal(u.searchParams.has('client_id'),false,'Draft link must resolve by id under RLS before choosing client')
          return denied?reply({code:'PGRST116',message:'No rows'},406):reply({id:draftId,client_id:owner.id,name:'Rocky review test',subject:'Review test',html_content:'<!DOCTYPE html><html><body><h1>Draft loaded correctly</h1></body></html>'})
        }
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname.startsWith('/api/'))return reply({templates:[],sentCampaigns:[]})
        return req.continue()
      }
      return req.abort()
    })
    await page.goto(`${base}/email-builder?templateId=${draftId}`)
    await page.waitForSelector('input[type=email]')
    assert.equal(new URL(page.url()).searchParams.get('next'),`/email-builder?templateId=${draftId}`)
    // Refreshing the login page must not lose the original draft URL.
    await page.reload()
    await page.waitForSelector('input[type=email]')
    await page.type('input[type=email]',user.email)
    await page.type('input[type=password]','test-password')
    await page.click('button[type=submit]')
    await page.waitForFunction(()=>document.body.innerText.includes('Rocky review test'))
    await page.waitForSelector('iframe[title="Email preview"]')
    const frame = await (await page.$('iframe[title="Email preview"]')).contentFrame()
    assert.ok((await frame.$eval('body',b=>b.innerText)).includes('Draft loaded correctly'))
    assert.equal(await page.$eval('select',s=>s.value),owner.id)
    assert.equal(new URL(page.url()).searchParams.get('templateId'),draftId)
    console.log('PASS: logged-out draft link survives login refresh and opens the owning client preview')
    denied=true
    await page.reload()
    await page.waitForFunction(()=>document.body.innerText.includes('Unable to open draft'))
    assert.equal(await page.$('iframe[title="Email preview"]'),null)
    console.log('PASS: inaccessible draft shows a visible error, not an empty builder')
    denied=false
    const buttons=await page.$$('button')
    for(const button of buttons){if(await button.evaluate(b=>b.textContent==='Try again')){await button.click();break}}
    await page.waitForSelector('iframe[title="Email preview"]')
    console.log('PASS: retry recovers the draft after a loading failure')
  } finally {await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
