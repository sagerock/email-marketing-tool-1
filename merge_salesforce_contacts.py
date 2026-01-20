#!/usr/bin/env python3
"""
Merge Salesforce Contacts and Leads exports with Marketing Cloud unsubscribe data.
Outputs a clean CSV ready for Supabase import.
"""

import csv
import re
from collections import defaultdict

# File paths
DATA_DIR = "supabase/emails"
CONTACTS_FILE = f"{DATA_DIR}/salesforce-v2-report1764864501606.csv"
LEADS_FILE = f"{DATA_DIR}/Salesforce-v2-Leads-report1764864982947.csv"
MARKETING_CLOUD_FILE = f"{DATA_DIR}/Marketing Cloud All Contacts export_All Subscribers_12042025 - export_All Subscribers_12042025.csv.csv"
OUTPUT_FILE = "supabase_import_ready.csv"  # Output to project root (emails folder has root permissions)

# Alconox client ID from Supabase
ALCONOX_CLIENT_ID = "ea7f1422-2d20-4299-85a7-c1201e953409"

def parse_source_code_history(history_text):
    """
    Parse Source Code History into a list of tags.
    Input: "CIP2021 @ 2021-10-28\nWeb Order @ 2020-12-09\nSample Request"
    Output: ["CIP2021", "Web Order", "Sample Request"]
    """
    if not history_text:
        return []

    tags = []
    lines = history_text.strip().split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Remove date suffix like " @ 2021-10-28"
        tag = re.sub(r'\s*@\s*\d{4}-\d{2}-\d{2}.*$', '', line)
        tag = tag.strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags

def load_marketing_cloud_status(filepath):
    """
    Load Marketing Cloud export and return dict of email -> status.
    Status values: Active, Held, Unsubscribed, etc.
    """
    email_status = {}
    try:
        with open(filepath, 'r', encoding='latin-1') as f:
            reader = csv.DictReader(f)
            for row in reader:
                email = row.get('Email Address', '').strip().lower()
                status = row.get('Status', '').strip()
                if email:
                    # If we've seen this email before, prefer "Unsubscribed" or "Held" status
                    existing = email_status.get(email)
                    if existing in ('Unsubscribed', 'Held'):
                        continue  # Keep the worse status
                    if status in ('Unsubscribed', 'Held') or not existing:
                        email_status[email] = status
    except FileNotFoundError:
        print(f"Warning: Marketing Cloud file not found: {filepath}")

    return email_status

def parse_contacts(filepath, email_status):
    """Parse Salesforce Contacts export."""
    contacts = {}

    with open(filepath, 'r', encoding='latin-1') as f:
        reader = csv.DictReader(f)
        for row in reader:
            email = row.get('Email', '').strip().lower()
            if not email:
                continue

            # Parse source code history into tags
            history = row.get('Source Code History', '')
            tags = parse_source_code_history(history)

            # Add main source code to tags if not already there
            main_source = row.get('Source Code', '').strip()
            if main_source and main_source not in tags:
                tags.insert(0, main_source)

            # Get industry (handle duplicate columns - take first non-empty)
            industry = row.get('Industry', '').strip()

            # Add industry as a tag if it exists
            if industry and industry not in tags:
                tags.append(industry)

            # Get unsubscribe status from Marketing Cloud
            mc_status = email_status.get(email, 'Unknown')
            is_unsubscribed = mc_status in ('Unsubscribed', 'Held')

            contacts[email] = {
                'email': email,
                'first_name': row.get('First Name', '').strip(),
                'last_name': row.get('Last Name', '').strip(),
                'company': row.get('Account Name', '').strip(),
                'source_code': main_source,
                'industry': industry,
                'record_type': 'contact',
                'tags': tags,
                'unsubscribed': is_unsubscribed,
                'mc_status': mc_status
            }

    return contacts

