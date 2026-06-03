/**
 * Render the Renewal 2026 output HTML emails to review PDFs with sample
 * merge values filled in (so they read like finished emails, not raw templates).
 *
 * Each email is rendered on a SINGLE continuous page sized to its content height,
 * so the PDF reads like the real email (no page-break gaps — the body sits in one
 * table cell that print pagination would otherwise bump wholesale to the next page).
 *
 * Run from api/: node scripts/render-cfa-review-pdfs.js
 * Output: renewal_2026/review_pdfs/*.pdf
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = '/home/sage/scripts/sagerock/clients/center-for-anthroposophy/renewal_2026';
const SRC_DIR = path.join(BASE, 'output');
const OUT_DIR = path.join(BASE, 'review_pdfs');

// Sample values for review rendering only — the stored templates keep the real {{tags}}.
const SAMPLE = {
  '{{first_name}}': 'Elsy',
  '{{last_name}}': 'Maldonado',
  '{{email}}': 'elsy@centerforanthroposophy.org',
  '{{mailing_address}}': 'PO Box 15<br>McMinnville, TN 37111',
  '{{unsubscribe_url}}': '#sample-unsubscribe-link',
  '{{industry_link}}': '#sample-link',
};

function fillMergeTags(html) {
  let out = html;
  for (const [tag, val] of Object.entries(SAMPLE)) {
    out = out.split(tag).join(val);
  }
  return out;
}

// Map output filename -> human label for the PDF filename
const LABELS = {
  'director-inperson.html': '00 - Director Welcome (In-Person, Week 1)',
  'director-online.html': '01 - Director Welcome (Online, Week 2)',
  'grade-1-inperson.html': '02 - Grade 1 In-Person (Sarah Galligan)',
  'grade-1-online.html': '03 - Grade 1 Online (Lori Kran)',
  'grade-2-inperson.html': '04 - Grade 2 In-Person (Jennifer Persinotti)',
  'grade-2-online.html': '05 - Grade 2 Online (Jennifer Persinotti)',
  'grade-3-inperson.html': '06 - Grade 3 In-Person (Kris Ritz)',
  'grade-3-online.html': '07 - Grade 3 Online (Kris Ritz)',
  'grade-4-inperson.html': '08 - Grade 4 In-Person (Irene Richardson)',
  'grade-4-online.html': '09 - Grade 4 Online (Irene Richardson)',
  'grade-5-inperson.html': '10 - Grade 5 In-Person (Jen Kershaw)',
  'grade-5-online.html': '11 - Grade 5 Online (Jen Kershaw)',
  'grade-6-inperson.html': '12 - Grade 6 In-Person (Julia Pellegrino)',
  'grade-6-online.html': '13 - Grade 6 Online (Sarah Nelson)',
  'grade-7-inperson.html': '14 - Grade 7 In-Person (Sarah Azzinaro)',
  'grade-7-online.html': '15 - Grade 7 Online (Sarah Azzinaro)',
  'grade-8-inperson.html': '16 - Grade 8 In-Person (Sonya Schewe)',
  'grade-8-online.html': '17 - Grade 8 Online (Sonya Schewe)',
  'movement-inperson.html': '18 - Movement Education In-Person (Jan Lyndes)',
  'subject-classes-inperson.html': '19 - Special Subjects In-Person (Jason Child)',
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const done = [];
  try {
    for (const [file, label] of Object.entries(LABELS)) {
      const srcPath = path.join(SRC_DIR, file);
      if (!fs.existsSync(srcPath)) {
        console.warn(`Missing: ${srcPath}`);
        continue;
      }
      const html = fillMergeTags(fs.readFileSync(srcPath, 'utf8'));

      const page = await browser.newPage();
      // Letter-width viewport so the 560px email table centers as it would on screen.
      await page.setViewport({ width: 816, height: 1056 });
      await page.setContent(html, { waitUntil: 'networkidle0' });

      // Measure full content height so the PDF is one continuous page (no break gaps).
      const contentHeight = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );

      const pdfPath = path.join(OUT_DIR, `Renewal 2026 — ${label}.pdf`);
      await page.pdf({
        path: pdfPath,
        printBackground: true,
        width: '816px',
        height: `${contentHeight + 24}px`, // small bottom buffer
        pageRanges: '1',
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await page.close();

      done.push(path.basename(pdfPath));
      console.log(`Rendered: ${path.basename(pdfPath)}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${done.length} PDFs in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
