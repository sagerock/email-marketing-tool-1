/**
 * Send a "[TEST]" copy of an Alconox campaign to a small internal recipient list.
 *
 * Modeled directly on send-cfa-renewal-2026-samples.js: mirrors what the mail
 * tool's "Send test" feature does (fetch the live template HTML, fill merge
 * tags, append the campaign's UTM params, send via the client's SendGrid key),
 * with one tweak — {{first_name}} is personalized per recipient instead of the
 * UI's hardcoded "John", so reviewers see a realistic greeting.
 *
 * Does NOT touch the campaign row, its status, sent_count, or the real audience.
 * The DB reads are read-only; the only side effect is the test emails below.
 *
 * Run from api/:
 *   NODE_PATH=/home/sage/scripts/email-marketing-tool-1/api/node_modules \
 *     node scripts/send-alconox-postshow-test.js
 * Dry run (print plan, send nothing):
 *   DRY_RUN=1 NODE_PATH=... node scripts/send-alconox-postshow-test.js
 *
 * Override the campaign with CAMPAIGN_ID=<uuid>.
 */
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const { decrypt } = require('../crypto-utils');

const CLIENT_ID = 'ea7f1422-2d20-4299-85a7-c1201e953409'; // Alconox
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || 'a872f5ff-a67d-4f85-902d-ff0b78f41cd3';
const DRY_RUN = !!process.env.DRY_RUN;

const DEFAULT_RECIPIENTS = [
  { email: 'slewis@alconox.com', first_name: 'Sage' },
  { email: 'ssilverstein@alconox.com', first_name: 'Stacy' },
  { email: 'mmodica@alconox.com', first_name: 'Michelle' },
  { email: 'mmoussourakis@alconox.com', first_name: 'Michael' },
];
// TEST_TO overrides the reviewer list: "email" or "email:FirstName", comma-separated.
// Handy for a solo look before circulating to the whole approval group.
const RECIPIENTS = process.env.TEST_TO
  ? process.env.TEST_TO.split(',').map((raw) => {
      const [email, first_name] = raw.trim().split(':');
      return { email: email.trim(), first_name: (first_name || email.split('@')[0]).trim() };
    })
  : DEFAULT_RECIPIENTS;

const TEST_UNSUB = 'https://mail.sagerock.com/unsubscribe?token=TEST_TOKEN';

// Mirror server.js appendUtmParams(): skip unsubscribe links.
const appendUtmParams = (html, params) => {
  if (!params) return html;
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
    if (url.includes('unsubscribe')) return match;
    const separator = url.includes('?') ? '&' : '?';
    return `href="${url}${separator}${params}"`;
  });
};

async function main() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

  const { data: campaign, error: campErr } = await supabase
    .from('campaigns').select('*').eq('id', CAMPAIGN_ID).single();
  if (campErr) throw campErr;
  if (campaign.client_id !== CLIENT_ID) {
    throw new Error(`Campaign ${CAMPAIGN_ID} does not belong to the Alconox client`);
  }

  const { data: tpl, error: tErr } = await supabase
    .from('templates').select('html_content, name').eq('id', campaign.template_id).single();
  if (tErr || !tpl) throw new Error(`Template not found: ${tErr?.message || campaign.template_id}`);

  const { data: client, error: cErr } = await supabase
    .from('clients').select('*').eq('id', CLIENT_ID).single();
  if (cErr) throw cErr;

  // Mirror server.js decryptClient(): try to decrypt, fall back to the raw value.
  let sendgridKey = client.sendgrid_api_key || null;
  if (sendgridKey && ENCRYPTION_KEY) {
    try { sendgridKey = decrypt(sendgridKey, ENCRYPTION_KEY); } catch (_) { /* already plaintext */ }
  }
  if (!sendgridKey) throw new Error('Client has no SendGrid API key');
  const mailingAddress = client.mailing_address || '';
  const ipPool = client.ip_pool || undefined;
  sgMail.setApiKey(sendgridKey);

  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}Campaign: ${campaign.name} [${campaign.status}]`);
  console.log(`Template: ${tpl.name} (${(tpl.html_content || '').length} chars)`);
  console.log(`From: ${campaign.from_name} <${campaign.from_email}> | reply-to: ${campaign.reply_to}`);
  console.log(`Subject: [TEST] ${campaign.subject}`);
  console.log(`Recipients: ${RECIPIENTS.length}${ipPool ? ` | IP pool: ${ipPool}` : ''}\n`);

  if (campaign.status !== 'draft') {
    console.warn(`WARNING: campaign status is "${campaign.status}", not "draft".\n`);
  }

  let sent = 0, failed = 0;
  for (const r of RECIPIENTS) {
    let html = (tpl.html_content || '')
      .replace(/{{\s*email\s*}}/gi, r.email)
      .replace(/{{\s*first_name\s*}}/gi, r.first_name)
      .replace(/{{\s*last_name\s*}}/gi, '')
      .replace(/{{\s*mailing_address\s*}}/gi, mailingAddress)
      .replace(/{{\s*campaign_name\s*}}/gi, campaign.name || '')
      .replace(/{{\s*unsubscribe_url\s*}}/gi, TEST_UNSUB);
    html = appendUtmParams(html, campaign.utm_params || '');

    const msg = {
      to: r.email,
      from: { email: campaign.from_email, name: campaign.from_name },
      replyTo: campaign.reply_to || undefined,
      subject: `[TEST] ${campaign.subject}`,
      html,
      ipPoolName: ipPool,
      // internal tests to known addresses — deliver even if suppressed
      mailSettings: { bypassListManagement: { enable: true } },
      headers: { 'List-Unsubscribe': `<${TEST_UNSUB}>` },
    };

    if (DRY_RUN) {
      console.log(`DRY  -> ${r.email.padEnd(30)} Hi ${r.first_name},   ${msg.subject}`);
      continue;
    }
    try {
      await sgMail.send(msg);
      sent++;
      console.log(`sent -> ${r.email.padEnd(30)} Hi ${r.first_name},`);
      await new Promise((res) => setTimeout(res, 150));
    } catch (e) {
      failed++;
      const detail = e?.response?.body ? JSON.stringify(e.response.body.errors || e.response.body) : e.message;
      console.error(`FAIL -> ${r.email}: ${detail}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(DRY_RUN ? '(dry run — nothing sent)' : `Sent: ${sent} | Failed: ${failed}`);
}

main().catch((e) => { console.error('Run failed:', e); process.exit(1); });