def parse_leads(filepath, email_status, existing_contacts):
    """
    Parse Salesforce Leads export.
    Merge with existing contacts if email already exists.
    """
    leads = {}
    merged_count = 0

    with open(filepath, 'r', encoding='latin-1') as f:
        reader = csv.DictReader(f)
        for row in reader:
            email = row.get('Email', '').strip().lower()
            if not email:
                continue

            # Parse source code history into tags
            history = row.get('Source Code History', '')
            tags = parse_source_code_history(history)

            # Add main source code to tags if not already there
            main_source = row.get('Source code', '').strip()  # Note: lowercase 'c' in Leads
            if main_source and main_source not in tags:
                tags.insert(0, main_source)

            industry = row.get('Industry', '').strip()

            # Add industry as a tag if it exists
            if industry and industry not in tags:
                tags.append(industry)

            # Get unsubscribe status from Marketing Cloud
            mc_status = email_status.get(email, 'Unknown')
            is_unsubscribed = mc_status in ('Unsubscribed', 'Held')

            # Check if this email already exists as a Contact
            if email in existing_contacts:
                # Merge tags from Lead into existing Contact
                existing = existing_contacts[email]
                for tag in tags:
                    if tag not in existing['tags']:
                        existing['tags'].append(tag)
                # Keep Contact data but note it was merged
                merged_count += 1
                continue

            # Check if we already have this Lead
            if email in leads:
                # Merge tags
                for tag in tags:
                    if tag not in leads[email]['tags']:
                        leads[email]['tags'].append(tag)
                continue

            leads[email] = {
                'email': email,
                'first_name': row.get('First Name', '').strip(),
                'last_name': row.get('Last Name', '').strip(),
                'company': row.get('Company / Account', '').strip(),
                'source_code': main_source,
                'industry': industry,
                'record_type': 'lead',
                'tags': tags,
                'unsubscribed': is_unsubscribed,
                'mc_status': mc_status
            }

    print(f"  Merged {merged_count} leads into existing contacts")
    return leads

def write_output(contacts, leads, filepath):
    """Write merged data to CSV for Supabase import."""

    # Combine all records
    all_records = list(contacts.values()) + list(leads.values())

    # Sort by email for consistency
    all_records.sort(key=lambda x: x['email'])

    with open(filepath, 'w', newline='', encoding='utf-8') as f:
        fieldnames = [
            'email',
            'first_name',
            'last_name',
            'company',
            'source_code',
            'industry',
            'record_type',
            'tags',
            'unsubscribed',
            'client_id',
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for record in all_records:
            # Convert tags list to PostgreSQL array format: {tag1,tag2,tag3}
            tags_str = '{' + ','.join(f'"{t}"' for t in record['tags']) + '}'

            writer.writerow({
                'email': record['email'],
                'first_name': record['first_name'],
                'last_name': record['last_name'],
                'company': record['company'],
                'source_code': record['source_code'],
                'industry': record['industry'],
                'record_type': record['record_type'],
                'tags': tags_str,
                'unsubscribed': 'true' if record['unsubscribed'] else 'false',
                'client_id': ALCONOX_CLIENT_ID,
            })

    return len(all_records)

def main():
    print("=" * 60)
    print("Salesforce to Supabase Contact Merger")
    print("=" * 60)

    # Step 1: Load Marketing Cloud unsubscribe status
    print("\n1. Loading Marketing Cloud unsubscribe data...")
    email_status = load_marketing_cloud_status(MARKETING_CLOUD_FILE)
    print(f"   Loaded status for {len(email_status):,} emails")

    # Count statuses
    status_counts = defaultdict(int)
    for status in email_status.values():
        status_counts[status] += 1
    for status, count in sorted(status_counts.items()):
        print(f"   - {status}: {count:,}")

    # Step 2: Parse Contacts
    print("\n2. Parsing Salesforce Contacts...")
    contacts = parse_contacts(CONTACTS_FILE, email_status)
    print(f"   Loaded {len(contacts):,} contacts")

    # Step 3: Parse Leads (and merge with existing contacts)
    print("\n3. Parsing Salesforce Leads...")
    leads = parse_leads(LEADS_FILE, email_status, contacts)
    print(f"   Loaded {len(leads):,} unique leads")

    # Step 4: Write output
    print("\n4. Writing output file...")
    total = write_output(contacts, leads, OUTPUT_FILE)
    print(f"   Wrote {total:,} records to {OUTPUT_FILE}")

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total contacts: {len(contacts):,}")
    print(f"Total leads: {len(leads):,}")
    print(f"Total records: {total:,}")

    # Count unsubscribed
    all_records = list(contacts.values()) + list(leads.values())
    unsub_count = sum(1 for r in all_records if r['unsubscribed'])
    print(f"Unsubscribed/Held: {unsub_count:,}")
    print(f"Active/Sendable: {total - unsub_count:,}")

    print(f"\nOutput file: {OUTPUT_FILE}")
    print("Ready for Supabase import!")

if __name__ == "__main__":
    main()
