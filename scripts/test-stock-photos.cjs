// Browser regression for the builder's "Stock photos" panel: it sends the
// email's images to /api/email-builder/stock-ideas, shows Adobe Stock search
// links (photo filter + orientation) for photos only, and "Use a new photo
// here" selects that exact <img> so a dropped file replaces just that image.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-stock-photos.cjs email.html photo.png
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const [file, photo] = process.argv.slice(2)
if (!photo) throw new Error('Pass an email HTML file with at least two images, and a photo file')
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'SageRock'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
const html = fs.readFileSync(file, 'utf8')
const ideaCalls = []
const chats = []

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
    page.on('request',async req=>{
      const u = new URL(req.url())
      const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS'},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([owner])
        if(u.pathname==='/rest/v1/templates'&&req.method()==='PATCH')return reply({id:draftId})
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'Newsletter',subject:'October',preview_text:'News',html_content:html})
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/email-builder/stock-ideas'){
          const body = JSON.parse(req.postData())
          ideaCalls.push(body)
          return reply({ images: body.images.map((_, i) => i === 1
            ? { index: 1, skip: false, searches: ['educators at conference', 'autumn campus'], orientation: 'horizontal' }
            : { index: i, skip: true, searches: [], orientation: 'horizontal' }),
            extra: [{ idea: 'Beside the podcast blurb', searches: ['podcast microphone'], orientation: 'square' }] })
        }
        if(u.pathname==='/api/media/upload'){
          return reply({key:'guids/CABINET_sr/images/1-photo.png',url:`${base}/media/photo.png`,width:40,height:30,bytes:100,original_bytes:100,optimized:false})
        }
        if(u.pathname==='/api/email-builder/chat'){
          chats.push(JSON.parse(req.postData()))
          return req.respond({status:200,contentType:'text/event-stream',body:sse([{type:'text',text:'Swapped.'},{type:'done'}])})
        }
        if(u.pathname==='/api/brand-story')return reply({brand_story:'x'})
        if(u.pathname.startsWith('/api/'))return reply({templates:[],sentCampaigns:[],results:{}})
        if(u.pathname.startsWith('/media/'))return req.respond({status:200,contentType:'image/png',body:fs.readFileSync(photo)})
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
    const [open] = await page.$$('xpath/.//button[contains(., "Stock photos")]')
    await open.click()
    await page.waitForFunction(() => document.querySelector('[role=dialog]')?.innerText.includes('educators at conference'))

    const sent = ideaCalls[0]
    const imgCount = (html.match(/<img\b/gi) || []).length
    assert.equal(sent.clientId, owner.id)
    assert.equal(sent.images.length, imgCount, 'every image is described')
    assert.ok(sent.text.length > 100 && !/<\w/.test(sent.text), 'plain email text, no tags')
    const links = await page.$$eval('[role=dialog] a', as => as.map(a => a.href))
    const first = new URL(links[0])
    assert.equal(first.origin + first.pathname, 'https://stock.adobe.com/search/images')
    assert.equal(first.searchParams.get('k'), 'educators at conference')
    assert.equal(first.searchParams.get('filters[content_type:photo]'), '1')
    assert.equal(first.searchParams.get('filters[orientation]'), 'horizontal')
    const dialog = await page.$eval('[role=dialog]', d => d.innerText)
    assert.match(dialog, /Skipped \d+ logos/)
    assert.match(dialog, /Beside the podcast blurb/)
    console.log('Panel: ideas for photos only, Adobe links with photo + orientation filters')
    await page.screenshot({ path: '/tmp/stock-photos-panel.png' })

    // Use a new photo here → selects image 2, chat ready, file dropped, sent scoped.
    const [use] = await page.$$('xpath/.//button[contains(., "Use a new photo here")]')
    await use.click()
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'))
    assert.equal(await page.$eval('textarea', t => t.value), 'Replace this image with the attached photo.')
    assert.match(await page.evaluate(() => document.body.innerText), /Editing: Image/)
    const input = await page.$('[data-testid="attach-input"]')
    await input.uploadFile(path.resolve(photo))
    await page.waitForFunction(() => !document.querySelector('[aria-label="Send instructions"]').disabled)
    await page.click('[aria-label="Send instructions"]')
    await page.waitForFunction(() => document.body.innerText.includes('Swapped.'))
    const chat = chats[0]
    const part = chat.currentEmail.html_content.slice(chat.selection.start, chat.selection.end)
    const secondImg = [...html.matchAll(/<img\b[^>]*>/gi)][1][0]
    assert.equal(part, secondImg, 'the selection is exactly the second <img>')
    assert.equal(chat.messages.at(-1).attachments[0].key, 'guids/CABINET_sr/images/1-photo.png')
    console.log('Use a new photo here: selects that image; the dropped photo is sent scoped to it')
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exit(1)})
