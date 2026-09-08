import test from 'node:test'
import assert from 'node:assert/strict'
import {extractArchive,sourceDigest,matchCampaign} from './trello-email-archive.mjs'
const card = text => ({id:'card',name:'Strategy',actions:[{id:'comment',type:'commentCard',date:'2025-02-18T10:00:00Z',data:{text,dateLastEdited:'2025-09-01T10:00:00Z'}}]})
test('splits multiple emails while retaining original evidence and ambiguous dates',()=>{
  const text='**July 2025**\n\n**GTG:** Event A\nScheduled for 7/8/2025 2:30 PM\n\nDraft: Event B\nInternal list'
  const out=extractArchive(card(text),'client')
  assert.equal(out.rows.length,2)
  assert.equal(out.rows[0].source_period,'July 2025')
  assert.equal(out.rows[0].reported_status,'Scheduled (reported)')
  assert.equal(out.rows[1].reported_status,'Draft (reported)')
  assert.equal(out.rows[0].source_comment,text)
  assert.equal(out.rows[0].source_created_at,'2025-02-18T10:00:00Z')
  assert.equal(out.rows[0].planned_for,undefined)
  assert.ok(out.rows.every(r=>r.review_needed && r.is_legacy && !r.campaign_id))
})
test('retains unstructured strategy notes and does not treat audience wording as proof of sending',()=>{
  const result=extractArchive(card('October 2025\nPack expo post show 1\nPack expo post show 2'),'client')
  assert.equal(result.rows.length,1)
  assert.match(result.rows[0].brief,/post show 2/)
  const planned=extractArchive(card('GTG: Boston\nSent to previous attendees'),'client')
  assert.equal(planned.rows[0].reported_status,'GTG (reported)')
})
test('source IDs are stable and invalid input is rejected',()=>{
  assert.deepEqual(extractArchive(card('Draft: A'),'client'),extractArchive(card('Draft: A'),'client'))
  assert.throws(()=>extractArchive({cards:[]},'client'),/card JSON/)
  assert.notEqual(sourceDigest('a'),sourceDigest('b'))
})
test('matches only unique campaign titles in the stated year',()=>{
  const entry={name:'Boston — Post Show 7/30/2026, 11:00 AM',source_period:'July 2026'}
  const campaigns=[{id:'one',name:'Boston Post Show',created_at:'2026-07-01'}]
  assert.equal(matchCampaign(entry,campaigns),'one')
  assert.equal(matchCampaign({...entry,source_period:'July 2025'},campaigns),null)
  assert.equal(matchCampaign(entry,[...campaigns,{...campaigns[0],id:'two'}]),null)
  assert.equal(matchCampaign({...entry,name:'Boston Pre Show'},campaigns),null)
})
