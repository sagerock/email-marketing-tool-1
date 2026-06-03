/**
 * One-off importer for Center for Anthroposophy Renewal 2026 welcome-letter templates.
 * Run from api/ directory: node scripts/import-cfa-renewal-2026-templates.js
 */
require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLIENT_ID = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
const FOLDER_NAME = 'Renewal 2026';
const SOURCE_DIR = '/home/sage/scripts/sagerock/clients/center-for-anthroposophy/renewal_2026/output';

const TEMPLATES = [
  { file: 'director-inperson.html',       name: "Renewal 2026 — Director's Welcome (In-Person)", subject: 'Welcome to Renewal Courses 2026 — In-Person Week' },
  { file: 'director-online.html',         name: "Renewal 2026 — Director's Welcome (Online)",    subject: 'Welcome to Renewal Courses 2026 — Online' },
  { file: 'grade-1-inperson.html',        name: 'Renewal 2026 — Grade 1 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 1 (In-Person)' },
  { file: 'grade-1-online.html',          name: 'Renewal 2026 — Grade 1 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 1 (Online)' },
  { file: 'grade-2-inperson.html',        name: 'Renewal 2026 — Grade 2 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 2 (In-Person)' },
  { file: 'grade-2-online.html',          name: 'Renewal 2026 — Grade 2 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 2 (Online)' },
  { file: 'grade-3-inperson.html',        name: 'Renewal 2026 — Grade 3 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 3 (In-Person)' },
  { file: 'grade-3-online.html',          name: 'Renewal 2026 — Grade 3 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 3 (Online)' },
  { file: 'grade-4-inperson.html',        name: 'Renewal 2026 — Grade 4 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 4 (In-Person)' },
  { file: 'grade-4-online.html',          name: 'Renewal 2026 — Grade 4 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 4 (Online)' },
  { file: 'grade-5-inperson.html',        name: 'Renewal 2026 — Grade 5 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 5 (In-Person)' },
  { file: 'grade-5-online.html',          name: 'Renewal 2026 — Grade 5 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 5 (Online)' },
  { file: 'grade-6-inperson.html',        name: 'Renewal 2026 — Grade 6 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 6 (In-Person)' },
  { file: 'grade-6-online.html',          name: 'Renewal 2026 — Grade 6 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 6 (Online)' },
  { file: 'grade-7-inperson.html',        name: 'Renewal 2026 — Grade 7 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 7 (In-Person)' },
  { file: 'grade-7-online.html',          name: 'Renewal 2026 — Grade 7 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 7 (Online)' },
  { file: 'grade-8-inperson.html',        name: 'Renewal 2026 — Grade 8 (In-Person)',            subject: 'Welcome to your Renewal 2026 course — Grade 8 (In-Person)' },
  { file: 'grade-8-online.html',          name: 'Renewal 2026 — Grade 8 (Online)',               subject: 'Welcome to your Renewal 2026 course — Grade 8 (Online)' },
  { file: 'movement-inperson.html',       name: 'Renewal 2026 — Movement Education (In-Person)', subject: 'Welcome to your Renewal 2026 course — Movement Education' },
  { file: 'subject-classes-inperson.html', name: 'Renewal 2026 — Subject Classes (In-Person)',   subject: 'Welcome to your Renewal 2026 course — Subject Classes' },
];

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing SUPABASE env vars');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Ensure folder exists (idempotent via unique(name, client_id))
  let folderId;
  const existing = await sb
    .from('template_folders')
    .select('id')
    .eq('client_id', CLIENT_ID)
    .eq('name', FOLDER_NAME)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    folderId = existing.data.id;
    console.log(`Folder "${FOLDER_NAME}" already exists: ${folderId}`);
  } else {
    const created = await sb
      .from('template_folders')
      .insert({ name: FOLDER_NAME, client_id: CLIENT_ID })
      .select('id')
      .single();
    if (created.error) throw created.error;
    folderId = created.data.id;
    console.log(`Created folder "${FOLDER_NAME}": ${folderId}`);
  }

  // Insert templates (skip any that already exist by exact name in this folder)
  const inserted = [];
  const skipped = [];

  for (const t of TEMPLATES) {
    const filePath = path.join(SOURCE_DIR, t.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`Missing source file: ${filePath}`);
      skipped.push({ ...t, reason: 'source file missing' });
      continue;
    }
    const html = fs.readFileSync(filePath, 'utf8');

    const dupe = await sb
      .from('templates')
      .select('id')
      .eq('client_id', CLIENT_ID)
      .eq('name', t.name)
      .maybeSingle();
    if (dupe.error) throw dupe.error;
    if (dupe.data) {
      skipped.push({ ...t, reason: `already exists (${dupe.data.id})` });
      continue;
    }

    const row = {
      client_id: CLIENT_ID,
      folder_id: folderId,
      name: t.name,
      subject: t.subject,
      html_content: html,
    };
    const res = await sb.from('templates').insert(row).select('id, name').single();
    if (res.error) throw res.error;
    inserted.push(res.data);
    console.log(`Inserted: ${res.data.name} (${res.data.id})`);
  }

  console.log('\n--- Summary ---');
  console.log(`Inserted: ${inserted.length}`);
  console.log(`Skipped:  ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.name}: ${s.reason}`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
