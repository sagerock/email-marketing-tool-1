#!/usr/bin/env python3
"""
Populate the tags table from existing contacts.
Run this after applying the 009_add_tags_table.sql migration in Supabase.
"""

import json
import urllib.request
from collections import defaultdict

# Supabase configuration
SUPABASE_URL = "https://ckloewflialohuvixmvd.supabase.co"
SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzQyODQ1MiwiZXhwIjoyMDc5MDA0NDUyfQ.Z_6kVaKtZmKQWtDBV_iu3wyZzJm8zbyc_IHKLWBvJ2o"

# Alconox client ID
ALCONOX_CLIENT_ID = "ea7f1422-2d20-4299-85a7-c1201e953409"

def fetch_all_contacts():
    """Fetch all contacts to extract tags."""
    print("Fetching contacts...")

    all_contacts = []
    offset = 0
    limit = 1000

    while True:
        url = f"{SUPABASE_URL}/rest/v1/contacts?client_id=eq.{ALCONOX_CLIENT_ID}&select=tags&offset={offset}&limit={limit}"

        headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
        }

        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())

        if not data:
            break

        all_contacts.extend(data)
        offset += limit
        print(f"  Fetched {len(all_contacts)} contacts so far...")

    return all_contacts

def count_tags(contacts):
    """Count occurrences of each tag."""
    tag_counts = defaultdict(int)

    for contact in contacts:
        tags = contact.get('tags') or []
        for tag in tags:
            if tag:
                tag_counts[tag] += 1

    return tag_counts

def insert_tags(tag_counts):
    """Insert tags into the tags table."""
    print(f"\nInserting {len(tag_counts)} unique tags...")

    tags_data = [
        {
            'name': tag,
            'client_id': ALCONOX_CLIENT_ID,
            'contact_count': count
        }
        for tag, count in tag_counts.items()
    ]

    # Insert in batches
    batch_size = 500
    for i in range(0, len(tags_data), batch_size):
        batch = tags_data[i:i + batch_size]

        url = f"{SUPABASE_URL}/rest/v1/tags?on_conflict=name,client_id"

        headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
        }

        data = json.dumps(batch).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers=headers, method='POST')

        try:
            with urllib.request.urlopen(req) as response:
                print(f"  Inserted batch {i // batch_size + 1}")
        except urllib.error.HTTPError as e:
            print(f"  Error: {e.read().decode()}")
            return False

    return True

def main():
    print("=" * 60)
    print("Populating Tags Table")
    print("=" * 60)

    # Fetch contacts
    contacts = fetch_all_contacts()
    print(f"\nTotal contacts: {len(contacts)}")

    # Count tags
    tag_counts = count_tags(contacts)
    print(f"Unique tags found: {len(tag_counts)}")

    # Show top 10 tags
    print("\nTop 10 tags by count:")
    sorted_tags = sorted(tag_counts.items(), key=lambda x: -x[1])[:10]
    for tag, count in sorted_tags:
        print(f"  {tag}: {count:,}")

    # Insert tags
    success = insert_tags(tag_counts)

    if success:
        print("\nDone! Tags table populated.")
    else:
        print("\nFailed to populate tags table.")

if __name__ == "__main__":
    main()
