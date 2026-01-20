#!/usr/bin/env python3
"""
Upload contacts from CSV to Supabase.
Uses batch inserts for efficiency.
"""

import csv
import json
import time
import urllib.request
import urllib.error

# Supabase configuration
SUPABASE_URL = "https://ckloewflialohuvixmvd.supabase.co"
SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzQyODQ1MiwiZXhwIjoyMDc5MDA0NDUyfQ.Z_6kVaKtZmKQWtDBV_iu3wyZzJm8zbyc_IHKLWBvJ2o"

# Input file
CSV_FILE = "supabase_import_ready.csv"

# Batch size (Supabase handles up to 1000 rows per request well)
BATCH_SIZE = 500

def parse_tags(tags_str):
    """
    Parse PostgreSQL array format to Python list.
    Input: '{"tag1","tag2"}'
    Output: ['tag1', 'tag2']
    """
    if not tags_str or tags_str == '{}':
        return []
    # Remove outer braces and split
    inner = tags_str.strip('{}')
    if not inner:
        return []
    # Parse quoted strings
    tags = []
    current = ""
    in_quotes = False
    for char in inner:
        if char == '"':
            in_quotes = not in_quotes
        elif char == ',' and not in_quotes:
            if current:
                tags.append(current)
            current = ""
        else:
            current += char
    if current:
        tags.append(current)
    return tags

def load_csv(filepath):
    """Load contacts from CSV file."""
    contacts = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            contact = {
                'email': row['email'],
                'first_name': row['first_name'] or None,
                'last_name': row['last_name'] or None,
                'company': row['company'] or None,
                'source_code': row['source_code'] or None,
                'industry': row['industry'] or None,
                'record_type': row['record_type'] or None,
                'tags': parse_tags(row['tags']),
                'unsubscribed': row['unsubscribed'] == 'true',
                'client_id': row['client_id'],
            }
            contacts.append(contact)
    return contacts

def upload_batch(contacts, batch_num, total_batches):
    """Upload a batch of contacts to Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/contacts?on_conflict=email,client_id"

    headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',  # Upsert on conflict
    }

    data = json.dumps(contacts).encode('utf-8')

    req = urllib.request.Request(url, data=data, headers=headers, method='POST')

    try:
        with urllib.request.urlopen(req) as response:
            status = response.status
            if status in (200, 201):
                print(f"  Batch {batch_num}/{total_batches}: Uploaded {len(contacts)} contacts ✓")
                return True, None
            else:
                return False, f"Status {status}"
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        return False, f"HTTP {e.code}: {error_body}"
    except Exception as e:
        return False, str(e)

def main():
    print("=" * 60)
    print("Supabase Contact Uploader")
    print("=" * 60)

    # Load contacts
    print(f"\n1. Loading contacts from {CSV_FILE}...")
    contacts = load_csv(CSV_FILE)
    print(f"   Loaded {len(contacts):,} contacts")

    # Calculate batches
    total_batches = (len(contacts) + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"\n2. Uploading in {total_batches} batches of {BATCH_SIZE}...")

    # Upload in batches
    successful = 0
    failed = 0
    failed_batches = []

    for i in range(0, len(contacts), BATCH_SIZE):
        batch = contacts[i:i + BATCH_SIZE]
        batch_num = (i // BATCH_SIZE) + 1

        success, error = upload_batch(batch, batch_num, total_batches)

        if success:
            successful += len(batch)
        else:
            failed += len(batch)
            failed_batches.append((batch_num, error))
            print(f"  Batch {batch_num}/{total_batches}: FAILED - {error}")

        # Small delay to avoid rate limiting
        if batch_num < total_batches:
            time.sleep(0.1)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Successfully uploaded: {successful:,}")
    print(f"Failed: {failed:,}")

    if failed_batches:
        print(f"\nFailed batches:")
        for batch_num, error in failed_batches[:5]:  # Show first 5
            print(f"  - Batch {batch_num}: {error[:100]}")
        if len(failed_batches) > 5:
            print(f"  ... and {len(failed_batches) - 5} more")

    print("\nDone!")

if __name__ == "__main__":
    main()
