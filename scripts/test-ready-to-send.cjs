// Browser regression for the builder's "Ready to send?" panel: issues are
// listed, "Fix it…" selects the element and starts the sentence, "Fix it"
// sends a scoped request, and fixed emails show as ready.
// Build with dummy Supabase values:
// VITE_SUPABASE_URL=https://newsletter-test.supabase.co VITE_SUPABASE_ANON_KEY=test-only-key npx vite build --outDir /tmp/sagerock-newsletter-ui-build
// node scripts/test-ready-to-send.cjs email-with-placeholder-link.html
const assert = require('node:assert/strict')
const fs = require('node:fs')
const express = require('../api/node_modules/express')
const puppeteer = require('../api/node_modules/puppeteer')
const BUILD = process.env.NEWSLETTER_TEST_BUILD || '/tmp/sagerock-newsletter-ui-build'
const file = process.argv[2]
if (!file) throw new Error('Pass an email HTML file that has a link to "#" and an image with alt text')
const app = express()
app.use(express.static(BUILD))
app.get('*', (_, res) => res.sendFile(BUILD + '/index.html'))
const draftId = '9b71b388-7415-41cb-8383-549cb0e671c8'
const owner = {id:'90fdfb72-6ff8-4d7a-a71b-f94f396ccced',name:'Alderbrook Waldorf School (sample)'}
const user = {id:'00000000-0000-4000-8000-000000000002',email:'sage@sagerock.com',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}
const token = [Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.')
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
// One image loses its alt text so there's also a one-click fix to try.
const original = fs.readFileSync(file, 'utf8').replace(/(<img\b[^>]*?)\s+alt=(["'])[^"']*\2/i, '$1')
const chats = []
const linkChecks = []
const visualChecks = []

;(async()=>{
  const server = app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']})
  try {
    const page = await browser.newPage()
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
        if(u.pathname==='/rest/v1/templates'&&u.searchParams.has('id'))return reply({id:draftId,client_id:owner.id,name:'Open house',subject:'Fall Open House',preview_text:'Come visit',html_content:original})
        return reply([])
      }
      if(u.origin===base){
        if(u.pathname==='/api/email-builder/chat'){
          const body = JSON.parse(req.postData())
          chats.push(body)
          const html = body.currentEmail.html_content
          const { start, end } = body.selection
          const part = html.slice(start, end)
          // Pretend the AI did what was asked to the selected element.
          const changed = /Change this link to: (\S+)/.test(body.messages.at(-1).content)
            ? part.replace(/href=(["'])[^"']*\1/, `href="${body.messages.at(-1).content.split(': ')[1]}"`)
            : part.replace(/<img\b/i, '<img alt="Alderbrook logo"')
          const next = html.slice(0, start) + changed + html.slice(end)
          return req.respond({status:200,contentType:'text/event-stream',body:sse([
            {type:'text',text:'Done.'},
            {type:'result',mode:'edits',edit_count:1,note:'Done.',selection:{start,end:start+changed.length},design:{html_content:next,subject:'Fall Open House',preview_text:'Come visit'}},
            {type:'done'},
          ])})
        }
        if(u.pathname==='/api/email-builder/check-links'){
          const { urls } = JSON.parse(req.postData())
          linkChecks.push(urls)
          return reply({ results: Object.fromEntries(urls.map(url => [url, url.includes('missing')
            ? { url, outcome: 'broken', status: 404, detail: 'the page returns 404 (not found)' }
            : { url, outcome: 'ok', status: 200 }])) })
        }
        if(u.pathname==='/api/email-builder/visual-check'){
          visualChecks.push(JSON.parse(req.postData()))
          return reply(visualChecks.length === 1
            ? { looks_right: false, summary: 'One problem.', problems: [{ problem: 'The button text is hard to read on gold', where: 'the RSVP button' }] }
            : { looks_right: true, summary: 'Looks right.', problems: [] })
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
    await page.waitForSelector('[aria-label="Ready to send check"]')
    const badge = () => page.$eval('[aria-label="Ready to send check"]', b => b.innerText.trim())
    assert.match(await badge(), /^1 to fix, 1 to review/)

    const clickButton = text => page.evaluate(t => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === t)
      if (!b) throw new Error('No button ' + t); b.click()
    }, text)
    await page.click('[aria-label="Ready to send check"]')
    await page.waitForFunction(() => document.body.innerText.includes('doesn’t go anywhere'))
    const panel = await page.evaluate(() => document.querySelector('[aria-label="Ready to send check"]').parentElement.innerText)
    assert.match(panel, /"Save Your Spot" doesn’t go anywhere/)
    assert.match(panel, /has no description/)
    await page.screenshot({ path: '/tmp/sagerock-ready-to-send-open.png' })

    // Link fix: selects the button and starts the sentence; the user finishes it.
    const fixButtons = await page.$$eval('button', bs => bs.map(b => b.innerText.trim()))
    assert.ok(fixButtons.includes('Fix it…') && fixButtons.includes('Fix it'))
    await clickButton('Fix it…')
    await page.waitForSelector('[aria-label="Clear selection"]')
    assert.equal(await page.$eval('textarea[aria-label="Newsletter instructions"]', t => t.value), 'Change this link to: ')
    await page.type('textarea[aria-label="Newsletter instructions"]', 'https://alderbrook.example/missing-page')
    await page.click('button[aria-label="Send instructions"]')
    await page.waitForFunction(() => document.body.innerText.includes('Quick edit · 1 change'))
    const span1 = chats[0].currentEmail.html_content.slice(chats[0].selection.start, chats[0].selection.end)
    assert.match(span1, /^<a\b[^>]*href=(["'])#\1/i, 'the link fix is scoped to the button')
    // The new address is checked and found broken.
    await page.waitForFunction(() => /^1 to fix, 1 to review/.test(document.querySelector('[aria-label="Ready to send check"]').innerText.trim()), { timeout: 10000 })
    assert.ok(linkChecks.flat().includes('https://alderbrook.example/missing-page'))
    await page.click('[aria-label="Ready to send check"]')
    await page.waitForFunction(() => document.body.innerText.includes('leads to a broken page'))
    await page.click('[aria-label="Ready to send check"]')
    // The visual check ran on the change and its finding is offered as a fix.
    await page.waitForFunction(() => document.body.innerText.includes('Looking at the result, I noticed'))
    assert.match(await page.$eval('body', b => b.innerText), /the RSVP button: The button text is hard to read on gold/)
    assert.equal(visualChecks[0].request, 'Change this link to: https://alderbrook.example/missing-page')
    assert.ok(!visualChecks[0].html.includes('data-sr'))
    await page.type('textarea[aria-label="Newsletter instructions"]', 'Change this link to: https://alderbrook.example/open-house')
    // Re-select the button by fixing the broken-link issue.
    await page.evaluate(() => document.querySelector('textarea[aria-label="Newsletter instructions"]').value = '')
    await page.click('[aria-label="Ready to send check"]')
    await page.waitForFunction(() => document.body.innerText.includes('leads to a broken page'))
    await clickButton('Fix it…')
    await page.waitForSelector('[aria-label="Clear selection"]')
    await page.type('textarea[aria-label="Newsletter instructions"]', 'https://alderbrook.example/open-house')
    await page.click('button[aria-label="Send instructions"]')
    await page.waitForFunction(() => document.body.innerText.includes('it looks right'), { timeout: 10000 })
    await page.waitForFunction(() => /^1 to review/.test(document.querySelector('[aria-label="Ready to send check"]').innerText.trim()), { timeout: 10000 })

    // Alt-text fix: one click sends a scoped request straight away.
    await page.click('[aria-label="Ready to send check"]')
    await page.waitForFunction(() => document.body.innerText.includes('has no description'))
    await clickButton('Fix it')
    await page.waitForFunction(() => document.querySelectorAll('[class*="bg-blue-50"]').length >= 2)
    await page.waitForFunction(() => /Ready to send/.test(document.querySelector('[aria-label="Ready to send check"]').innerText))
    assert.equal(chats.length, 3)
    assert.match(chats[2].messages.at(-1).content, /alt text/)
    const span2 = chats[2].currentEmail.html_content.slice(chats[2].selection.start, chats[2].selection.end)
    assert.match(span2, /^<img\b/i, 'the alt-text fix is scoped to the image')
    await page.click('[aria-label="Ready to send check"]')
    await page.waitForFunction(() => document.body.innerText.includes('No problems found'))
    await page.screenshot({ path: '/tmp/sagerock-ready-to-send.png' })
    console.log('PASS: ready-to-send lists issues, catches a broken link, shows the visual check, fixes a link (user-finished) and alt text (one click), then shows ready')
  } finally { await browser.close(); server.close() }
})().catch(e=>{console.error(e);process.exitCode=1})
