// Browser regression for the builder's single Save button: an existing design
// saves in one click (PATCH, no form), Save is off when nothing changed, and
// the menu's "Save as a new version…" inserts a copy that records its source.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-save-button.cjs email.html
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
const copyId = '9b71b388-0000-4000-8000-000000000099'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'SageRock'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
const html = fs.readFileSync(file, 'utf8')
const writes = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  try {
    const page = await browser.newPage()
    await page.setViewport({width:1366,height:850})
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
        if(u.pathname==='/rest/v1/templates'&&(req.method()==='PATCH'||req.method()==='POST')){
          writes.push({method:req.method(),query:u.search,body:JSON.parse(req.postData())})
          return reply({id:req.method()==='POST'?copyId:draftId})
        }
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'October Newsletter',subject:'October',preview_text:'News',html_content:html})
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/email-builder/chat'){
          const next = JSON.parse(req.postData()).currentEmail.html_content.replace('</body>','<p>Added line</p></body>')
          return req.respond({status:200,contentType:'text/event-stream',body:sse([
            {type:'text',text:'Done.'},
            {type:'result',mode:'edits',edit_count:1,note:'Done.',design:{html_content:next,subject:'October',preview_text:'News'}},
            {type:'done'},
          ])})
        }
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
    const saveButtons = () => page.$$eval('button', bs => bs.filter(b => /save/i.test(b.textContent) && b.offsetParent).map(b => ({text:b.textContent.trim(),disabled:b.disabled})))
    let buttons = await saveButtons()
    assert.deepEqual(buttons, [{text:'Save',disabled:true}], 'one Save button, off when nothing changed')

    await page.type('textarea','Add a line at the bottom')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.body.innerText.includes('Unsaved changes'))
    const [save] = await page.$$('xpath/.//button[normalize-space()="Save"]')
    await save.click()
    await page.waitForFunction(() => document.body.innerText.includes('Draft saved'))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'Save updates the design in place')
    assert.match(writes[0].query, new RegExp(draftId))
    assert.equal(writes[0].body.name, 'October Newsletter')
    assert.match(writes[0].body.html_content, /Added line/)
    assert.equal(await page.$('input[type=text][value*="October"]'), null, 'no form opened')
    console.log('Save: one click, PATCH in place, no form')

    await page.click('[aria-label="More save options"]')
    const [asNew] = await page.$$('xpath/.//button[contains(., "Save as a new version")]')
    await asNew.click()
    const [confirm] = await page.$$('xpath/.//button[normalize-space()="Save new version"]')
    await confirm.click()
    await page.waitForFunction(n => document.body.innerText.includes(n), {}, 'October Newsletter — new version')
    assert.equal(writes[1].method, 'POST', 'new version inserts a copy')
    assert.equal(writes[1].body.source_template_id, draftId)
    console.log('Save as a new version: POST copy with source_template_id')
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exit(1)})
