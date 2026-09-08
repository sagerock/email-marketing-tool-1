# Email Tracker

The authenticated `/email-tracker` page provides board, list and archive views
for the selected client. Start with an idea and brief, record a target date, then
link the campaign created in the existing Campaigns tool. Existing and newly
created campaigns get a tracker automatically. Linking a plan preserves the
original plan's history and adds its reference to the campaign's tracker.

Preparation stages are Started, Drafted, Waiting for approval and Approved.
Scheduled and Sent come from the campaign's actual delivery status. Sending
appears in Scheduled until the send completes; failed/partial sends show a
delivery issue. Target dates are planning dates and never schedule a send.

“Request approval” records a stage only; it does not email anyone. Record an
approval received outside the tool in the note field, including who approved
and their message. The authenticated recorder and timestamp are captured
separately from the named approver. Approval captures the exact HTML, subject,
sender and audience configuration. Changing them invalidates recorded approval
and cancels a pending schedule; the old approval stays in the event log.
Scheduling an existing campaign without a recorded tracker approval remains
possible through the existing Campaigns workflow. This tracker is not an
organization-wide mandatory approval gate.

The database triggers cover UI, API, cron and direct campaign updates. No sender
or cron implementation is replaced. Backfill preserves existing delivery states
and dates and explicitly labels earlier approval/preparation dates as unknown.
Deleting a campaign archives its tracker and retains delivery history.

## Storage and access

Migration `089_email_tracker.sql` creates:

- `email_tracker_items`: preparation state, campaign link, planning notes and
  dates, latest approval, or a historical extracted record.
- `email_tracker_events`: append-only history for app users, including approval
  snapshots, state transitions, notes, scheduling and actual sends.
- `email_tracker_imports`: private, verbatim original JSON exports.

Authenticated readers use existing `can_access_client` RLS. Writes go through
`email_tracker_change`, with explicit tenant checks, row locks and a required
expected timestamp to reject stale edits. Clients cannot directly fabricate or
rewrite events, approvals, imported source files or ownership. Service-role
archive imports are tenant-scoped and do not create campaigns or send emails.

## Trello migration

Run from the repository root with the usual `.env` service credentials:

```sh
node scripts/import-trello-email-archive.mjs /absolute/path/card.json CLIENT_UUID
node scripts/import-trello-email-archive.mjs /absolute/path/card.json CLIENT_UUID --apply
```

The default mode previews counts and exact title/year campaign matches. Apply
stores the original JSON verbatim, then inserts extracted entries in retryable
batches. Repeating an identical import skips existing rows, preserving review
decisions. A changed export of the same card is rejected rather than overwriting
the original. Every source comment is retained; comments without clear markers
remain a single historical note. Each extracted entry also retains the entire
source comment, author, creation and last-edit timestamps. Card metadata and
all actions remain available through “Download original JSON.”

GTG, scheduled and sent claims remain *reported* statuses pending review. No
comment timestamp is used as an approval or send date. Only unique exact title
matches within the heading's year are linked to current campaigns; ambiguous
records can be linked manually. Linking/reviewing history never approves or
sends a live campaign. Earlier edited versions absent from the export cannot be
reconstructed. Raw exports must never be placed in this public repository.

## Verification

```sh
npm run build
npx eslint src/pages/EmailTracker.tsx
node --test scripts/trello-email-archive.test.mjs
pg_virtualenv psql -X -q -f scripts/test-email-tracker.sql
```

The SQL test creates a disposable PostgreSQL cluster with synthetic tenants and
campaigns. It tests backfill/schedule preservation, approval snapshots and
invalidation, automatic send history, campaign removal, planning linkage,
concurrency checks, RLS and prevention of direct audit forgery. Never run this
test fixture against production.

Deploy the migration before the frontend. It is transactional. No archive data
is bundled in frontend assets or committed to Git. Verify imported counts and
source checksum after import, and verify existing scheduled campaigns retain
their status and scheduled timestamps.
