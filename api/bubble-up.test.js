const test = require('node:test')
const assert = require('node:assert/strict')
const { detect, reconcile, buildReport, businessDaysBetween } = require('./bubble-up')

const NOW = new Date('2026-10-13T15:00:00Z')
const base = over => ({ now: NOW, instanceUrl: 'https://alconox.my.salesforce.com', opps: [], questions: [], emails: [],
  tasks: [], conversations: [], orders: [], clicks: [], contactsBySfId: new Map(), contactsByEmail: new Map(), ...over })
const keys = items => items.map(i => i.dedupe_key).sort()

test('businessDaysBetween skips weekends', () => {
  assert.equal(businessDaysBetween('2026-10-09T15:00:00Z', '2026-10-13T15:00:00Z'), 2) // Fri -> Tue
  assert.equal(businessDaysBetween('2026-10-12T15:00:00Z', '2026-10-13T15:00:00Z'), 1)
})

test('S1: survey asked for an expert and nobody followed up', () => {
  const opp = { salesforce_id: '006A', name: 'MTR Technologies - SR-25886', owner_name: 'Marius Dräger', contact_email: 'buyer@mtr.com',
    survey_completed_date: '2026-09-16', survey_speak_with_expert: 'Yes', survey_planning_purchase: null, is_won: false }
  const items = detect(base({ opps: [opp] }))
  assert.deepEqual(keys(items), ['S1:006A'])
  assert.equal(items[0].owner_name, 'Marius Dräger')
  assert.match(items[0].evidence, /expert/)

  // An outbound email after the survey closes it; one from automation-only tasks doesn't.
  const followed = detect(base({ opps: [opp], emails: [{ incoming: false, from_address: 'marius@alconox.com', to_address: 'buyer@mtr.com', message_at: '2026-09-20T10:00:00Z', subject: 'Your sample' }],
    tasks: [] }))
  assert.equal(followed.length, 0)
  const automated = detect(base({ opps: [opp], tasks: [{ what_id: '006A', created_by_name: 'Automated Process', sf_created_at: '2026-09-20T10:00:00Z', subject: 'Survey sent' }] }))
  assert.equal(automated.length, 1)
})

test('S2: plans to buy, not sure where', () => {
  const opp = { salesforce_id: '006B', name: 'City of Elkhorn - SR-25902', owner_name: 'Marius Dräger', contact_email: 'pw@elkhorn.gov',
    survey_completed_date: '2026-10-11', survey_planning_purchase: 'Yes', survey_purchase_from: 'Not sure who we can purchase it through.' }
  const [item] = detect(base({ opps: [opp] }))
  assert.equal(item.signal, 'S2')
  assert.match(item.evidence, /Not sure who/)
})

test('S3 waits two business days; S4 needs the customer to have written last', () => {
  const q = (over) => ({ salesforce_id: 'a0X1', name: 'AA-3641', email: 'x@hydrx.com', owner_name: 'Marius Dräger', status: 'New Question', ...over })
  assert.equal(detect(base({ questions: [q({ sf_created_at: '2026-10-12T15:00:00Z' })] })).length, 0)
  assert.deepEqual(keys(detect(base({ questions: [q({ sf_created_at: '2026-10-09T13:00:00Z' })] }))), ['S3:a0X1'])
  // Marked Response Emailed counts as answered even when we couldn't match the email.
  assert.equal(detect(base({ questions: [q({ sf_created_at: '2026-10-01T13:00:00Z', status: 'Response Emailed' })] })).length, 0)
  const s4 = q({ sf_created_at: '2026-09-28T13:00:00Z', status: 'Response Emailed', first_answer_at: '2026-09-29T13:00:00Z',
    last_message_incoming: true, last_message_at: '2026-10-07T13:00:00Z' })
  assert.deepEqual(keys(detect(base({ questions: [s4] }))), ['S4:a0X1'])
})

test('S5 skips noise and internal mail; S7 is a reply to our own subject line', () => {
  const emails = [
    { incoming: true, from_address: 'kathryn@lab.com', subject: 'Non-enzymatic sample?', message_at: '2026-10-06T14:00:00Z', body: 'Could we test one?' },
    { incoming: true, from_address: 'ap@buyer.com', subject: 'Invoice 4411', message_at: '2026-10-06T14:00:00Z' },
    { incoming: true, from_address: 'stacy@alconox.com', subject: 'fyi', message_at: '2026-10-06T14:00:00Z' },
    { incoming: true, from_address: 'john@clean.com', subject: 'Re: Any questions after your download? — Alconox, LLC', message_at: '2026-10-07T14:00:00Z' },
    { incoming: true, from_address: 'answered@x.com', subject: 'Question', message_at: '2026-10-01T14:00:00Z' },
    { incoming: false, from_address: 'nick@alconox.com', to_address: 'answered@x.com', subject: 'Re: Question', message_at: '2026-10-02T14:00:00Z' },
  ]
  assert.deepEqual(keys(detect(base({ emails }))), ['S5:kathryn@lab.com', 'S7:john@clean.com'])
})

