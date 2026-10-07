// Browser regression for click-to-edit in the email builder preview: click
// selects a section, a second click drills in, the request carries the exact
// source span, the saved HTML never carries preview markers, and the selection
// follows the edited span. Uses real email HTML passed as files.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-click-to-edit.cjs alderbrook.html [scoop.html] [--shots=dir]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
const shots = process.argv.find(a => a.startsWith('--shots='))?.split('=')[1]
if (!files.length) throw new Error('Pass at least one email HTML file')
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'Alderbrook Waldorf School (sample)'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')

async function runFile(browser, base, file) {
  const original = fs.readFileSync(file, 'utf8')
  const chats = []
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({width:1500,height:1000})
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
      if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'Test email',subject:'Subject',preview_text:'',html_content:original})
      return reply([])
    }
    if(u.origin===base){
      if(u.pathname==='/api/email-builder/chat'){
        const body = JSON.parse(req.postData())
        chats.push(body)
        // Pretend the AI wrapped the selected part's text: echo it back changed.
        const { start, end } = body.selection
        const html = body.currentEmail.html_content
        const part = html.slice(start, end)
        const changed = part.replace(/>([^<>]*\S[^<>]*)</, (m, t) => `>${t} (edited)<`)
        const next = html.slice(0, start) + changed + html.slice(end)
        return req.respond({status:200,contentType:'text/event-stream',body:sse([
          {type:'text',text:'Updated that part.'},
          {type:'result',mode:'edits',edit_count:1,note:'Updated that part.',selection:{start,end:start+changed.length},
            design:{html_content:next,subject:'Subject',preview_text:''}},
          {type:'done'},
        ])})
      }
      if(u.pathname==='/api/brand-story')return reply({brand_story:'x'})
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
  const frameHandle = await page.$('iframe[title="Email preview"]')
  const frame = await frameHandle.contentFrame()
  await frame.waitForSelector('[data-sr]')

  // Pick a paragraph with text that sits inside a smaller section, and click it.
  const target = await frame.evaluateHandle(() => {
    const ps = [...document.querySelectorAll('p[data-sr]')].filter(p => p.innerText.trim().length > 20)
    return ps[Math.floor(ps.length / 2)]
  })
  await target.hover()
  await frame.waitForSelector('#sr-hover')
  await target.click()
  await page.waitForSelector('[aria-label="Clear selection"]')
  const sectionLabel = await page.$eval('[aria-label="Clear selection"]', b => b.parentElement.innerText)
  if (shots) await page.screenshot({ path: `${shots}/${file.split('/').pop()}-section.png` })

  await target.click()
  await page.waitForFunction(prev => {
    const chip = document.querySelector('[aria-label="Clear selection"]')?.parentElement
    return chip && chip.innerText !== prev
  }, {}, sectionLabel)
  const pieceLabel = await page.$eval('[aria-label="Clear selection"]', b => b.parentElement.innerText)
  if (shots) await page.screenshot({ path: `${shots}/${file.split('/').pop()}-piece.png` })

  const tagName = await target.evaluate(el => el.tagName.toLowerCase())
  const pieceText = await target.evaluate(el => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 20))
  await page.type('textarea[aria-label="Newsletter instructions"]','Make this warmer')
  await page.click('button[aria-label="Send instructions"]')
  await page.waitForFunction(() => document.body.innerText.includes('Quick edit · 1 change'))
  const sent = chats[0]
  assert.ok(!sent.currentEmail.html_content.includes('data-sr'), 'preview markers never reach the saved/sent HTML')
  assert.equal(sent.currentEmail.html_content, original)
  const span = original.slice(sent.selection.start, sent.selection.end)
  assert.match(span, /^<[a-z]/i, 'selection starts at a tag')
  assert.ok(span.length < original.length / 2, 'second click selected a smaller piece')
  assert.ok(span.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').includes(pieceText.split(' ').slice(0, 2).join(' ')), 'span contains the clicked text')

  // The selection follows the edited span: chip stays, outline redrawn.
  await frame.waitForFunction(() => true)
  const f2 = await (await page.$('iframe[title="Email preview"]')).contentFrame()
  await f2.waitForFunction(() => document.body.innerText.includes('(edited)'))
  // Poll by hand: the preview is a sandboxed, script-free frame.
  for (let i = 0; i < 50 && !(await f2.evaluate(() => !!document.getElementById('sr-selected'))); i++) {
    await new Promise(r => setTimeout(r, 200))
  }
  assert.ok(await f2.evaluate(() => !!document.getElementById('sr-selected')), 'selection outline redrawn on the edited email')
  assert.ok(await page.$('[aria-label="Clear selection"]'), 'selection persists after the edit')

  await page.click('[aria-label="Clear selection"]')
  await page.waitForFunction(() => !document.querySelector('[aria-label="Clear selection"]'))
  console.log(`PASS ${file.split('/').pop()}: ${sectionLabel.replace(/\s+/g, ' ')} → ${pieceLabel.replace(/\s+/g, ' ')} (<${tagName}>), ${span.length} chars sent`)
  await context.close()
}

;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  try { for (const f of files) await runFile(browser, base, f) }
  finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exitCode=1})
