// Runs migration 125 in its own disposable cluster; never connects to the application database.
// node scripts/webinar-registration.pgtest.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import assert from 'node:assert/strict'

if (!process.argv.includes('--disposable-cluster')) {
  execFileSync('pg_virtualenv', ['node', fileURLToPath(import.meta.url), '--disposable-cluster'], { stdio: 'inherit' })
} else {
  const sql = (query, role) => execFileSync('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { input: (role ? `SET ROLE ${role};\n` : '') + query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const T = 'dab0af79-80db-4e91-854c-be1b5ccd7288'
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; -- as in Supabase
    CREATE TABLE clients(id uuid PRIMARY KEY); INSERT INTO clients VALUES ('${T}');
    CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, email text, first_name text, last_name text,
      company text, job_function text, tags text[], source_code text, utm_params jsonb, form_submissions jsonb,
      unsubscribed boolean DEFAULT false, bounce_status text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(email, client_id));
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    INSERT INTO contacts(client_id,email,first_name,company,tags,source_code,unsubscribed,bounce_status)
      VALUES ('${T}','old@example.org','Old','Old School',ARRAY['existing'],'import',true,'hard');`)
  sql(fs.readFileSync(new URL('../supabase/migrations/125_webinar_registrations.sql', import.meta.url), 'utf8'))
  const reg = (email, marketing = false, heard = 'alma', attr = `'{"utm_source":"alma"}'`) => JSON.parse(sql(
    `SELECT record_webinar_registration('budget-2026-12-08','${email}','New Person Here','Example School','Head of School','${heard}',${marketing},${attr}::jsonb);`, 'service_role'))

  // New contact without consent: tagged, excluded from marketing, attribution kept.
  const a = reg('New@Example.org')
  assert.equal(a.created, true); assert.equal(a.confirmation_status, 'sending')
  assert.equal(sql(`SELECT tags::text||'|'||unsubscribed||'|'||company||'|'||job_function||'|'||(utm_params->>'utm_source')||'|'||first_name||'|'||last_name FROM contacts WHERE email='new@example.org'`),
    '{webinar-budget-2026-12-08}|true|Example School|Head of School|alma|New|Person Here')
  // Same email again: no second registration, same row, not created.
  const b = reg('new@example.org', true, 'other')
  assert.equal(b.created, false); assert.equal(b.registration_id, a.registration_id)
  assert.equal(sql(`SELECT count(*) FROM webinar_registrations`), '1')
  assert.equal(sql(`SELECT heard_from FROM webinar_registrations`), 'alma', 'first registration is kept')
  assert.equal(sql(`SELECT unsubscribed FROM contacts WHERE email='new@example.org'`), 't', 'later opt-in never silently clears unsubscribe')
  // Existing contact: profile, unsubscribe and bounce preserved; tags merged; consent tag added.
  const c = reg('old@example.org', true, 'sagerock', `'{}'`)
  assert.equal(c.created, true); assert.equal(c.bounce_status, 'hard')
  assert.equal(sql(`SELECT array_to_string(ARRAY(SELECT unnest(tags) ORDER BY 1),',')||'|'||unsubscribed||'|'||company||'|'||source_code||'|'||coalesce(utm_params::text,'null')||'|'||jsonb_array_length(form_submissions) FROM contacts WHERE email='old@example.org'`),
    'existing,webinar-budget-2026-12-08,webinar-budget-2026-12-08-opt-in|true|Old School|import|null|1')
  // Opted-in new contact is reachable by marketing.
  reg('optin@example.org', true, 'sagerock')
  assert.equal(sql(`SELECT unsubscribed FROM contacts WHERE email='optin@example.org'`), 'f')
  // Validation.
  assert.throws(() => sql(`SELECT record_webinar_registration('budget-2026-12-08','x@example.org','N','S','R','newsletter',false,'{}');`, 'service_role'))
  assert.throws(() => sql(`SELECT record_webinar_registration('Bad Event!','x@example.org','N','S','R','alma',false,'{}');`, 'service_role'))
  assert.throws(() => sql(`SELECT record_webinar_registration('budget-2026-12-08','x@example.org','N','','R','alma',false,'{}');`, 'service_role'))
  // Permissions: public roles cannot call the function or read the list.
  for (const role of ['anon', 'authenticated']) {
    assert.throws(() => sql(`SELECT record_webinar_registration('budget-2026-12-08','y@example.org','N','S','R','alma',false,'{}');`, role))
    assert.throws(() => sql(`SELECT count(*) FROM webinar_registrations;`, role))
  }
  assert.equal(sql(`UPDATE webinar_registrations SET confirmation_status='sent' WHERE id='${a.registration_id}' RETURNING confirmation_status;`, 'service_role'), 'sent')
  assert.throws(() => sql(`UPDATE webinar_registrations SET confirmation_status='bogus';`, 'service_role'))
  // Reminder list query the later reminder build will use.
  assert.equal(sql(`SELECT count(*) FROM webinar_registrations WHERE client_id='${T}' AND event='budget-2026-12-08'`), '3')
  // Migration 128: one mailing row per (registration, kind); browser roles locked out.
  sql(fs.readFileSync(new URL('../supabase/migrations/128_webinar_mailings.sql', import.meta.url), 'utf8'))
  sql(`INSERT INTO webinar_mailings(registration_id,kind) VALUES ('${a.registration_id}','reminder-day');`, 'service_role')
  assert.throws(() => sql(`INSERT INTO webinar_mailings(registration_id,kind) VALUES ('${a.registration_id}','reminder-day');`, 'service_role'))
  assert.throws(() => sql(`INSERT INTO webinar_mailings(registration_id,kind) VALUES ('${a.registration_id}','bogus');`, 'service_role'))
  for (const role of ['anon', 'authenticated']) assert.throws(() => sql(`SELECT count(*) FROM webinar_mailings;`, role))
  console.log('webinar-registration pgtest: all assertions passed')
}