test('a person already listed by a stronger signal is not listed again for their email', () => {
  const questions = [{ salesforce_id: 'a0X2', name: 'AA-1', email: 'p@co.com', status: 'New Question', sf_created_at: '2026-10-01T13:00:00Z' }]
  const emails = [{ incoming: true, from_address: 'p@co.com', subject: 'following up', message_at: '2026-10-02T13:00:00Z' }]
  assert.deepEqual(keys(detect(base({ questions, emails }))), ['S3:a0X2'])
})

test('S6: open trade-show task only when the person engaged after it was created', () => {
  const contact = { salesforce_id: '00Q1', email: 'lead@shop.com', first_name: 'Pat', last_name: 'Lee', company: 'Shop' }
  const task = { salesforce_id: '00T1', subject: 'HOT CIMTS2026: Answer technical question for Pat Lee', is_closed: false,
    sf_created_at: '2026-10-02T12:00:00Z', owner_name: 'Jeff Phillips', who_id: '00Q1' }
  const data = over => base({ tasks: [task], contactsBySfId: new Map([['00Q1', contact]]), ...over })
  assert.equal(detect(data()).length, 0)
  assert.equal(detect(data({ clicks: [{ email: 'lead@shop.com', timestamp: '2026-09-30T12:00:00Z' }] })).length, 0)
  const [item] = detect(data({ clicks: [{ email: 'lead@shop.com', timestamp: '2026-10-08T12:00:00Z' }] }))
  assert.equal(item.dedupe_key, 'S6:00T1')
  assert.match(item.evidence, /HOT CIMTS2026.*clicked/)
  assert.equal(detect(data({ clicks: [{ email: 'lead@shop.com', timestamp: '2026-10-08T12:00:00Z' }],
    tasks: [{ ...task, is_closed: true }] })).length, 0)
})

test('reconcile: new, still open, cleared with evidence, expired, snoozed, closed by a person', () => {
  const cand = { dedupe_key: 'S3:a', signal: 'S3', evidence: 'e', score: 70, signal_at: '2026-10-01T00:00:00Z', person_email: 'a@x.com' }
  const existing = [
    { id: '1', dedupe_key: 'S3:a', status: 'notified', signal: 'S3', signal_at: '2026-10-01T00:00:00Z' },
    { id: '2', dedupe_key: 'S5:b@x.com', status: 'notified', signal: 'S5', person_email: 'b@x.com', signal_at: '2026-10-05T00:00:00Z' },
    { id: '3', dedupe_key: 'S5:old@x.com', status: 'new', signal: 'S5', person_email: 'old@x.com', signal_at: '2026-07-01T00:00:00Z' },
    { id: '4', dedupe_key: 'S4:d', status: 'snoozed', signal: 'S4', snooze_until: '2026-10-10T00:00:00Z', signal_at: '2026-09-01T00:00:00Z' },
    { id: '5', dedupe_key: 'S3:e', status: 'not_useful', closed_by: 'Stacy', closed_at: '2026-10-05T00:00:00Z', signal: 'S3', signal_at: '2026-09-01T00:00:00Z' },
  ]
  const cands = [cand, { ...cand, dedupe_key: 'S4:d', signal: 'S4' }, { ...cand, dedupe_key: 'S3:e' }, { ...cand, dedupe_key: 'S1:new' }]
  const data = base({ emails: [{ incoming: false, from_address: 'nick@alconox.com', to_address: 'b@x.com', message_at: '2026-10-08T00:00:00Z', subject: 'Re: hi' }] })
  const { inserts, updates } = reconcile(existing, cands, data)
  assert.deepEqual(inserts.map(i => i.dedupe_key), ['S1:new'])
  const u = Object.fromEntries(updates.map(x => [x.id, x]))
  assert.equal(u['1'].patch.status, undefined)
  assert.equal(u['2'].patch.status, 'handled')
  assert.match(u['2'].patch.close_evidence, /nick@alconox.com emailed/)
  assert.equal(u['3'].patch.status, 'expired')
  assert.equal(u['4'].patch.status, 'new')
  assert.equal(u['5'], undefined) // a person said not useful, nothing new since
})

