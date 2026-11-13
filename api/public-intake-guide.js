'use strict'
const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const { clientIp } = require('./public-list-signup')
const CLIENT_ID = 'dab0af79-80db-4e91-854c-be1b5ccd7288'
const RESOURCE = 'law-firm-intake-guide-v6'
const GUIDE_URL = 'https://sagerock.com/download/from-inquiry-to-prepared-consultation.pdf?src=intake-guide-email'
const clip = (v, n) => typeof v === 'string' ? v.trim().slice(0,n) : ''

const intakeGuideLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8,
  keyGenerator: req => ipKeyGenerator(clientIp(req)),
  validate: { xForwardedForHeader: false },
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Please try again in a few minutes.' },
})

function validateRequest(body) {
  const email=clip(body?.email,200).toLowerCase()
  const name=clip(body?.name,120)
  const company=clip(body?.company,200)
  if (!name || !company || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  return {
    email,name,company,size:['1','2-5','6+'].includes(body.size)?body.size:null,
    marketing:body.marketing===true,
    attribution:Object.fromEntries(['utm_source','utm_medium','utm_campaign'].map(k=>[k,clip(body.attribution?.[k],120)])),
  }
}

// Fixed, requested-resource content. No AI generation, attachments, arbitrary
// URLs, custom HTML, BCC, sales sequence or campaign enrollment.
function guideMessage(email, deliveryId) {
  const intro="Here’s your copy of From Inquiry to Prepared Consultation."
  const advice='The worksheet on the last page is a useful place to start. Choose one step that regularly needs chasing, then give it an owner and a next-action date.'
  const help='If you have a question about applying it, reply here. Please leave out client names and private matter details.'
  const reason='You requested this guide from SageRock. This email does not sign you up for a newsletter.'
  return {
    to:email, from:{email:'jax@sagerock.com',name:'Jax at SageRock'},
    replyTo:{email:'jax@sagerock.com',name:'Jax at SageRock'},
    subject:'Your small-firm intake guide',
    text:`${intro}\n\nDownload the guide:\n${GUIDE_URL}\n\n${advice}\n\n${help}\n\n${reason}\n\n- Jax`,
    html:`<div style="font:16px/1.6 Arial,sans-serif;color:#253c34;max-width:580px"><p>${intro}</p><p><a href="${GUIDE_URL}" style="color:#285448">Download your intake guide (PDF)</a></p><p>${advice}</p><p>${help}</p><p style="font-size:12px;color:#58685c">${reason}</p><p>- Jax</p></div>`,
    categories:['client-sagerock','intake-guide-delivery'],
    customArgs:{intake_guide_delivery_id:deliveryId},
    trackingSettings:{clickTracking:{enable:false,enableText:false},openTracking:{enable:false}},
  }
}

const publicStatus = status => status==='sent'?'already_sent':status==='sending'?'pending':'unavailable'

function createIntakeGuideHandler({store,sendMail,now=()=>new Date(),logger=console}) {
  return async (req,res) => {
    if (clip(req.body?.website,200)) return res.json({ok:true,email_status:'unavailable'})
    const value=validateRequest(req.body)
    if (!value) return res.status(400).json({ok:false,error:'Please enter your name, email and firm.'})
    let contact
    try { contact=await store.record(value) }
    catch { logger.error('intake-guide: contact save failed'); return res.status(503).json({ok:false,error:'Please try again.'}) }
    let delivery
    try {
      delivery=await store.reserve({client_id:CLIENT_ID,contact_id:contact.id,recipient:value.email,resource:RESOURCE,request_day:now().toISOString().slice(0,10)})
    } catch {
      logger.error('intake-guide: reservation failed')
      return res.json({ok:true,email_status:'unavailable'})
    }
    if (!delivery.created) return res.json({ok:true,email_status:publicStatus(delivery.status)})
    const finish=async patch=>{
      try { await store.finish(delivery.id,patch) }
      catch { logger.error(`intake-guide: delivery ${delivery.id} needs status reconciliation`) }
    }
    if (contact.bounce_status==='hard') {
      await finish({status:'suppressed',error_code:'hard_bounce'})
      return res.json({ok:true,email_status:'unavailable'})
    }
    try {
      const result=await sendMail(guideMessage(value.email,delivery.id))
      await finish({status:'sent',provider_message_id:result?.messageId||null})
      return res.json({ok:true,email_status:'sent'})
    } catch (error) {
      // A provider timeout may have accepted the email. Keep its reservation:
      // never retry automatically or clear the row to permit a duplicate.
      const knownFailure=Number.isInteger(error?.code) && error.code>=400 && error.code<500
      await finish({status:knownFailure?'failed':'uncertain',error_code:knownFailure?`provider_${error.code}`:'send_not_confirmed'})
      return res.json({ok:true,email_status:'unavailable'})
    }
  }
}

function createIntakeGuideStore(supabase) {
  return {
    async record(v) {
      const {data,error}=await supabase.rpc('record_intake_guide_request',{p_email:v.email,p_name:v.name,p_company:v.company,p_size:v.size,p_marketing:v.marketing,p_attribution:v.attribution})
      if(error||!data?.id) throw new Error('contact_save')
      return data
    },
    async reserve(row) {
      const {data,error}=await supabase.from('intake_guide_deliveries').insert(row).select('id,status').single()
      if(!error) return {...data,created:true}
      if(error.code!=='23505') throw new Error('reservation_failed')
      const existing=await supabase.from('intake_guide_deliveries').select('id,status').eq('client_id',row.client_id).eq('recipient',row.recipient).eq('resource',row.resource).eq('request_day',row.request_day).single()
      if(existing.error||!existing.data) throw new Error('reservation_lookup')
      return {...existing.data,created:false}
    },
    async finish(id,patch) {
      const {error}=await supabase.from('intake_guide_deliveries').update({...patch,updated_at:new Date().toISOString()}).eq('id',id).eq('client_id',CLIENT_ID)
      if(error) throw new Error('status_save')
    },
  }
}
module.exports={CLIENT_ID,RESOURCE,GUIDE_URL,intakeGuideLimiter,validateRequest,guideMessage,createIntakeGuideHandler,createIntakeGuideStore}
