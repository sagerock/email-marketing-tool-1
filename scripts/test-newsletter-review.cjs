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
  let failSave = true
  const writes = []
  try {
    const page = await browser.newPage()
    await page.setViewport({width:1400,height:950})
    await page.evaluateOnNewDocument(id=>localStorage.setItem('selectedClientId',id),other.id)
    await page.setRequestInterception(true)
    page.on('request',req=>{
      const u = new URL(req.url())
      const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS'},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([other,owner])
        if(u.pathname==='/rest/v1/templates' && ['POST','PATCH'].includes(req.method())) {
          if(failSave) return reply({message:'Temporary save failure'},500)
          writes.push({method:req.method(), body:JSON.parse(req.postData()), client:u.searchParams.get('client_id')})
          return reply({id:req.method()==='POST'?'new-version-id':draftId})
        }
        if(u.pathname==='/rest/v1/templates' && u.searchParams.get('select')?.includes('updated_at')) {
          assert.equal(u.searchParams.get('client_id'),`eq.${owner.id}`)
          return reply([{id:draftId,name:'Rocky review test',subject:'Review test',updated_at:new Date().toISOString(),created_at:new Date().toISOString()}])
        }
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id')){
          assert.equal(u.searchParams.has('client_id'),false,'Draft link must resolve by id under RLS before choosing client')
          return denied?reply({code:'PGRST116',message:'No rows'},406):reply({id:draftId,client_id:owner.id,name:'Rocky review test',subject:'Review test',html_content:'<!DOCTYPE html><html><body><h1>Draft loaded correctly</h1></body></html>'})
        }
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/email-builder/chat') {
          const text='Here is your revision.\n```json\n'+JSON.stringify({subject:'Revised subject',preview_text:'New preview text',html_content:'<html><body><h1>Revised newsletter</h1><img src="missing.png" alt="Hero image"></body></html>'})+'\n```'
          return req.respond({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'text',text})+'\n\n'})
        }
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
    const clickText = async text => {
      const buttons=await page.$$('button')
      for(const button of buttons) if(await button.evaluate((b,t)=>b.textContent.trim()===t,text)){await button.click();return}
      throw new Error(`Button not found: ${text}`)
    }
    assert.match(await page.$eval('main > header',el=>el.innerText),/SageRock[\s\S]*rocky@sagerock.com/)
    await page.type('textarea[aria-label="Newsletter instructions"]','Change the headline')
    await page.click('button[aria-label="Send instructions"]')
    await page.waitForFunction(()=>document.body.innerText.includes('Unsaved changes'))
    await page.click('summary')
    assert.ok((await page.$eval('details',el=>el.innerText)).includes('Hero image · Needs an image link'))
    await clickText('Save changes')
    await clickText('Save draft')
    await page.waitForFunction(()=>document.body.innerText.includes('Your changes haven’t been saved'))
    assert.ok((await page.$eval('textarea',el=>el.value))==='')
    failSave=false
    await clickText('Save draft')
    await page.waitForFunction(()=>document.body.innerText.includes('Draft saved')&&!document.body.innerText.includes('Your changes haven’t been saved'))
    assert.equal(writes[0].method,'PATCH')
    assert.equal(writes[0].client,`eq.${owner.id}`)
    assert.equal(writes[0].body.subject,'Revised subject')
    assert.equal(new URL(page.url()).pathname,'/email-builder')
    assert.ok((await page.$eval('body',el=>el.innerText)).includes('Change the headline'))
    await clickText('Save a new version')
    await clickText('Save new version')
    await page.waitForFunction(()=>location.search.includes('new-version-id'))
    assert.equal(writes[1].method,'POST')
    assert.equal(writes[1].body.client_id,owner.id)
    await clickText('Restore this preview')
    await page.waitForFunction(()=>document.body.innerText.includes('Unsaved changes'))
    const restored=await (await page.$('iframe[title="Email preview"]')).contentFrame()
    assert.ok((await restored.$eval('body',el=>el.innerText)).includes('Draft loaded correctly'))
    console.log('PASS: save failure preserves preview; successful save stays in chat; new versions preserve original; earlier preview restores')
    await page.screenshot({path:'/tmp/sagerock-builder-ux.png',fullPage:true})
    await page.click('nav a[href="/"]')
    await page.waitForFunction(()=>document.body.innerText.includes('Continue latest draft'))
    assert.ok((await page.$eval('main',el=>el.innerText)).includes('Let’s work on your newsletter'))
    await page.screenshot({path:'/tmp/sagerock-newsletter-home.png',fullPage:true})
    assert.ok(await page.$(`a[href="/email-builder?templateId=${draftId}"]`))
    await clickText('Switch account')
    await page.waitForFunction(()=>location.pathname==='/login')
    await page.waitForSelector('input[type=email]')
    assert.equal(new URL(page.url()).pathname,'/login')
    assert.equal(new URL(page.url()).searchParams.get('next'),'/')
    console.log('PASS: newsletter home is scoped to active client and switch account returns to login')
  } finally {await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