test('report leads with counts, shows new items and owners, signs Jax', () => {
  const open = [
    { status: 'new', signal: 'S1', score: 99, person_name: 'Ann', company: 'MTR', owner_name: 'Marius Dräger', evidence: 'asked for an expert', sf_url: 'https://x/1' },
    { status: 'notified', signal: 'S3', score: 70, person_email: 'q@x.com', owner_name: null, evidence: 'no answer' },
  ]
  const r = buildReport({ clientName: 'Alconox', open, closedSinceLast: [], now: NOW })
  assert.equal(r.subject, 'Bubble-up: 2 open, 1 new (Alconox)')
  assert.match(r.text, /NEW Ann, MTR \(Marius Dräger\)/)
  assert.match(r.text, /Unassigned/)
  assert.match(r.text, /- Jax\n$/)
  assert.match(r.html, /nothing went to Alconox/)
})

test('closers and automation do not count, real asks do', () => {
  const { isCloser } = require('./bubble-up')
  assert.equal(isCloser('Received, thank you for your heads up!'), true)
  assert.equal(isCloser('Shayna Sosnowik reacted to your message:'), true)
  assert.equal(isCloser('Pls share the pricing copy Sent from Outlook for Android'), false)
  assert.equal(isCloser('Hi Nick, Thank you for following up. We need a non-enzymatic, I would like to test a sample'), false)
  // Real thank-yous from the 10/20 list: satisfied phrases, signatures and disclaimers don't make them asks.
  assert.equal(isCloser("Great, this is exactly what I'm looking for. Thank you, Marius!\n\nRegards,\n\nHao\nFrom: Marius Draeger\nSent: Friday\n\nLet me know if you have any additional questions"), true)
  assert.equal(isCloser('Thank you so much,\nSincerelly\nKathy Grimm CST\nSurgical Coordinator\n724-626-2283\n"This email and any attached files are confidential and intended solely for the intended recipient(s). If you are not the named recipient, you should not read, distribute or copy this email or send it on."'), true)
  assert.equal(isCloser('Hi Marius,\nThank you for arranging the two samples! We look forward to testing Tergazyme and will get in touch if any questions come up.\nBest regards,\nDeborah'), true)
  assert.equal(isCloser("Hello! Thank you so much for following up. I don't have any *new* news at the moment!"), true)
  assert.equal(isCloser('The 13th will work. I will set up a call via teams and send you the link to the meeting.\nThank you,\nBrenden'), true)
  // Still asks: an ETA request and a question, even with a thank-you or sign-off.
  assert.equal(isCloser('Okay but if you could have eta from them for us it should be great, the customer need the shipment urgent.\nBest Regards,\nNan'), false)
  assert.equal(isCloser("Hi all, I've been buried in price roll. Anything needed from me at this point?\nThank you as always,\nTom Wright"), false)
  // A "Survey sent" task under Stacy's name isn't a follow-up.
  const opp = { salesforce_id: '006A', name: 'MTR - SR-1', contact_email: 'b@mtr.com', sample_request_contact_id: '003A',
    survey_completed_date: '2026-09-16', survey_speak_with_expert: 'Yes' }
  const items = detect(base({ opps: [opp], tasks: [{ what_id: '006A', created_by_name: 'Stacy Silverstein', subject: 'Survey sent: Sample Request Test Report 1', sf_created_at: '2026-09-18T08:00:00Z' }] }))
  assert.equal(items.length, 1)
  // An order thread whose subject just says ALCONOX LLC isn't a reply to our email.
  const emails = [{ incoming: true, from_address: 'a@merck.com', subject: 'RE: Liquinox residue question - 1003382 ALCONOX LLC', message_at: '2026-10-01T14:00:00Z', body: 'Please check this' }]
  assert.equal(detect(base({ emails }))[0].signal, 'S5')
})

test('S5 needs cleaning intent and skips pitches; automation-user owners are unassigned', () => {
  const at = '2026-10-01T14:00:00Z'
  const emails = [
    { incoming: true, from_address: 'chuck@ien.com', subject: 'Re: thought you might be a fit', body: "I've thrown newsletters, eblasts, content syndication", message_at: at },
    { incoming: true, from_address: 'kim@ess.com', subject: 'RE: COSMOPROF', body: "Yes I'm very interested in getting Alconox by the drum for cleaning", message_at: at },
    { incoming: true, from_address: 'x@lawfirm.com', subject: 'Alconox Conference Call', body: 'Please send the estimates', message_at: at },
  ]
  const contactsByEmail = new Map([['kim@ess.com', { email: 'kim@ess.com', salesforce_owner_name: 'Alconox Forms' }]])
  const items = detect(base({ emails, contactsByEmail }))
  assert.deepEqual(keys(items), ['S5:kim@ess.com'])
  assert.equal(items[0].owner_name, null)
})
