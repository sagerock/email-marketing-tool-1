/**
 * Refresh the html_content of the 20 Renewal 2026 live templates from the freshly
 * built output/ HTML (e.g. after a signature / body edit). The import script only
 * INSERTS (skips existing), so this is the tool for pushing edits to templates that
 * already exist. Matches by template name (the letters_meta.py scheme) and updates
 * html_content only — name and subject are left untouched.
 *
 * Run from api/: node scripts/update-cfa-renewal-2026-templates.js
 * Idempotent: re-running just re-sets the same content.
 */
require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CLIENT_ID = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
const OUTPUT_DIR = '/home/sage/scripts/sagerock/clients/center-for-anthroposophy/renewal_2026/output';

// template name (live, letters_meta.py scheme) -> output HTML filename
const MAP = [
  ['Renewal 2026 — Director Welcome (In-Person, Week 1)', 'director-inperson.html'],
  ['Renewal 2026 — Director Welcome (Online, Week 2)', 'director-online.html'],
  ['Renewal 2026 — Grade 1 Online (Lori Kran)', 'grade-1-online.html'],
  ['Renewal 2026 — Grade 2 Online (Jennifer Persinotti)', 'grade-2-online.html'],
  ['Renewal 2026 — Grade 3 Online (Kris Ritz)', 'grade-3-online.html'],
  ['Renewal 2026 — Grade 4 Online (Irene Richardson)', 'grade-4-online.html'],
  ['Renewal 2026 — Grade 5 Online (Jen Kershaw)', 'grade-5-online.html'],
  ['Renewal 2026 — Grade 6 Online (Sarah Nelson)', 'grade-6-online.html'],
  ['Renewal 2026 — Grade 7 Online (Sarah Azzinaro)', 'grade-7-online.html'],
  ['Renewal 2026 — Grade 8 Online (Sonya Schewe)', 'grade-8-online.html'],
  ['Renewal 2026 — Grade 1 In-Person (Sarah Galligan)', 'grade-1-inperson.html'],
  ['Renewal 2026 — Grade 2 In-Person (Jennifer Persinotti)', 'grade-2-inperson.html'],
  ['Renewal 2026 — Grade 3 In-Person (Kris Ritz)', 'grade-3-inperson.html'],
  ['Renewal 2026 — Grade 4 In-Person (Irene Richardson)', 'grade-4-inperson.html'],
  ['Renewal 2026 — Grade 5 In-Person (Jen Kershaw)', 'grade-5-inperson.html'],
  ['Renewal 2026 — Grade 6 In-Person (Julia Pellegrino)', 'grade-6-inperson.html'],
  ['Renewal 2026 — Grade 7 In-Person (Sarah Azzinaro)', 'grade-7-inperson.html'],
  ['Renewal 2026 — Grade 8 In-Person (Sonya Schewe)', 'grade-8-inperson.html'],
  ['Renewal 2026 — Movement Education In-Person (Jan Lyndes)', 'movement-inperson.html'],
  ['Renewal 2026 — Special Subjects In-Person (Jason Child)', 'subject-classes-inperson.html'],
];

async function main() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const updated = [];
  const unchanged = [];
  const missing = [];

  for (const [name, file] of MAP) {
    const filePath = path.join(OUTPUT_DIR, file);
    if (!fs.existsSync(filePath)) {
      missing.push(`${name} (source ${file} missing)`);
      console.warn(`Source missing: ${file}`);
      continue;
    }
    const html = fs.readFileSync(filePath, 'utf8');

    const lookup = await sb
      .from('templates')
      .select('id, html_content')
      .eq('client_id', CLIENT_ID)
      .eq('name', name)
      .maybeSingle();
    if (lookup.error) throw lookup.error;
    if (!lookup.data) {
      missing.push(`${name} (no live template)`);
      console.warn(`Template not found: ${name}`);
      continue;
    }
    if (lookup.data.html_content === html) {
      unchanged.push(name);
      console.log(`Unchanged: ${name}`);
      continue;
    }

    const upd = await sb
      .from('templates')
      .update({ html_content: html })
      .eq('id', lookup.data.id);
    if (upd.error) throw upd.error;
    updated.push(name);
    console.log(`Updated: ${name}`);
  }

  console.log('\n--- Summary ---');
  console.log(`Updated:   ${updated.length}`);
  console.log(`Unchanged: ${unchanged.length}`);
  console.log(`Missing:   ${missing.length}`);
  for (const m of missing) console.log(`  - ${m}`);
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
