/**
 * Send a "[SAMPLE]" copy of each of the 18 Renewal 2026 COURSE letters to a small
 * internal recipient list (Karen / Elsy / Sage) for reference — the request from
 * Elsy: "Can Karen receive a sample email of each of the 18 courses?"
 *
 * Mirrors what the mail tool's "Send test" feature does (fetch the live template
 * HTML, fill merge tags, send via the client's SendGrid key), with two tweaks:
 *   - uses each course's WELCOME subject so the sample matches send #1 that
 *     participants/instructors actually receive (the test feature would have used
 *     a reminder campaign's subject), and
 *   - personalizes {{first_name}} per recipient and prefixes "[SAMPLE] ".
 *
 * Excludes the 2 Director welcomes (those aren't "courses"). Set INCLUDE_DIRECTORS=1
 * to also send the 2 Director letters (20 total).
 *
 * Does NOT touch participants, tags, sequences, or campaigns. The DB reads are
 * read-only; the only side effect is the sample emails to the listed recipients.
 *
 * Run from api/:  NODE_PATH=/home/sage/scripts/email-marketing-tool-1/api/node_modules node scripts/send-cfa-renewal-2026-samples.js
 * Dry run (print plan, send nothing):  DRY_RUN=1 NODE_PATH=... node scripts/send-cfa-renewal-2026-samples.js
 */
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const { decrypt } = require('../crypto-utils');

const CLIENT_ID = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
const DRY_RUN = !!process.env.DRY_RUN;
const INCLUDE_DIRECTORS = !!process.env.INCLUDE_DIRECTORS;

const FROM_EMAIL = 'karen@centerforanthroposophy.org';
const FROM_NAME = 'Karen Atkinson';

const RECIPIENTS = [
  { email: 'karen@centerforanthroposophy.org', first_name: 'Karen' },
  { email: 'elsy@centerforanthroposophy.org', first_name: 'Elsy' },
  { email: 'sage@sagerock.com', first_name: 'Sage' },
];

// [template_id, welcome subject] — pulled live from the welcome sequence_steps.
const DIRECTORS = [
  ['a3f32b5a-9e75-482e-8036-922b4ee5a701', 'Welcome to Renewal Courses 2026 — In-Person Week'],
  ['ec2c5810-e9ee-41bb-a29a-016f90962fd6', 'Welcome to Renewal Courses 2026 — Online'],
];

const COURSES = [
  ['7c3b8f6b-a7b4-4404-824b-0be375590262', 'Welcome to your Renewal 2026 course — Grade 1 (In-Person)'],
  ['9f31cf10-915e-4cfd-abe4-7d573b1845c7', 'Welcome to your Renewal 2026 course — Grade 1 (Online)'],
  ['aa5f6ffd-9dce-4502-bd88-0c50ff9ef9d8', 'Welcome to your Renewal 2026 course — Grade 2 (In-Person)'],
  ['7f309c34-380b-4d3d-9bda-2cd07be73d72', 'Welcome to your Renewal 2026 course — Grade 2 (Online)'],
  ['8b29440d-b646-4fde-8a0b-9ffbac9b05b0', 'Welcome to your Renewal 2026 course — Grade 3 (In-Person)'],
  ['ade96c20-b11d-4073-a52a-e930872c6d10', 'Welcome to your Renewal 2026 course — Grade 3 (Online)'],
  ['29a9934b-d2fe-4996-80fb-23191db4dbcd', 'Welcome to your Renewal 2026 course — Grade 4 (In-Person)'],
  ['b10c4c51-cfbb-4f6f-b955-55b9042a9dc1', 'Welcome to your Renewal 2026 course — Grade 4 (Online)'],
  ['3b96dbd2-48cf-4c50-8df1-411f4b193175', 'Welcome to your Renewal 2026 course — Grade 5 (In-Person)'],
  ['4fa308df-ef4c-4903-a348-5809046845f5', 'Welcome to your Renewal 2026 course — Grade 5 (Online)'],
  ['0752268f-e41e-48e0-986c-48ba3f25d79b', 'Welcome to your Renewal 2026 course — Grade 6 (In-Person)'],
  ['7d56cb83-52c3-43b5-ae8b-75b061c49189', 'Welcome to your Renewal 2026 course — Grade 6 (Online)'],
  ['54148d39-56fb-4575-82f0-e14e8090bd60', 'Welcome to your Renewal 2026 course — Grade 7 (In-Person)'],
  ['1cab8aa9-c473-47e0-a7aa-126586243f71', 'Welcome to your Renewal 2026 course — Grade 7 (Online)'],
  ['44f1ac03-e521-4cec-b766-bb6c8fb5a788', 'Welcome to your Renewal 2026 course — Grade 8 (In-Person)'],
  ['8ccc421a-0c32-4f38-9762-32f5130a7df5', 'Welcome to your Renewal 2026 course — Grade 8 (Online)'],
  ['0458079f-be61-4d32-9739-5e2e6e03e9ba', 'Welcome to your Renewal 2026 course — Movement Education'],
  ['382a51f9-8753-4137-a933-7c1c7936b905', 'Welcome to your Renewal 2026 course — Subject Classes'],
];

