/**
 * Rename the Renewal 2026 templates to match the letters_meta.py scheme
 * (adds instructor names, switches "Subject Classes" -> "Special Subjects").
 * Run from api/: node scripts/rename-cfa-renewal-2026-templates.js
 */
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const CLIENT_ID = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';

const RENAMES = [
  ["Renewal 2026 — Director's Welcome (In-Person)",      "Renewal 2026 — Director Welcome (In-Person, Week 1)"],
  ["Renewal 2026 — Director's Welcome (Online)",         "Renewal 2026 — Director Welcome (Online, Week 2)"],
  ['Renewal 2026 — Grade 1 (In-Person)',                  'Renewal 2026 — Grade 1 In-Person (Sarah Galligan)'],
  ['Renewal 2026 — Grade 1 (Online)',                     'Renewal 2026 — Grade 1 Online (Lori Kran)'],
  ['Renewal 2026 — Grade 2 (In-Person)',                  'Renewal 2026 — Grade 2 In-Person (Jennifer Persinotti)'],
  ['Renewal 2026 — Grade 2 (Online)',                     'Renewal 2026 — Grade 2 Online (Jennifer Persinotti)'],
  ['Renewal 2026 — Grade 3 (In-Person)',                  'Renewal 2026 — Grade 3 In-Person (Kris Ritz)'],
  ['Renewal 2026 — Grade 3 (Online)',                     'Renewal 2026 — Grade 3 Online (Kris Ritz)'],
  ['Renewal 2026 — Grade 4 (In-Person)',                  'Renewal 2026 — Grade 4 In-Person (Irene Richardson)'],
  ['Renewal 2026 — Grade 4 (Online)',                     'Renewal 2026 — Grade 4 Online (Irene Richardson)'],
  ['Renewal 2026 — Grade 5 (In-Person)',                  'Renewal 2026 — Grade 5 In-Person (Jen Kershaw)'],
  ['Renewal 2026 — Grade 5 (Online)',                     'Renewal 2026 — Grade 5 Online (Jen Kershaw)'],
  ['Renewal 2026 — Grade 6 (In-Person)',                  'Renewal 2026 — Grade 6 In-Person (Julia Pellegrino)'],
  ['Renewal 2026 — Grade 6 (Online)',                     'Renewal 2026 — Grade 6 Online (Sarah Nelson)'],
  ['Renewal 2026 — Grade 7 (In-Person)',                  'Renewal 2026 — Grade 7 In-Person (Sarah Azzinaro)'],
  ['Renewal 2026 — Grade 7 (Online)',                     'Renewal 2026 — Grade 7 Online (Sarah Azzinaro)'],
  ['Renewal 2026 — Grade 8 (In-Person)',                  'Renewal 2026 — Grade 8 In-Person (Sonya Schewe)'],
  ['Renewal 2026 — Grade 8 (Online)',                     'Renewal 2026 — Grade 8 Online (Sonya Schewe)'],
  ['Renewal 2026 — Movement Education (In-Person)',       'Renewal 2026 — Movement Education In-Person (Jan Lyndes)'],
  ['Renewal 2026 — Subject Classes (In-Person)',          'Renewal 2026 — Special Subjects In-Person (Jason Child)'],
];

async function main() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const renamed = [];
  const missing = [];
  const alreadyDone = [];

  for (const [oldName, newName] of RENAMES) {
    const lookup = await sb
      .from('templates')
      .select('id, name')
      .eq('client_id', CLIENT_ID)
      .eq('name', oldName)
      .maybeSingle();
    if (lookup.error) throw lookup.error;

    if (!lookup.data) {
      // Maybe already renamed?
      const already = await sb
        .from('templates')
        .select('id')
        .eq('client_id', CLIENT_ID)
        .eq('name', newName)
        .maybeSingle();
      if (already.data) {
        alreadyDone.push(newName);
        console.log(`Already renamed: ${newName}`);
      } else {
        missing.push(oldName);
        console.warn(`Not found: ${oldName}`);
      }
      continue;
    }

    const upd = await sb
      .from('templates')
      .update({ name: newName })
      .eq('id', lookup.data.id)
      .select('id, name')
      .single();
    if (upd.error) throw upd.error;
    renamed.push(upd.data);
    console.log(`Renamed: ${oldName}\n     ->  ${upd.data.name}`);
  }

  console.log('\n--- Summary ---');
  console.log(`Renamed:        ${renamed.length}`);
  console.log(`Already renamed: ${alreadyDone.length}`);
  console.log(`Missing:        ${missing.length}`);
  for (const m of missing) console.log(`  - ${m}`);
}

main().catch((err) => {
  console.error('Rename failed:', err);
  process.exit(1);
});
