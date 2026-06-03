/**
 * Build the 20 Renewal 2026 welcome-letter sequences (DRAFT status).
 * Each: trigger_type=tag_added, trigger_config={tag: <audience_tag>}, one step
 * (delay 0) referencing the template by id (html_content left null => live fetch
 * at send time, so copy edits flow through automatically).
 *
 * Idempotent: skips any sequence whose name already exists for this client.
 * Run from api/: node scripts/build-cfa-renewal-2026-sequences.js
 */
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const CLIENT_ID = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
const FROM_EMAIL = 'karen@centerforanthroposophy.org';
const FROM_NAME = 'Karen Atkinson';
const REPLY_TO = 'karen@centerforanthroposophy.org';

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

async function main() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Pull all CfA templates once, index by name.
  const { data: templates, error: tErr } = await sb
    .from('templates')
    .select('id, name, subject')
    .eq('client_id', CLIENT_ID);
  if (tErr) throw tErr;
  const byName = new Map(templates.map((t) => [t.name, t]));

  const created = [];
  const skipped = [];
  const missing = [];

  for (const [templateName, tag] of MAP) {
    const tpl = byName.get(templateName);
    if (!tpl) {
      missing.push(templateName);
      console.warn(`Template not found: ${templateName}`);
      continue;
    }

    // Skip if a sequence with this name already exists
    const existing = await sb
      .from('email_sequences')
      .select('id')
      .eq('client_id', CLIENT_ID)
      .eq('name', templateName)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      skipped.push({ name: templateName, reason: `exists (${existing.data.id})` });
      console.log(`Skip (exists): ${templateName}`);
      continue;
    }

    // Create sequence (draft)
    const seqRes = await sb
      .from('email_sequences')
      .insert({
        name: templateName,
        description: `Renewal 2026 welcome letter. Auto-enrolls contacts tagged "${tag}".`,
        status: 'draft',
        trigger_type: 'tag_added',
        trigger_config: { tag },
        from_email: FROM_EMAIL,
        from_name: FROM_NAME,
        reply_to: REPLY_TO,
        client_id: CLIENT_ID,
      })
      .select('id')
      .single();
    if (seqRes.error) throw seqRes.error;
    const sequenceId = seqRes.data.id;

    // Create single step (delay 0, live template reference)
    const stepRes = await sb
      .from('sequence_steps')
      .insert({
        sequence_id: sequenceId,
        step_order: 1,
        subject: tpl.subject,
        template_id: tpl.id,
        html_content: null, // null => send path fetches template live by id
        delay_days: 0,
        delay_hours: 0,
      })
      .select('id')
      .single();
    if (stepRes.error) throw stepRes.error;

    created.push({ name: templateName, tag, sequenceId });
    console.log(`Created: ${templateName}  [tag: ${tag}]`);
  }

  console.log('\n--- Summary ---');
  console.log(`Created: ${created.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Missing templates: ${missing.length}`);
  for (const m of missing) console.log(`  - ${m}`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
