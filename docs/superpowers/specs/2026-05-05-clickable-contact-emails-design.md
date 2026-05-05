# Clickable Contact Emails

## Goal

Wherever a contact's email address is displayed in the app, make it a clickable link that navigates to that contact's detail page (`/contacts/:id`). User flow: from any analytics or list view, click an email → land on the contact's full profile and history.

## Scope

Update 10 display sites across 5 files. Each is a one-line wrap of the email value in a React Router `<Link>`.

| # | File | Line | Context |
|---|------|------|---------|
| 1 | `src/pages/Analytics.tsx` | 1423 | Engaged Subscribers tab table |
| 2 | `src/pages/Analytics.tsx` | 1541 | Bounced contacts tab table |
| 3 | `src/pages/Analytics.tsx` | 1615 | Unsubscribed contacts tab table |
| 4 | `src/pages/Analytics.tsx` | 2198 | Campaign event list (open/click rows) |
| 5 | `src/pages/Analytics.tsx` | 2499 | Subscriber Activity modal header |
| 6 | `src/pages/Contacts.tsx` | 885 | Contacts list table |
| 7 | `src/pages/BounceRecovery.tsx` | 373 | Bounce recovery list |
| 8 | `src/pages/Automations.tsx` | 1975 | Sequence enrollments view |
| 9 | `src/pages/AIAgents.tsx` | 475 | Draft list email |
| 10 | `src/pages/AIAgents.tsx` | 538, 657, 751 | Other AI agent draft displays |

## Approach

For 9 of 10 sites, the row's `contact.id` (or equivalent) is already in scope. Replace the bare `{contact.email}` with:

```tsx
<Link
  to={`/contacts/${contact.id}`}
  className="text-blue-600 hover:text-blue-800 hover:underline"
>
  {contact.email}
</Link>
```

### The one lookup case: campaign event list (Analytics.tsx:2198)

`AnalyticsEvent` rows store `email` but no `contact_id`. When the events list loads for a campaign, build a single `email → contact_id` map by querying `contacts` for that client filtered to the set of emails in the visible event list. (The page already does similar bulk lookups for filtered events at lines 187–192.)

Render rule for each event row:
- If `emailToContactId.get(event.email)` returns an id → render as a `<Link>`.
- Otherwise (deleted contact, or never a contact) → render as plain text. No "not found" page, no error.

The map should refresh when `displayEvents` changes (filter switch between all / open / click).

## Out of Scope

These email displays are NOT contacts and stay as plain text:

- Logged-in user header (`Layout.tsx`)
- The contact's own detail page header (already has `mailto:` — leave alone)
- Sender / from / reply-to addresses (Automations, Campaigns, Settings sender forms)
- Salesforce preview rows in Settings (not necessarily in our contacts table)
- Admin users page
- Public unsubscribe page (no auth, no navigation target)

## Non-Goals

- No new shared component — direct `<Link>` usage keeps each diff to one line.
- No changes to `analytics_events` schema or any backend code.
- No styling system changes — reuse the existing blue-link pattern.
- No keyboard / accessibility work beyond what `<Link>` provides by default.

## Risk & Rollback

- Risk: opening a contact page in the same tab loses the analytics context (filters, scroll position). Acceptable — browser back works.
- Rollback: revert the commit. No data migrations, no schema changes.

## Verification

- Click an email in each of the 10 sites → confirm it routes to `/contacts/<id>` and the contact loads.
- For the campaign event list: confirm a known-good email links correctly, and an event for a deleted contact (if findable) renders as plain text without errors.
- Confirm the page already on screen (filters, selected campaign) is unaffected by the change set.
