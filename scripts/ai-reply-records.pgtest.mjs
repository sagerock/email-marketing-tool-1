// Creates its own disposable cluster; never connects to the application database.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { replySql, reportSql } from './ai-reply-records.mjs'

if (!process.argv.includes('--disposable-cluster')) {
  execFileSync('pg_virtualenv', ['node', fileURLToPath(import.meta.url), '--disposable-cluster'], { stdio: 'inherit' })
} else {
  const sql = query => execFileSync('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  sql(`CREATE TABLE contacts(id uuid PRIMARY KEY,client_id uuid,email text,tags text[],last_replied_at timestamptz);
    CREATE TABLE ai_followup_config(id uuid PRIMARY KEY,name text);
    CREATE TABLE ai_followup_contacts(id uuid PRIMARY KEY,contact_id uuid,client_id uuid,replied boolean,status text);
    CREATE TABLE ai_followup_drafts(id uuid PRIMARY KEY,contact_id uuid,client_id uuid,config_id uuid,followup_contact_id uuid,status text,sent_at timestamptz,sendgrid_message_id text,subject text);
    CREATE TABLE ai_followup_analytics(id uuid DEFAULT gen_random_uuid(),draft_id uuid,email text,event_type text,timestamp timestamptz,sg_event_id text UNIQUE);
    CREATE TABLE email_conversations(id uuid DEFAULT gen_random_uuid(),client_id uuid,contact_id uuid,direction text,subject text,body text,ai_generated boolean,escalated boolean,created_at timestamptz);
    INSERT INTO contacts VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','person@example.test',ARRAY['Existing'],'2026-01-03Z');
    INSERT INTO ai_followup_config VALUES ('00000000-0000-0000-0000-000000000004','Agent');
    INSERT INTO ai_followup_contacts VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',false,'completed');
    INSERT INTO ai_followup_drafts VALUES
      ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005','sent','2026-01-01Z','outgoing-message','A question'),
      ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004',null,'sent','2026-01-01Z','second-send','A duplicate');`)
  const sample = {
    clientId: '00000000-0000-0000-0000-000000000001', draftId: '00000000-0000-0000-0000-000000000003',
    senderEmail: 'person@example.test', originalMessageId: '<customer-reply@example.test>', outboundMessageId: 'outgoing-message',
    sourceUrl: 'https://mail.example.test/reply', receivedAt: '2026-01-02T14:00:00Z',
    body: "I'm interested. Unicode — and 'quotes' $record_reply$ stay text.", kind: 'human_reply', recordedBy: 'Test recorder',
  }
  sql(replySql(sample))
  assert.equal(sql('SELECT count(*) FROM email_conversations'), '0', 'preview rolls back')
  sql(replySql(sample, true))
  assert.match(sql(replySql(sample, true)), /already_recorded/)
  assert.equal(sql('SELECT count(*) FROM email_conversations'), '1', 'retry creates one conversation')
  assert.equal(sql('SELECT count(*) FROM ai_followup_analytics'), '1', 'retry creates one event')
  assert.equal(sql("SELECT tags=ARRAY['Existing','Replied'] AND last_replied_at='2026-01-03Z' FROM contacts"), 't', 'preserve tags and later reply time')
  assert.equal(sql("SELECT replied AND status='completed' FROM ai_followup_contacts"), 't')
  const invalid = [
    { clientId: '00000000-0000-0000-0000-000000000099' }, { senderEmail: 'someone-else@example.test' },
    { outboundMessageId: 'wrong' }, { receivedAt: '2025-12-31T12:00:00Z' },
    { draftId: '00000000-0000-0000-0000-000000000006', outboundMessageId: 'second-send' }, { body: 'Different body' },
  ]
  for (const patch of invalid) assert.throws(() => sql(replySql({ ...sample, ...patch }, true)))
  assert.equal(sql('SELECT count(*) FROM email_conversations'), '1', 'failed imports leave no partial writes')
  const report = reportSql({ clientId: sample.clientId, start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' })
  assert.match(sql(report), /All agents\|\|2\|1\|1\|100.00/, 'multiple sends count one recipient; later reply belongs to send cohort')
  assert.match(sql(reportSql({ clientId: sample.clientId, start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', asOf: '2026-01-01T23:00:00Z' })), /All agents\|\|2\|1\|0\|0.00/, 'future replies excluded from historical snapshot')
  console.log('Reply import PostgreSQL checks passed: rollback, deduplication, attribution, tenant isolation, preserved history, and unique-recipient reporting.')
}
