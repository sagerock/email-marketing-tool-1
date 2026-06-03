/**
 * Build the reminder campaigns (sends #2 and #3) for Renewal 2026, in DRAFT.
 *
 * Cadence (per Elsy, 2026-06-02 + 06-03):
 *   Send #2: June 15 reminder      -> ONLY people signed up by June 2 (cohort "jun2").
 *   Send #3: 48h-before "get ready" -> EVERYONE holding the course's audience tag.
 *            In-Person letters: June 26; Online letters: July 3.
 *   (Send #1, the immediate welcome, is a tag_added sequence built elsewhere.)
 *   All sends at 08:00 ET = 12:00 UTC (EDT in June/July).
 *
 * Why a separate cohort tag for June 15: the tool combines filter_tags with OR
 * (server.js: filter_tags.some(...)), so "has audience tag AND signed up by June 2"
 * cannot be expressed with two tags on one campaign. Instead the June 2 cohort is
 * given a per-course cohort tag (audienceTag + '-jun2'), and the June 15 campaign
 * filters on that single tag. People who register after June 2 only ever receive the
 * plain audience tag, so they get the welcome + the 48h reminder but skip June 15.
 *
 * Content is NOT baked in: campaigns carry template_id only (html fetched live at
 * send time), so later copy/link edits to the template flow through automatically.
 *
 * Campaigns are created status='draft' (cron only sends status='scheduled' with
 * scheduled_at<=now, so drafts are inert). At go-live, flip status draft->scheduled.
 *
 * Idempotent: deletes any existing Renewal 2026 reminder campaigns for this client,
 * then recreates them, so re-running always yields the current correct set.
 * Run from api/: node scripts/build-cfa-renewal-2026-reminder-campaigns.js
 */
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const CLIENT_ID = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
const FROM_EMAIL = 'karen@centerforanthroposophy.org';
const FROM_NAME = 'Karen Atkinson';
const REPLY_TO = 'karen@centerforanthroposophy.org';

const JUN15 = '2026-06-15T12:00:00Z';
const INPERSON_48 = '2026-06-26T12:00:00Z'; // 48h before In-Person week (Sun Jun 28)
const ONLINE_48 = '2026-07-03T12:00:00Z'; // Fri before Online week (Mon Jul 6); avoids Jul 4 holiday

// template_name -> audience_tag (from letters_meta.py)
const MAP = [
  ['Renewal 2026 — Director Welcome (In-Person, Week 1)', 'renewal-2026-inperson-all'],
  ['Renewal 2026 — Director Welcome (Online, Week 2)', 'renewal-2026-online-all'],
  ['Renewal 2026 — Grade 1 Online (Lori Kran)', 'renewal-2026-grade-1-online'],
  ['Renewal 2026 — Grade 2 Online (Jennifer Persinotti)', 'renewal-2026-grade-2-online'],
  ['Renewal 2026 — Grade 3 Online (Kris Ritz)', 'renewal-2026-grade-3-online'],
  ['Renewal 2026 — Grade 4 Online (Irene Richardson)', 'renewal-2026-grade-4-online'],
  ['Renewal 2026 — Grade 5 Online (Jen Kershaw)', 'renewal-2026-grade-5-online'],
  ['Renewal 2026 — Grade 6 Online (Sarah Nelson)', 'renewal-2026-grade-6-online'],
  ['Renewal 2026 — Grade 7 Online (Sarah Azzinaro)', 'renewal-2026-grade-7-online'],
  ['Renewal 2026 — Grade 8 Online (Sonya Schewe)', 'renewal-2026-grade-8-online'],
  ['Renewal 2026 — Grade 1 In-Person (Sarah Galligan)', 'renewal-2026-grade-1-inperson'],
  ['Renewal 2026 — Grade 2 In-Person (Jennifer Persinotti)', 'renewal-2026-grade-2-inperson'],
  ['Renewal 2026 — Grade 3 In-Person (Kris Ritz)', 'renewal-2026-grade-3-inperson'],
  ['Renewal 2026 — Grade 4 In-Person (Irene Richardson)', 'renewal-2026-grade-4-inperson'],
  ['Renewal 2026 — Grade 5 In-Person (Jen Kershaw)', 'renewal-2026-grade-5-inperson'],
  ['Renewal 2026 — Grade 6 In-Person (Julia Pellegrino)', 'renewal-2026-grade-6-inperson'],
  ['Renewal 2026 — Grade 7 In-Person (Sarah Azzinaro)', 'renewal-2026-grade-7-inperson'],
  ['Renewal 2026 — Grade 8 In-Person (Sonya Schewe)', 'renewal-2026-grade-8-inperson'],
  ['Renewal 2026 — Movement Education In-Person (Jan Lyndes)', 'renewal-2026-movement-inperson'],
  ['Renewal 2026 — Special Subjects In-Person (Jason Child)', 'renewal-2026-subject-classes-inperson'],
];

