const test=require('node:test')
const assert=require('node:assert/strict')
const {validateRequest,guideMessage,createIntakeGuideHandler,CLIENT_ID}=require('./public-intake-guide')
const valid={name:'Example Reader',email:'Reader@example.com',company:'Example Firm',marketing:false}
function fixture(overrides={}){
 const deliveries=new Map();const records=[];const messages=[]
 const store={
  record:async v=>{records.push(v);return{id:'contact-1',email:v.email}},
  reserve:async row=>{const key=JSON.stringify([row.recipient,row.resource,row.request_day]);if(deliveries.has(key))return{...deliveries.get(key),created:false};const d={id:'delivery-1',status:'sending',...row};deliveries.set(key,d);return{...d,created:true}},
  finish:async(id,patch)=>{for(const d of deliveries.values())if(d.id===id)Object.assign(d,patch)},
  ...overrides.store,
 }
 const handler=createIntakeGuideHandler({store,sendMail:overrides.sendMail|| (async m=>{messages.push(m);return{messageId:'provider-1'}}),now:()=>new Date('2026-11-13T15:00:00Z'),logger:{error:()=>{}}})
 const call=async(body=valid)=>{const result={status:200};const res={status(n){result.status=n;return this},json(b){result.body=b;return this}};await handler({body},res);return result}
 return{call,records,messages,deliveries}
}
test('validates fields and explicit consent, discards arbitrary attribution and tenant',()=>{
 assert.equal(validateRequest({...valid,email:'bad'}),null)
 assert.equal(validateRequest({...valid,company:''}),null)
 const v=validateRequest({...valid,marketing:'true',client_id:'other',attribution:{utm_source:'bar',email:'private'}})
 assert.equal(v.email,'reader@example.com');assert.equal(v.marketing,false);assert.equal(v.client_id,undefined);assert.equal(v.attribution.email,undefined)
})
test('delivers requested guide without newsletter opt-in and keeps fixed sender/content',async()=>{
 const f=fixture();assert.deepEqual((await f.call()).body,{ok:true,email_status:'sent'})
 assert.equal(f.records[0].marketing,false);assert.equal(f.messages.length,1)
 const m=f.messages[0];assert.equal(m.from.email,'jax@sagerock.com');assert.equal(m.replyTo.email,'jax@sagerock.com');assert.equal(m.bcc,undefined)
 assert(m.text.endsWith('- Jax'));assert(m.text.includes('from-inquiry-to-prepared-consultation.pdf'))
 assert.equal([...f.deliveries.values()][0].client_id,CLIENT_ID)
 assert.equal([...f.deliveries.values()][0].status,'sent')
})
test('retries and simultaneous submissions send at most once',async()=>{
 const f=fixture();const replies=await Promise.all([f.call(),f.call(),f.call()]);assert.equal(f.messages.length,1)
 assert.equal(replies.filter(r=>r.body.email_status==='sent').length,1)
 assert.equal((await f.call()).body.email_status,'already_sent')
})
test('failed or ambiguous send keeps download available and never retries email',async()=>{
 for(const error of [Object.assign(new Error(),{code:401}),new Error('timeout')]){
  let sends=0;const f=fixture({sendMail:async()=>{sends++;throw error}})
  assert.deepEqual((await f.call()).body,{ok:true,email_status:'unavailable'})
  await f.call();assert.equal(sends,1)
  assert.equal([...f.deliveries.values()][0].status,error.code?'failed':'uncertain')
 }
})
test('contact failure stops sends; reservation failure still allows download',async()=>{
 const f=fixture({store:{record:async()=>{throw new Error()}}});assert.equal((await f.call()).status,503);assert.equal(f.messages.length,0)
 const g=fixture({store:{reserve:async()=>{throw new Error()}}});assert.equal((await g.call()).body.email_status,'unavailable');assert.equal(g.messages.length,0)
})
test('honeypot and invalid requests never save or send',async()=>{
 const f=fixture();await f.call({...valid,website:'bot'});assert.equal((await f.call({...valid,email:'invalid'})).status,400)
 assert.equal(f.records.length,0);assert.equal(f.messages.length,0)
})
test('hard-bounced contacts are suppressed without blocking the download',async()=>{
 const f=fixture({store:{record:async()=>({id:'contact-1',bounce_status:'hard'})}})
 assert.deepEqual((await f.call()).body,{ok:true,email_status:'unavailable'});assert.equal(f.messages.length,0)
 assert.equal([...f.deliveries.values()][0].status,'suppressed')
})
test('loss of status write after accepted send cannot cause another send',async()=>{
 const f=fixture({store:{finish:async()=>{throw new Error()}}})
 assert.equal((await f.call()).body.email_status,'sent');assert.equal((await f.call()).body.email_status,'pending');assert.equal(f.messages.length,1)
})
test('request data cannot inject content or a different download URL',()=>{
 const m=guideMessage('reader@example.com','delivery-1');assert(!m.html.includes('{{'));assert(!m.html.includes('<script'))
 assert.equal(m.trackingSettings.openTracking.enable,false)
})
