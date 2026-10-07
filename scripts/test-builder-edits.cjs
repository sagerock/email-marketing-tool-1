// Browser regression for targeted edits in the email builder: the request
// carries the current design once (not old copies in history), and the
// server's resolved result updates the preview.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-builder-edits.cjs
const assert = require('node:assert/strict')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'Alderbrook Waldorf School (sample)'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const original = '<!DOCTYPE html><html><body><h1>Fall Open House</h1><a href="{{unsubscribe_url}}">Unsubscribe</a> {{mailing_address}}</body></html>'
const edited = original.replace('Fall Open House', 'Come Walk the Creek With Us')
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  const chats = []
  try {
    const page = await browser.newPage()
    await page.setViewport({width:1400,height:950})
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
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'Open house',subject:'Open house',preview_text:'Visit us',html_content:original})
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/email-builder/chat'){
          const body = JSON.parse(req.postData())
          chats.push(body)
          if(chats.length===1){
            const text = 'Warmer headline, more Alderbrook.\n```edits\n<<<<<<< FIND\nFall Open House\n=======\nCome Walk the Creek With Us\n>>>>>>> REPLACE\n```'
            return req.respond({status:200,contentType:'text/event-stream',body:sse([
              {type:'text',text},
              {type:'result',mode:'edits',edit_count:1,design:{html_content:edited,subject:'Open house',preview_text:'Visit us'}},
              {type:'done'},
            ])})
          }
          return req.respond({status:200,contentType:'text/event-stream',body:sse([
            {type:'text',text:'Tried a quick edit.\n```edits\n<<<<<<< FIND\nnope\n=======\nx\n>>>>>>> REPLACE\n```'},
            {type:'status',text:'That quick edit didn’t line up, so I’m rebuilding the full email…'},
            {type:'result',mode:'failed',reason:"Edit 1's FIND text was not found"},
            {type:'done'},
          ])})
        }
        if(u.pathname==='/api/brand-story')return reply({brand_story:'A school in the woods.'})
        if(u.pathname.startsWith('/api/'))return reply({templates:[],sentCampaigns:[]})
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

    await page.type('textarea[aria-label="Newsletter instructions"]','Make the headline warmer')
    await page.click('button[aria-label="Send instructions"]')
    await page.waitForFunction(()=>document.body.innerText.includes('Quick edit · 1 change'))
    const frame = await (await page.$('iframe[title="Email preview"]')).contentFrame()
    await frame.waitForFunction(()=>document.body.innerText.includes('Come Walk the Creek With Us'))
    assert.ok((await page.$eval('body',el=>el.innerText)).includes('Warmer headline, more Alderbrook.'))
    assert.ok(!(await page.$eval('body',el=>el.innerText)).includes('<<<<<<< FIND'), 'edit block is hidden from chat')

    // First request: the loaded draft goes as currentEmail, not inside history.
    assert.equal(chats[0].currentEmail.html_content, original)
    assert.equal(chats[0].currentEmail.subject, 'Open house')
    assert.ok(chats[0].messages.every(m => !String(m.content).includes('<!DOCTYPE')), 'history carries no HTML')
    assert.match(chats[0].messages[0].content, /\[email design output omitted\]/)
    console.log('PASS: targeted edit sends the current design once and updates the preview')

    await page.type('textarea[aria-label="Newsletter instructions"]','Change something impossible')
    await page.click('button[aria-label="Send instructions"]')
    await page.waitForFunction(()=>document.body.innerText.includes('couldn’t apply that change cleanly'))
    assert.equal(chats[1].currentEmail.html_content, edited, 'second turn edits the latest design')
    assert.ok(chats[1].messages.every(m => !String(m.content).includes('<!DOCTYPE')))
    await frame.waitForFunction(()=>document.body.innerText.includes('Come Walk the Creek With Us'))
    console.log('PASS: a failed edit leaves the preview unchanged and says so')
  } finally {await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