// Online if the audience tag references the online week; otherwise in-person.
const isOnline = (tag) => tag.includes('online');

// Derive a reminder subject from the welcome subject by swapping its opener, so the
// three sends differ enough that Gmail does not collapse them into one thread.
function reminderSubject(welcomeSubject, openerWhenYour, openerWhenBare) {
  if (/^Welcome to your /i.test(welcomeSubject)) {
    return welcomeSubject.replace(/^Welcome to your /i, openerWhenYour);
  }
  if (/^Welcome to /i.test(welcomeSubject)) {
    return welcomeSubject.replace(/^Welcome to /i, openerWhenBare);
  }
  return welcomeSubject;
}

async function main() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: templates, error: tErr } = await sb
    .from('templates')
    .select('id, name, subject')
    .eq('client_id', CLIENT_ID);
  if (tErr) throw tErr;
  const byName = new Map(templates.map((t) => [t.name, t]));

  // Wipe any existing Renewal 2026 reminder campaigns so this script is the single
  // source of truth (drafts only; safe to recreate).
  const { data: existing, error: exErr } = await sb
    .from('campaigns')
    .select('id, name, status')
    .eq('client_id', CLIENT_ID)
    .ilike('name', 'Renewal 2026%Reminder%');
  if (exErr) throw exErr;
  const live = existing.filter((c) => c.status !== 'draft');
  if (live.length) {
    throw new Error(
      `Refusing to delete ${live.length} non-draft reminder campaign(s): ` +
        live.map((c) => `${c.name} [${c.status}]`).join('; '),
    );
  }
  if (existing.length) {
    const { error: delErr } = await sb
      .from('campaigns')
      .delete()
      .in('id', existing.map((c) => c.id));
    if (delErr) throw delErr;
    console.log(`Deleted ${existing.length} existing draft reminder campaign(s).`);
  }

  const created = [];
  const missing = [];

  async function makeCampaign(name, tpl, filterTag, subject, scheduledAt) {
    const res = await sb
      .from('campaigns')
      .insert({
        name,
        template_id: tpl.id, // html fetched live at send time (content not baked in)
        subject,
        from_email: FROM_EMAIL,
        from_name: FROM_NAME,
        reply_to: REPLY_TO,
        status: 'draft', // inert until flipped to 'scheduled' at go-live
        scheduled_at: scheduledAt,
        filter_tags: [filterTag],
        client_id: CLIENT_ID,
      })
      .select('id')
      .single();
    if (res.error) throw res.error;
    created.push({ name, scheduledAt, filterTag });
    console.log(`Created: ${name}\n         tag=${filterTag}  sched=${scheduledAt}  subj="${subject}"`);
  }

  for (const [templateName, tag] of MAP) {
    const tpl = byName.get(templateName);
    if (!tpl) {
      missing.push(templateName);
      console.warn(`Template not found: ${templateName}`);
      continue;
    }
    const date48 = isOnline(tag) ? ONLINE_48 : INPERSON_48;
    const label48 = isOnline(tag) ? 'Jul 3' : 'Jun 26';

    // Send #2 — June 15, ONLY the by-June-2 cohort (per-course cohort tag).
    await makeCampaign(
      `${templateName} — Reminder Jun 15`,
      tpl,
      `${tag}-jun2`,
      reminderSubject(tpl.subject, 'Reminder: Your ', 'Reminder: '),
      JUN15,
    );

    // Send #3 — 48h before, EVERYONE on the audience tag.
    await makeCampaign(
      `${templateName} — Reminder 48h (${label48})`,
      tpl,
      tag,
      reminderSubject(tpl.subject, 'Get ready! 48 hours left: Your ', 'Get ready! 48 hours left: '),
      date48,
    );
  }

  console.log('\n--- Summary ---');
  console.log(`Created: ${created.length}`);
  console.log(`Missing templates: ${missing.length}`);
  for (const m of missing) console.log(`  - ${m}`);
  console.log('\nGo-live tagging reminder:');
  console.log('  • Everyone (cohort A + B): course audience tag  -> welcome + 48h reminder');
  console.log('  • Cohort A only (signed up by June 2): ALSO add "<audience-tag>-jun2"  -> June 15 reminder');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