const TEST_UNSUB = 'https://mail.sagerock.com/unsubscribe?token=SAMPLE_TOKEN';

async function main() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

  const { data: client, error: cErr } = await supabase
    .from('clients').select('*').eq('id', CLIENT_ID).single();
  if (cErr) throw cErr;

  // Mirror server.js decryptClient(): try to decrypt, fall back to the raw value
  // (some clients store the SendGrid key in plaintext, e.g. "SG....").
  let sendgridKey = client.sendgrid_api_key || null;
  if (sendgridKey && ENCRYPTION_KEY) {
    try { sendgridKey = decrypt(sendgridKey, ENCRYPTION_KEY); } catch (_) { /* already plaintext */ }
  }
  if (!sendgridKey) throw new Error('Client has no SendGrid API key');
  const mailingAddress = client.mailing_address || '';
  const ipPool = client.ip_pool || undefined;
  sgMail.setApiKey(sendgridKey);

  const list = INCLUDE_DIRECTORS ? [...DIRECTORS, ...COURSES] : COURSES;
  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}Sending ${list.length} course samples x ${RECIPIENTS.length} recipients = ${list.length * RECIPIENTS.length} emails`);
  console.log(`From: ${FROM_NAME} <${FROM_EMAIL}>${ipPool ? ` | IP pool: ${ipPool}` : ''}\n`);

  let sent = 0, failed = 0;
  for (const [templateId, subject] of list) {
    const { data: tpl, error: tErr } = await supabase
      .from('templates').select('html_content, name').eq('id', templateId).single();
    if (tErr || !tpl) { console.error(`SKIP template ${templateId}: ${tErr?.message || 'not found'}`); failed += RECIPIENTS.length; continue; }
    const baseHtml = tpl.html_content || '';

    for (const r of RECIPIENTS) {
      const html = baseHtml
        .replace(/{{\s*first_name\s*}}/gi, r.first_name)
        .replace(/{{\s*last_name\s*}}/gi, '')
        .replace(/{{\s*mailing_address\s*}}/gi, mailingAddress)
        .replace(/{{\s*unsubscribe_url\s*}}/gi, TEST_UNSUB);

      const msg = {
        to: r.email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: FROM_EMAIL,
        subject: `[SAMPLE] ${subject}`,
        html,
        ipPoolName: ipPool,
        // internal samples to known addresses — deliver even if suppressed
        mailSettings: { bypassListManagement: { enable: true } },
        headers: { 'List-Unsubscribe': `<${TEST_UNSUB}>` },
      };

      if (DRY_RUN) {
        console.log(`DRY  -> ${r.email.padEnd(34)} ${msg.subject}   [${tpl.name}]`);
        continue;
      }
      try {
        await sgMail.send(msg);
        sent++;
        console.log(`sent -> ${r.email.padEnd(34)} ${msg.subject}`);
        await new Promise((res) => setTimeout(res, 150));
      } catch (e) {
        failed++;
        const detail = e?.response?.body ? JSON.stringify(e.response.body.errors || e.response.body) : e.message;
        console.error(`FAIL -> ${r.email} ${msg.subject}: ${detail}`);
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(DRY_RUN ? '(dry run — nothing sent)' : `Sent: ${sent} | Failed: ${failed}`);
}

main().catch((e) => { console.error('Run failed:', e); process.exit(1); });
