// Browser regression for attaching files in the builder chat: images and PDFs
// upload to the media library as soon as they're chosen or dropped, other
// files are refused, Send waits for uploads, and the sent message carries the
// files' keys to /api/email-builder/chat and shows them in the chat.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-chat-attachments.cjs photo.png flyer.pdf notes.txt
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const [image, pdf, other] = process.argv.slice(2)
if (!other) throw new Error('Pass an image, a PDF and a non-image file')
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'SageRock'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
const uploads = []
const chats = []
let releaseUpload = null

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
    page.on('request',async req=>{
      const u = new URL(req.url())
      const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS'},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([owner])
        if(u.pathname==='/rest/v1/templates'&&req.method()==='POST')return reply({id:'9b71b388-0000-4000-8000-000000000001'})
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/media/upload'){
          const body = req.postData() || (req.hasPostData() ? await req.fetchPostData() : '') || ''
          const name = (body.match(/filename="([^"]+)"/) || [])[1]
          uploads.push(name)
          // Hold the PDF upload so the test can see Send wait for it.
          if(name.endsWith('.pdf')) await new Promise(r => { releaseUpload = r })
          return reply({key:`guids/CABINET_sr/images/1-${name}`,url:`${base}/media/${name}`,width:40,height:30,bytes:100,original_bytes:100,optimized:false})
        }
        if(u.pathname==='/api/email-builder/chat'){
          chats.push(JSON.parse(req.postData()))
          return req.respond({status:200,contentType:'text/event-stream',body:sse([
            {type:'text',text:'Here is a draft using your flyer.'},
            {type:'result',mode:'full',design:{html_content:'<html><body><p>Flyer</p></body></html>',subject:'Flyer news',preview_text:'News'}},
            {type:'done'},
          ])})
        }
        if(u.pathname==='/api/brand-story')return reply({brand_story:'x'})
        if(u.pathname.startsWith('/api/'))return reply({templates:[],sentCampaigns:[],results:{}})
        if(u.pathname.startsWith('/media/'))return req.respond({status:200,contentType:'image/png',body:fs.readFileSync(image)})
        return req.continue()
      }
      return req.abort()
    })
    await page.goto(`${base}/email-builder`)
    await page.waitForSelector('input[type=email]')
    await page.type('input[type=email]',user.email)
    await page.type('input[type=password]','test-password')
    await page.click('button[type=submit]')
    await page.waitForSelector('[aria-label="Attach images or PDFs"]')
    assert.ok(await page.$('[aria-label="Use a previous email as a reference"]'), 'the reference button is separate from attaching')

    // Choose a PDF and a text file with the attach button.
    const input = await page.$('[data-testid="attach-input"]')
    await input.uploadFile(path.resolve(pdf), path.resolve(other))
    await page.waitForFunction(() => document.querySelector('[aria-label="Attached files"]')?.innerText.includes('Only images and PDFs'))
    await page.type('textarea','Make a newsletter from this flyer')
    assert.equal(await page.$eval('[aria-label="Send instructions"]', b => b.disabled), true, 'Send waits for the upload')

    // Drop an image on the chat while the PDF is still uploading.
    const imageBytes = [...fs.readFileSync(image)]
    await page.evaluate(bytes => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }))
      const target = document.querySelector('textarea').closest('.relative')
      for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, imageBytes)
    await page.waitForFunction(() => document.querySelector('[aria-label="Attached files"] img'))
    releaseUpload()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Send instructions"]').disabled)
    assert.deepEqual(uploads.sort(), ['flyer.pdf', 'photo.png'], 'the text file is never uploaded')
    console.log('Attach + drop: images and PDFs upload, other files refused, Send waits')

    await page.click('[aria-label="Send instructions"]')
    await page.waitForFunction(() => document.body.innerText.includes('Here is a draft using your flyer.'))
    const last = chats[0].messages.at(-1)
    assert.equal(last.content, 'Make a newsletter from this flyer')
    assert.deepEqual(last.attachments.map(a => a.key).sort(), ['guids/CABINET_sr/images/1-flyer.pdf', 'guids/CABINET_sr/images/1-photo.png'])
    const chips = await page.$$eval('a[title="flyer.pdf"], a[title="photo.png"]', as => as.length)
    assert.equal(chips, 2, 'the sent message shows its files')
    const left = await page.$eval('[aria-label="Attached files"]', el => el.innerText)
    assert.match(left, /notes\.txt/, 'only the refused file is left in the composer')
    assert.doesNotMatch(left, /flyer|photo/)
    console.log('Send: message carries attachment keys and shows them')
    await page.screenshot({path:'/tmp/chat-attachments.png'})
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exit(1)})
