/**
 * Rebuild the Alconox "white paper / book download follow-up" segment as CODE.
 *
 * WHY THIS EXISTS
 * The 2026-07-23 send ("WP/Book Download Follow-up (6mo)") went to 64 people via the
 * tag `WP-Book Downloaders 6mo`. Nothing in the repo built that tag, and it does not
 * reproduce from any rule: 86 contacts matching the obvious criteria were never
 * tagged, and 8 tagged contacts don't match at all. It was assembled by hand in the
 * UI, so the definition existed only in that session and the send can't be repeated,
 * explained, or audited. Meanwhile the comparable safe audience is ~520 — 8x larger.
 *
 * So the segment is defined here instead. Re-running reproduces it exactly.
 *
 * THE SEGMENT
 *   source: source_code is 'White Papers'/'Book Request', OR the contact carries any
 *           of the Salesforce source-code tags for those (:LSC = lead, :CSC = contact).
 *   never send: unsubscribed, previously bounced, or no email address.
 *   recency:  by last_activity_at.
 *
 * WHY last_activity_at AND NOT created_at — this one matters. Nearly every Alconox
 * contact shows created_at = 2025-12-04, the date of the bulk CRM import. Segmenting
 * on "date added" in the UI therefore means "when we imported the database", not when
 * anyone downloaded anything. It looks like a recency filter and is not one.
 *
 * TIERS (measured 2026-07-28; 'engaged' = has any open/click in analytics_events)
 *   A  active <6mo    520 people   86% engaged   <- default; the whole point
 *   B  6-12mo         206 people   11% engaged
 *   C  12-24mo        112 people    0% engaged
 *   D  >24mo/never    567 people    0% engaged
 *
 * Tiers C and D are 679 people with not one recorded open or click between them.
 * They are deliberately unreachable from this script. Of the ~3,300 WP/Book contacts
 * overall, 1,058 have already hard-bounced (32%) and 852 unsubscribed — mailing dead
 * addresses is how the sending domain gets damaged for the campaigns that do work.
 * A win-back to C/D is a separate, deliberate, small, monitored send. Not this.
 *
 * USAGE (from api/):
 *   DRY_RUN=1 NODE_PATH=/home/sage/scripts/email-marketing-tool-1/api/node_modules \
 *     node scripts/tag-alconox-wp-book-segment.js
 *   ... then drop DRY_RUN to apply.
 *
 *   --tier=A|AB   A = active <6mo (default). AB = <12mo, accepts ~206 cold addresses.
 *   --tag=<name>  tag to maintain (default: the existing 'WP-Book Downloaders 6mo').
 *   --prune       ALSO remove the tag from contacts that no longer qualify. Off by
 *                 default so a first run is purely additive and can't silently shrink
 *                 an audience someone is about to send to.
 */
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const CLIENT_ID = 'ea7f1422-2d20-4299-85a7-c1201e953409'; // Alconox
const DRY_RUN = !!process.env.DRY_RUN;

const flags = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const TIER = (flags.tier || 'A').toUpperCase();
const TAG = flags.tag || 'WP-Book Downloaders 6mo';
const PRUNE = !!flags.prune;

const SOURCE_CODES = ['White Papers', 'Book Request'];
const SOURCE_TAGS = [
  'White Papers:LSC', 'White Papers:CSC', 'White Papers',
  'Book Request:LSC', 'Book Request:CSC', 'Book Request',
];
const MONTHS = { A: 6, AB: 12 }[TIER];
if (!MONTHS) {
  console.error(`Unknown --tier=${TIER}. Use A (<6mo) or AB (<12mo).`);
  console.error('Tiers C/D (>12mo) are excluded on purpose — 0% engagement, high bounce risk.');
  process.exit(1);
}

const COLS = 'id,email,tags,source_code,last_activity_at,unsubscribed,bounced_at';

/** Page through a filtered select — supabase caps a single response at 1000 rows. */
async function fetchAll(build) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const cutoff = new Date(Date.now() - MONTHS * 30.44 * 86400e3).toISOString();

  // Two queries unioned by id rather than one .or() string: the tag values contain
  // spaces and colons, which the PostgREST or() grammar does not quote cleanly.
  const bySource = await fetchAll(() => supabase.from('contacts').select(COLS)
    .eq('client_id', CLIENT_ID).in('source_code', SOURCE_CODES));
  const byTag = await fetchAll(() => supabase.from('contacts').select(COLS)
    .eq('client_id', CLIENT_ID).overlaps('tags', SOURCE_TAGS));

  const universe = new Map();
  for (const c of [...bySource, ...byTag]) universe.set(c.id, c);

  const sendable = (c) =>
    c.unsubscribed !== true && !c.bounced_at && c.email && c.email.trim() !== '';
  const recent = (c) => c.last_activity_at && c.last_activity_at >= cutoff;

  const all = [...universe.values()];
  const qualify = all.filter((c) => sendable(c) && recent(c));
  const qualifyIds = new Set(qualify.map((c) => c.id));

  const currentlyTagged = all.filter((c) => (c.tags || []).includes(TAG));
  const toAdd = qualify.filter((c) => !(c.tags || []).includes(TAG));
  const toRemove = currentlyTagged.filter((c) => !qualifyIds.has(c.id));

  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}Alconox WP/Book segment · tier ${TIER} (<${MONTHS}mo) · tag "${TAG}"`);
  console.log(`  universe (WP/Book, any age) : ${all.length}`);
  console.log(`    minus unsub/bounce/no-email: ${all.filter(sendable).length}`);
  console.log(`    minus older than ${String(MONTHS).padStart(2)}mo      : ${qualify.length}  <- the segment`);
  console.log(`  currently carrying the tag  : ${currentlyTagged.length}`);
  console.log(`  to ADD                      : ${toAdd.length}`);
  console.log(`  to REMOVE                   : ${toRemove.length}${PRUNE ? '' : '  (skipped — pass --prune)'}\n`);

  if (DRY_RUN) {
    for (const c of toAdd.slice(0, 5)) console.log(`  + ${c.email}  (${c.source_code}, active ${String(c.last_activity_at).slice(0, 10)})`);
    if (toAdd.length > 5) console.log(`  … and ${toAdd.length - 5} more`);
    for (const c of toRemove.slice(0, 5)) console.log(`  - ${c.email}  (last active ${String(c.last_activity_at).slice(0, 10) || 'never'})`);
    console.log('\n(dry run — nothing written)');
    return;
  }

  let added = 0, removed = 0;
  for (const c of toAdd) {
    const tags = [...new Set([...(c.tags || []), TAG])];
    const { error } = await supabase.from('contacts').update({ tags }).eq('id', c.id);
    if (error) console.error(`  FAIL add ${c.email}: ${error.message}`); else added++;
  }
  if (PRUNE) {
    for (const c of toRemove) {
      const tags = (c.tags || []).filter((t) => t !== TAG);
      const { error } = await supabase.from('contacts').update({ tags }).eq('id', c.id);
      if (error) console.error(`  FAIL remove ${c.email}: ${error.message}`); else removed++;
    }
  }
  console.log(`--- Summary ---\nadded: ${added} | removed: ${removed} | segment size now: ${qualify.length}`);
}

main().catch((e) => { console.error('Run failed:', e); process.exit(1); });
