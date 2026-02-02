/**
 * Script to deduplicate analytics_events table
 *
 * This removes duplicate events keeping only the first occurrence per:
 * - delivered/bounce/spam/unsubscribe/block: one per (campaign_id, email, event_type)
 * - open: one per (campaign_id, email)
 * - click: one per (campaign_id, email, url)
 *
 * Usage:
 *   node deduplicate-analytics.js --dry-run    # Preview what would be deleted
 *   node deduplicate-analytics.js              # Actually delete duplicates
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../.env' });

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const dryRun = process.argv.includes('--dry-run');

async function countEvents() {
  const { count } = await supabase
    .from('analytics_events')
    .select('*', { count: 'exact', head: true });
  return count || 0;
}

async function findDuplicates() {
  console.log('Finding duplicate events...\n');

  // For delivered/bounce/spam/unsubscribe/block: keep one per (campaign_id, email, event_type)
  const deliveryTypes = ['delivered', 'bounce', 'spam', 'unsubscribe', 'block'];

  let totalDuplicates = 0;
  const duplicateIds = [];

  for (const eventType of deliveryTypes) {
    // Get all events of this type grouped by campaign_id + email
    let offset = 0;
    const pageSize = 1000;
    const seen = new Map(); // key: "campaign_id:email" -> first event id

    while (true) {
      const { data: events } = await supabase
        .from('analytics_events')
        .select('id, campaign_id, email, timestamp')
        .eq('event_type', eventType)
        .order('timestamp', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (!events || events.length === 0) break;

      for (const e of events) {
        const key = `${e.campaign_id}:${e.email}`;
        if (seen.has(key)) {
          // This is a duplicate - mark for deletion
          duplicateIds.push(e.id);
        } else {
          seen.set(key, e.id);
        }
      }

      if (events.length < pageSize) break;
      offset += pageSize;
    }

    const dupsForType = duplicateIds.length - totalDuplicates;
    if (dupsForType > 0) {
      console.log(`  ${eventType}: ${dupsForType} duplicates found`);
    }
    totalDuplicates = duplicateIds.length;
  }

  // For opens: keep one per (campaign_id, email)
  {
    let offset = 0;
    const pageSize = 1000;
    const seen = new Map();
    const beforeCount = duplicateIds.length;

    while (true) {
      const { data: events } = await supabase
        .from('analytics_events')
        .select('id, campaign_id, email, timestamp')
        .eq('event_type', 'open')
        .order('timestamp', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (!events || events.length === 0) break;

      for (const e of events) {
        const key = `${e.campaign_id}:${e.email}`;
        if (seen.has(key)) {
          duplicateIds.push(e.id);
        } else {
          seen.set(key, e.id);
        }
      }

      if (events.length < pageSize) break;
      offset += pageSize;
    }

    const dupsForType = duplicateIds.length - beforeCount;
    if (dupsForType > 0) {
      console.log(`  open: ${dupsForType} duplicates found`);
    }
  }

  // For clicks: keep one per (campaign_id, email, url)
  {
    let offset = 0;
    const pageSize = 1000;
    const seen = new Map();
    const beforeCount = duplicateIds.length;

    while (true) {
      const { data: events } = await supabase
        .from('analytics_events')
        .select('id, campaign_id, email, url, timestamp')
        .eq('event_type', 'click')
        .order('timestamp', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (!events || events.length === 0) break;

      for (const e of events) {
        const key = `${e.campaign_id}:${e.email}:${e.url || ''}`;
        if (seen.has(key)) {
          duplicateIds.push(e.id);
        } else {
          seen.set(key, e.id);
        }
      }

      if (events.length < pageSize) break;
      offset += pageSize;
    }

    const dupsForType = duplicateIds.length - beforeCount;
    if (dupsForType > 0) {
      console.log(`  click: ${dupsForType} duplicates found`);
    }
  }

  return duplicateIds;
}

async function deleteDuplicates(ids) {
  console.log(`\nDeleting ${ids.length} duplicate events...`);

  // Delete in batches of 100
  const batchSize = 100;
  let deleted = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const { error } = await supabase
      .from('analytics_events')
      .delete()
      .in('id', batch);

    if (error) {
      console.error(`Error deleting batch: ${error.message}`);
    } else {
      deleted += batch.length;
      if (deleted % 1000 === 0 || deleted === ids.length) {
        console.log(`  Deleted ${deleted}/${ids.length}`);
      }
    }
  }

  return deleted;
}

async function main() {
  console.log('Analytics Events Deduplication Script');
  console.log('=====================================\n');

  if (dryRun) {
    console.log('*** DRY RUN MODE - No changes will be made ***\n');
  }

  const beforeCount = await countEvents();
  console.log(`Total events before: ${beforeCount.toLocaleString()}\n`);

  const duplicateIds = await findDuplicates();

  console.log(`\nTotal duplicates: ${duplicateIds.length.toLocaleString()}`);
  console.log(`Events after dedup: ${(beforeCount - duplicateIds.length).toLocaleString()}`);

  if (duplicateIds.length === 0) {
    console.log('\nNo duplicates found. Database is clean!');
    return;
  }

  if (dryRun) {
    console.log('\nRun without --dry-run to delete these duplicates.');
  } else {
    const deleted = await deleteDuplicates(duplicateIds);
    const afterCount = await countEvents();
    console.log(`\nDone! Deleted ${deleted.toLocaleString()} duplicates.`);
    console.log(`Total events now: ${afterCount.toLocaleString()}`);
  }
}

main().catch(console.error);
