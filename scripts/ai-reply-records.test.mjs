import test from 'node:test'
import assert from 'node:assert/strict'
import { validateReply, replySql, reportSql } from './ai-reply-records.mjs'

export const sample = {
  clientId: '00000000-0000-0000-0000-000000000001',
  draftId: '00000000-0000-0000-0000-000000000003',
  senderEmail: 'person@example.test', originalMessageId: '<customer-reply@example.test>',
  outboundMessageId: 'outgoing-message', sourceUrl: 'https://mail.example.test/reply',
  receivedAt: '2026-01-02T10:00:00-04:00', body: "I'm interested. Can you help?",
  kind: 'human_reply', recordedBy: 'Test recorder',
}

test('requires reviewed human evidence and timezone; refuses future replies', () => {
  for (const patch of [{ kind: 'automatic_response' }, { originalMessageId: '' }, { sourceUrl: '' },
    { receivedAt: '2026-01-02T10:00:00' }, { receivedAt: '2999-01-01T00:00:00Z' },
    { senderEmail: 'staff <person@example.test>' }, { draftId: 'bad' }]) {
    assert.throws(() => validateReply({ ...sample, ...patch }))
  }
})

test('identity follows the original reply, independent of forwarding source', () => {
  assert.equal(validateReply(sample).eventId, validateReply({ ...sample, sourceUrl: 'https://mail.example.test/another-forward' }).eventId)
  assert.notEqual(validateReply(sample).eventId, validateReply({ ...sample, originalMessageId: '<second@example.test>' }).eventId)
  assert.match(replySql(sample), /ROLLBACK;$/)
  assert.match(replySql(sample, true), /COMMIT;$/)
})

test('untrusted message text cannot become SQL', () => {
  const body = "'; END; $record_reply$; DROP TABLE contacts; -- \\ $()"
  assert.ok(!replySql({ ...sample, body }).includes(body))
  assert.throws(() => reportSql({ clientId: sample.clientId, start: '2026-02-01T00:00:00Z', end: '2026-01-01T00:00:00Z' }))
})
