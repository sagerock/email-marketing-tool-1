// Browser regression for the Brand Story page: load, interview, use draft, save.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-brand-story-build
// node scripts/test-brand-story.cjs [screenshot.png]
const assert = require('node:assert/strict')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.BRAND_STORY_TEST_BUILD || '/tmp/sagerock-brand-story-build'
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const client = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'Alderbrook Waldorf School (sample)'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  const saves = []
  const interviews = []
  try {
    const page = await browser.newPage()
    await page.setViewport({width:1400,height:1000})
    await page.evaluateOnNewDocument(id=>localStorage.setItem('selectedClientId',id),client.id)
    await page.setRequestInterception(true)
    page.on('request',req=>{
      const u = new URL(req.url())
      const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, PUT, DELETE, OPTIONS'},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([client])
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/brand-story' && req.method()==='GET'){
          assert.equal(u.searchParams.get('clientId'),client.id)
          return reply({...client,brand_story:null,brand_look:{},brand_story_updated_at:null})
        }
        if(u.pathname==='/api/brand-story/interview'){
          const body = JSON.parse(req.postData())
          interviews.push(body)
          if(body.messages.length===1) return reply({reply:'**Lovely.** Who are you mostly writing to?',draft:null})
          return reply({reply:'Here’s a first draft.',draft:{brand_story:'Alderbrook sits where the fields meet the woods.',brand_look:{colors:[{name:'Forest',hex:'#3A6B35'}],fonts:'Georgia'}}})
        }
        if(u.pathname==='/api/brand-story' && req.method()==='PUT'){
          const body = JSON.parse(req.postData())
          saves.push(body)
          return reply({...client,brand_story:body.brand_story,brand_look:body.brand_look,brand_story_updated_at:new Date().toISOString()})
        }
        if(u.pathname.startsWith('/api/'))return reply({})
        return req.continue()
      }
      return req.abort()
    })
    await page.goto(`${base}/brand-story`)
    await page.waitForSelector('input[type=email]')
    await page.type('input[type=email]',user.email)
    await page.type('input[type=password]','test-password')
    await page.click('button[type=submit]')
    await page.waitForFunction(()=>document.body.innerText.includes('Tell the story of Alderbrook'))
    assert.ok(await page.$eval('nav, aside, body',el=>el.innerText.includes('Brand Story')),'nav shows Brand Story')

    const clickButton = text => page.evaluate(t=>{
      const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().includes(t))
      if(!b) throw new Error('No button '+t); b.click()
    },text)
    await clickButton('Start the interview')
    await page.waitForFunction(()=>document.body.innerText.includes('Who are you mostly writing to?'))
    assert.ok(await page.evaluate(()=>[...document.querySelectorAll('strong')].some(s=>s.innerText==='Lovely.')),'interview reply renders markdown')
    await page.type('textarea[placeholder^="Answer here"]','Curious parents of young kids.')
    await page.keyboard.press('Enter')
    await page.waitForFunction(()=>document.body.innerText.includes('Draft story ready'))
    assert.equal(interviews[1].messages.length,3)
    assert.equal(interviews[1].clientId,client.id)

    await clickButton('Use this draft')
    await page.waitForFunction(()=>document.querySelector('textarea[rows="16"]').value.includes('fields meet the woods'))
    assert.equal(await page.$eval('input[aria-label="Hex code"]',i=>i.value),'#3A6B35')
    assert.ok(await page.evaluate(()=>document.body.innerText.includes('Unsaved changes')))

    await clickButton('Save')
    await page.waitForFunction(()=>document.body.innerText.includes('Saved. The email builder will use this'))
    assert.equal(saves.length,1)
    assert.equal(saves[0].clientId,client.id)
    assert.equal(saves[0].brand_story,'Alderbrook sits where the fields meet the woods.')
    assert.deepEqual(saves[0].brand_look,{colors:[{name:'Forest',hex:'#3A6B35'}],fonts:'Georgia'})
    if(process.argv[2]) await page.screenshot({path:process.argv[2],fullPage:true})
    console.log('PASS: brand story loads, interview drafts, draft applies, save sends story + look')
  } finally {
    await browser.close()
    server.close()
  }
})().catch(e=>{console.error(e);process.exit(1)})
