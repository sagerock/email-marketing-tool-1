// Browser regression for typing over text in the builder preview: double-click
// a headline and retype it, change one word in a paragraph that has bold text
// and a link, and cancel an edit with Escape. Each kept edit must change only
// that text in the saved HTML (checked through the autosave).
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-inline-edit.cjs email.html "Headline text" "Paragraph start"
const assert = require('node:assert/strict')
const fs = require('node:fs')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const [file, headline, paraStart] = process.argv.slice(2)
if (!paraStart) throw new Error('Pass an email HTML file, a headline in it, and the start of a paragraph with bold text or a link')
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'SageRock'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const original = fs.readFileSync(file, 'utf8')
const writes = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
      const reply = (body,status=200)=>req.respond({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS'},body:JSON.stringify(body)})
      if(u.hostname==='newsletter-test.supabase.co'){
        if(req.method()==='OPTIONS')return reply({})
        if(u.pathname==='/auth/v1/token')return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user})
        if(u.pathname==='/auth/v1/user')return reply(user)
        if(u.pathname==='/rest/v1/admin_users')return reply({id:'admin',user_id:user.id,email:user.email,role:'super_admin',client_id:null})
        if(u.pathname==='/rest/v1/clients')return reply([owner])
        if(u.pathname==='/rest/v1/templates'&&req.method()==='PATCH'){ writes.push(JSON.parse(req.postData()).html_content); return reply({id:draftId}) }
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'Newsletter',subject:'October',preview_text:'News',html_content:original})
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
    await sleep(800)
    const frame = async () => (await page.$('iframe[title="Email preview"]')).contentFrame()
    // Double-click at the start of the element whose text begins with `text`.
    const startEditing = async text => {
      const f = await frame()
      const point = await f.evaluate(t => {
        const el = [...document.querySelectorAll('[data-sr]')].reverse().find(e => e.textContent.trim().startsWith(t))
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: r.left + 6, y: r.top + Math.min(12, r.height / 2) }
      }, text)
      const box = await (await page.$('iframe[title="Email preview"]')).boundingBox()
      await page.mouse.click(box.x + point.x, box.y + point.y, { clickCount: 2 })
      await f.waitForSelector('[contenteditable]')
      return f
    }
    const waitForSave = async n => { const t = Date.now(); while (writes.length < n) { if (Date.now() - t > 8000) throw new Error('no autosave'); await sleep(100) } }

    // 1. Retype the headline.
    let f = await startEditing(headline)
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
    await page.keyboard.type('Join Us in Milwaukee & Learn')
    await page.keyboard.press('Enter')
    await waitForSave(1)
    assert.equal(writes[0], original.replace(`>${headline}<`, '>Join Us in Milwaukee &amp; Learn<'), 'only the headline text changed')
    console.log('Headline: retyped, only that text changed in the HTML')

    // 2. Escape cancels.
    await page.waitForFunction(() => document.body.innerText.includes('All changes saved'))
    f = await startEditing('Join Us')
    await page.keyboard.type('XYZ')
    await page.keyboard.press('Escape')
    await sleep(2800)
    assert.equal(writes.length, 1, 'Escape keeps the email as it was')
    assert.equal(await f.$('[contenteditable]'), null)
    assert.ok((await f.evaluate(() => document.body.innerText)).includes('Join Us in Milwaukee & Learn'))
    assert.ok(!(await f.evaluate(() => document.body.innerText)).includes('XYZ'))
    console.log('Escape: edit cancelled, nothing saved')

    // 3. Change the first word of a paragraph that has bold text and a link.
    const pStart = writes[0].indexOf(paraStart)
    assert.ok(pStart > 0, 'paragraph found')
    const runEnd = writes[0].indexOf('<', pStart)
    f = await startEditing(paraStart)
    await page.keyboard.press('Home')
    await page.keyboard.type('Hello! ')
    await page.keyboard.press('Enter')
    await waitForSave(2)
    const saved = writes[1]
    assert.equal(saved.slice(0, pStart), writes[0].slice(0, pStart), 'nothing before the paragraph changed')
    assert.equal(saved.slice(saved.length - (writes[0].length - runEnd)), writes[0].slice(runEnd), 'bold text, link and the rest are untouched')
    assert.ok(saved.slice(pStart).startsWith('Hello! '))
    console.log('Paragraph: one word added, bold text and link untouched')
    await page.screenshot({ path: '/tmp/inline-edit.png' })
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exit(1)})
