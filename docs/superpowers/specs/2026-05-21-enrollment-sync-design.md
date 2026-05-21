# Enrollment Sync — Design Spec

**Date:** 2026-05-21
**Status:** Approved
**Scope:** Phase 1 — Supabase schema + Cvent connector + extensible framework for Gravity Forms (Phase 2) and Thinkific (Phase 3)

---

## Problem

CfA and future school clients register participants in external platforms (Cvent, Gravity Forms, Thinkific) but have no way to:

- Send course-specific emails to enrolled participants without manual roster wrangling
- Track enrollment history across years for trend analysis
- Know which participants are returning vs. first-timers
- Target campaigns to a specific course cohort in the mail tool

The existing `send_renewal_welcome_letters.py` script solves the immediate send problem but requires Sage to edit code, run it manually on multiple dates, and throw the roster data away after each use.

---

## Solution

Add a `programs` + `enrollments` schema to the mail tool's Supabase database and a connector-based sync script that pulls from external enrollment platforms. Enrolled contacts are auto-tagged for mail tool campaign targeting. Sage runs the sync manually; sequences handle the multi-send scheduling automatically.

---

## Schema

### `programs` table

One row per course offering (e.g., "Grade 4 Teaching - Renewal 2026 Online").

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `client_id` | UUID FK → clients | |
| `name` | text | "Grade 4 Teaching - Renewal 2026" |
| `year` | int | 2026 |
| `format` | text | "online" \| "in-person" \| "hybrid" |
| `platform` | text | "cvent" \| "gravity_forms" \| "thinkific" \| "manual" |
| `platform_id` | text | Session/form/course ID on source platform |
| `tag` | text | Auto-applied to enrolled contacts, e.g. "grade-4-renewal-2026-online" |
| `instructor` | text | Optional |
| `start_date` | date | |
| `end_date` | date | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `enrollments` table

One row per contact-program pair.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `client_id` | UUID FK → clients | Denormalized for RLS performance |
| `program_id` | UUID FK → programs | |
| `contact_id` | UUID FK → contacts | |
| `status` | text | "registered" \| "cancelled" \| "waitlisted" |
| `enrolled_at` | timestamptz | Timestamp from source platform |
| `platform_enrollment_id` | text | Enrollment ID on source platform |
| `raw_data` | JSONB | Full source record — nothing discarded |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

**Unique constraint:** `(contact_id, program_id)`

---

## Sync Script

### Location

`scripts/enrollment-sync/` in the email-marketing-tool-1 repo.

### Structure

```
scripts/enrollment-sync/
├── sync.py                  # Entry point
├── connectors/
│   ├── cvent.py             # Phase 1
│   ├── gravity_forms.py     # Phase 2
│   └── thinkific.py         # Phase 3
├── db.py                    # Supabase upsert logic (shared)
├── .env                     # SUPABASE_URL, SUPABASE_SERVICE_KEY, platform credentials
└── requirements.txt
```

### Usage

```bash
# Sync one session
python sync.py --client cfa --platform cvent --program-id <session_id>

# Sync all sessions for an event (Renewal batch)
python sync.py --client cfa --platform cvent --event-id <event_id> --all-sessions

# Dry run (print what would be upserted, don't write)
python sync.py --client cfa --platform cvent --event-id <event_id> --dry-run
```

### Sync Flow (per run)

1. Connector fetches roster from source platform
2. Each person is upserted into `contacts` (create if new, update name/fields if exists)
3. Program is upserted into `programs` (idempotent — same `platform_id` = same row)
4. Each enrollment is upserted into `enrollments` (unique on contact+program)
5. Program's `tag` is added to `contacts.tags[]` for newly enrolled contacts
6. Cancelled enrollments update `status` but keep the record

**Idempotent:** Running the same sync twice produces the same result. Safe to re-run after failures or as a pre-send refresh.

---

## Cvent Connector (Phase 1)

Reuses auth and API patterns from `send_renewal_welcome_letters.py`.

**Field mapping:**

| Cvent field | Our field |
|-------------|-----------|
| `contact.firstName` | `contacts.first_name` |
| `contact.lastName` | `contacts.last_name` |
| `contact.email` | `contacts.email` |
| `attendee.id` | `enrollments.platform_enrollment_id` |
| `registrationDate` | `enrollments.enrolled_at` |
| `status` | `enrollments.status` |
| full attendee record | `enrollments.raw_data` |

**Historical backfill:** Run the sync once per past Renewal event (2023, 2024, 2025) using past event IDs from the Cvent admin UI. One-time operation that seeds the trend dataset immediately.

---

## Mail Tool Integration

### Tag bridge

The sync applies the program's `tag` to each enrolled contact's `tags[]` array. This makes them immediately targetable by existing mail tool campaigns via `filter_tags`. No UI changes required.

### Sequence automation

For multi-send campaigns (e.g., Elsy's 3-send Renewal sequence), configure an `email_sequence` with `trigger_type: "tag_added"` pointing at the program tag. Steps use delay-based scheduling from enrollment date:

| Step | Delay | Subject |
|------|-------|---------|
| 1 | 0 days | "Welcome to Renewal, your Long-Awaited Retreat" |
| 2 | 14 days | "Your retreat is getting really close!" |
| 3 | 26 days (in-person) / 34 days (online) | "It's tomorrow!" |

Sage triggers the sync on the target send date (e.g., June 1) → contacts get tagged → sequences auto-fire. No manual follow-up runs needed for steps 2 and 3.

### Sender identity

Set `from_email` and `from_name` on the sequence to `karen@centerforanthroposophy.org` / "Karen" (or Elsy). SendGrid sends on behalf of the verified domain. No OAuth required.

---

## Gravity Forms Connector (Phase 2)

Each form submission becomes an enrollment. Connector hits the Gravity Forms REST API and maps entry fields to contacts + enrollments via a per-client JSON config file that specifies which entry field maps to email, first name, last name, and program.

Multiple clients can use the same connector with different config files.

---

## CfA Rollout Path

| When | Action |
|------|--------|
| Now | Build schema migrations + Cvent connector + backfill 2023-2025 |
| May 28 call | Show Elsy the sequences approach — same 3-send outcome, automated |
| June 1 | Run sync for 2026 Renewal sessions → sequences fire automatically |
| July 10 | Final sync after Renewal ends to capture late registrations |
| 2027 planning | Gravity Forms connector replaces Cvent, same schema |

---

## Out of Scope (this phase)

- Analytics dashboard UI (queries run directly against Supabase for now)
- Thinkific connector
- Self-service sync configuration UI in the mail tool admin
- Real-time webhook sync (Gravity Forms, Thinkific)
- Gmail OAuth sender identity
