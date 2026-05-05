# Clickable Contact Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wherever a contact's email is displayed in the app, make it a clickable link that navigates to that contact's detail page (`/contacts/:id`).

**Architecture:** Pure UI change — wrap each email display in a React Router `<Link>`. Eight of nine sites already have `contact.id` in scope, so the change is a one-line wrap per site. The campaign event list in Analytics has only `email`, so we build a one-time `email → contact_id` lookup map after events load.

**Tech Stack:** React 19, react-router-dom 7, TypeScript, Tailwind CSS, Supabase (browser client).

**Spec:** [docs/superpowers/specs/2026-05-05-clickable-contact-emails-design.md](../specs/2026-05-05-clickable-contact-emails-design.md)

**Note on scope vs. spec:** The spec listed `Contacts.tsx:885`. Verified during planning — that email is *already* a button that calls `onViewActivity(contact)` which navigates to `/contacts/${contact.id}` (see `Contacts.tsx:633`). No change needed. Plan covers the remaining 9 spots across 4 files.

**Note on testing:** This codebase has no test framework. Verification per task is (a) `npm run build` (TypeScript + Vite), and (b) manual click-through in `npm run dev`.

---

## File Map

| File | Sites | Adds Link import? |
|------|-------|-------------------|
| `src/pages/Analytics.tsx` | 5 | yes |
| `src/pages/BounceRecovery.tsx` | 1 | yes |
| `src/pages/Automations.tsx` | 1 | yes |
| `src/pages/AIAgents.tsx` | 4 | yes |

**Shared link className:** `"text-blue-600 hover:text-blue-800 hover:underline"` — use this verbatim in every Link.

**stopPropagation rule:** When the Link sits inside a parent that already has its own `onClick` (row toggles a checkbox; header expands a card), add `onClick={(e) => e.stopPropagation()}` so the parent action doesn't fire when the user clicks the email.

---

## Task 1: Analytics.tsx — four direct-Link sites + Subscriber Modal

**Files:**
- Modify: `src/pages/Analytics.tsx`

This task wraps the four sites where `contact.id` (or `selectedSubscriber.id`) is already in scope and there's no parent click conflict. The fifth Analytics site (campaign event list, line 2198) needs a lookup map and gets its own task.

- [ ] **Step 1: Add the Link import**

In `src/pages/Analytics.tsx`, after line 1 (`import { useState, useEffect } from 'react'`), insert:

```tsx
import { Link } from 'react-router-dom'
```

- [ ] **Step 2: Wrap email in Engaged Subscribers table (line 1423)**

Replace this line:

```tsx
                          <td className="py-3 px-4 text-sm text-blue-600 hover:text-blue-800">{contact.email}</td>
```

With:

```tsx
                          <td className="py-3 px-4 text-sm">
                            <Link
                              to={`/contacts/${contact.id}`}
                              className="text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {contact.email}
                            </Link>
                          </td>
```

- [ ] **Step 3: Wrap email in Bounced contacts table (line 1541)**

Replace this line:

```tsx
                                <td className="py-3 px-4 text-sm text-gray-900">{contact.email}</td>
```

With:

```tsx
                                <td className="py-3 px-4 text-sm">
                                  <Link
                                    to={`/contacts/${contact.id}`}
                                    className="text-blue-600 hover:text-blue-800 hover:underline"
                                  >
                                    {contact.email}
                                  </Link>
                                </td>
```

- [ ] **Step 4: Wrap email in Unsubscribed contacts table (line 1615)**

Replace this line:

```tsx
                            <td className="py-2 px-4 text-sm text-gray-900">{contact.email}</td>
```

With:

```tsx
                            <td className="py-2 px-4 text-sm">
                              <Link
                                to={`/contacts/${contact.id}`}
                                className="text-blue-600 hover:text-blue-800 hover:underline"
                              >
                                {contact.email}
                              </Link>
                            </td>
```

- [ ] **Step 5: Wrap email in Subscriber Activity modal header (line 2499)**

Replace this line:

```tsx
                <p className="text-sm text-gray-600">{selectedSubscriber.email}</p>
```

With:

```tsx
                <p className="text-sm">
                  <Link
                    to={`/contacts/${selectedSubscriber.id}`}
                    className="text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    {selectedSubscriber.email}
                  </Link>
                </p>
```

- [ ] **Step 6: Run the build to verify TypeScript and the bundle**

Run from the project root:

```bash
npm run build
```

Expected: completes without TypeScript errors. The four edited locations should not produce any "Cannot find name 'Link'" or "Property 'id' does not exist" errors.

- [ ] **Step 7: Manually verify in dev**

Run from the project root:

```bash
npm run dev
```

Open the running URL (usually http://localhost:5173). Sign in, select the Alconox client, and:

1. Navigate to Analytics → drill into a campaign → "Engaged Subscribers" tab. Click an email → confirm it routes to `/contacts/<id>` and the contact loads.
2. Switch to "Bounced" tab → click an email → confirm navigation.
3. Switch to "Unsubscribed" tab → click an email → confirm navigation.
4. Back on Engaged Subscribers, click the row's "View Activity" button to open the modal → confirm the email in the modal header is a working link.

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Analytics.tsx
git commit -m "$(cat <<'EOF'
Make contact emails clickable in Analytics tabs and modal

Wrap email displays in Engaged Subscribers, Bounced, and
Unsubscribed tables, plus the Subscriber Activity modal header,
in react-router Link to /contacts/:id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Analytics.tsx — campaign event list with email→id lookup

**Files:**
- Modify: `src/pages/Analytics.tsx`

This is the table the user originally asked about — the per-campaign list of open/click events. Each row only has `event.email`, so we need to build an `email → contact_id` map for the visible events.

The existing pattern at lines 187–192 (filtered events fetch) already shows how to bulk-look-up contacts by email + client_id; we follow the same shape.

- [ ] **Step 1: Add state for the email→id map**

In `src/pages/Analytics.tsx`, find the existing `filteredEventContacts` state (around line 86). Immediately after it, add a new state hook:

```tsx
  const [eventContactIds, setEventContactIds] = useState<Record<string, string>>({})
```

This holds a flat `{ email: contact_id }` lookup for whatever events are currently being displayed in the campaign event list.

- [ ] **Step 2: Populate the map when events load**

Find the `useEffect` block that already runs when `events` or `filteredEventContacts` change. (Search for `setFilteredEventContacts(Array.from(emailMap.values()))` near line 158.) After all the existing event-loading logic, add a new `useEffect` that fires when the visible event list changes.

Insert this `useEffect` immediately after the existing event-deduplication effect (after line 158's closing brace, around line 160):

```tsx
  useEffect(() => {
    if (!selectedClient) return
    const visible = eventFilter === 'all' ? events.slice(0, 50) : filteredEventContacts
    const emails = Array.from(new Set(visible.map(e => e.email).filter(Boolean)))
    if (emails.length === 0) {
      setEventContactIds({})
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, email')
        .eq('client_id', selectedClient.id)
        .in('email', emails)
      if (cancelled || error || !data) return
      const map: Record<string, string> = {}
      for (const row of data) map[row.email] = row.id
      setEventContactIds(map)
    })()
    return () => { cancelled = true }
  }, [events, filteredEventContacts, eventFilter, selectedClient])
```

Notes:
- `cancelled` flag guards against React Strict Mode double-runs and rapid filter switches.
- `selectedClient` comes from the existing `useClient()` hook (already in this file — search for `const { selectedClient` to confirm).
- `eventFilter` is the existing all/open/click filter state already in the file.

- [ ] **Step 3: Wrap email in event row (line 2198)**

Find the event row's email cell. Replace this block:

```tsx
                          <td className="py-3 px-4 text-sm text-gray-900">
                            {event.email}
                          </td>
```

With:

```tsx
                          <td className="py-3 px-4 text-sm">
                            {eventContactIds[event.email] ? (
                              <Link
                                to={`/contacts/${eventContactIds[event.email]}`}
                                className="text-blue-600 hover:text-blue-800 hover:underline"
                              >
                                {event.email}
                              </Link>
                            ) : (
                              <span className="text-gray-900">{event.email}</span>
                            )}
                          </td>
```

When the email matches a contact, render a Link. When there's no match (deleted contact, or a recipient who was never in the contacts table), render plain text — no error, no broken link.

- [ ] **Step 4: Run the build**

```bash
npm run build
```

Expected: completes without errors.

- [ ] **Step 5: Manually verify in dev**

```bash
npm run dev
```

Then:

1. Sign in, select Alconox, go to Analytics, drill into a campaign that has open/click events.
2. Below the metrics, find the "Recent Events" table. Confirm at least some emails render as blue links.
3. Click one of the linked emails → confirm it routes to `/contacts/<id>`.
4. Use the open/click filter buttons above the table — confirm linkability still works after filter changes (the map should re-fetch).
5. (Optional) If you can identify an event whose contact has been deleted, confirm it renders as plain text without an error.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Analytics.tsx
git commit -m "$(cat <<'EOF'
Make emails in campaign event list link to contact pages

Build an email->contact_id lookup for the visible events when
the list loads or the filter changes. Emails that match a
contact render as a Link; emails with no matching contact
(deleted, or never a contact) render as plain text.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: BounceRecovery.tsx — bounce list with stopPropagation

**Files:**
- Modify: `src/pages/BounceRecovery.tsx`

The row is wrapped in a `<label>` that toggles a checkbox. The Link needs `stopPropagation` so clicking the email doesn't also flip selection.

- [ ] **Step 1: Add the Link import**

In `src/pages/BounceRecovery.tsx`, after line 1 (`import { useState, useEffect } from 'react'`), insert:

```tsx
import { Link } from 'react-router-dom'
```

- [ ] **Step 2: Wrap email in bounce contact row (line 373)**

Replace this line:

```tsx
                          <span className="text-sm font-medium truncate">{contact.email}</span>
```

With:

```tsx
                          <Link
                            to={`/contacts/${contact.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-sm font-medium truncate text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            {contact.email}
                          </Link>
```

The `truncate` class is preserved so long emails still get the existing layout treatment.

- [ ] **Step 3: Run the build**

```bash
npm run build
```

Expected: completes without errors.

- [ ] **Step 4: Manually verify**

```bash
npm run dev
```

Navigate to Bounce Recovery. For at least one row:

1. Click anywhere on the row *outside* the email → confirm the checkbox toggles.
2. Click the email itself → confirm you navigate to `/contacts/<id>` and the checkbox state did NOT change (verify by going back and seeing it unselected).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/pages/BounceRecovery.tsx
git commit -m "$(cat <<'EOF'
Link emails to contact pages in Bounce Recovery list

stopPropagation on the Link so clicking the email doesn't
also toggle the row checkbox.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Automations.tsx — sequence enrollment list with stopPropagation

**Files:**
- Modify: `src/pages/Automations.tsx`

The row's parent `<div>` has `onClick={() => toggleContact(contact.id)}`. Same stopPropagation pattern as Task 3.

- [ ] **Step 1: Add the Link import**

In `src/pages/Automations.tsx`, after line 1 (`import { useState, useEffect } from 'react'`), insert:

```tsx
import { Link } from 'react-router-dom'
```

- [ ] **Step 2: Wrap email in enrollment contact row (line 1975)**

Replace this line:

```tsx
                    <p className="text-sm text-gray-600">{contact.email}</p>
```

With:

```tsx
                    <p className="text-sm">
                      <Link
                        to={`/contacts/${contact.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        {contact.email}
                      </Link>
                    </p>
```

- [ ] **Step 3: Run the build**

```bash
npm run build
```

Expected: completes without errors.

- [ ] **Step 4: Manually verify**

```bash
npm run dev
```

Navigate to Automations. Open or create a sequence enrollment dialog where the contact-selection list with checkboxes appears (the path varies — usually "Enroll Contacts" on a sequence). For one row:

1. Click anywhere on the row *outside* the email → confirm the checkbox toggles.
2. Click the email → confirm navigation and that the checkbox did not toggle.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Automations.tsx
git commit -m "$(cat <<'EOF'
Link emails to contact pages in Automation enrollment list

stopPropagation so clicking the email doesn't toggle the
row's selection checkbox.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: AIAgents.tsx — drafts header, expanded preview, pipeline table, sent preview

**Files:**
- Modify: `src/pages/AIAgents.tsx`

Four sites in this one file. Three of them are simple wraps; the draft list header (line 475) sits inside an `onClick` that expands the draft, so it needs stopPropagation.

The contact id is reachable everywhere via `(draft as any).contact?.id` (drafts) or `(fc as any).contact?.id` (pipeline) — the API select includes `contact:contacts(id, email, ...)`, confirmed in `api/server.js:6345` and `api/server.js:6663`.

- [ ] **Step 1: Add the Link import**

In `src/pages/AIAgents.tsx`, after line 1 (`import { useState, useEffect, useCallback } from 'react'`), insert:

```tsx
import { Link } from 'react-router-dom'
```

- [ ] **Step 2: Wrap email in draft list header (line 475) — needs stopPropagation**

The parent `<button>` at line 461 has `onClick={() => { setExpandedDraft(...) ... }}`. Add stopPropagation.

Replace this line:

```tsx
                              <span>{(draft as any).contact?.email}</span>
```

With:

```tsx
                              {(draft as any).contact?.id ? (
                                <Link
                                  to={`/contacts/${(draft as any).contact.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-blue-600 hover:text-blue-800 hover:underline"
                                >
                                  {(draft as any).contact?.email}
                                </Link>
                              ) : (
                                <span>{(draft as any).contact?.email}</span>
                              )}
```

The `id` guard keeps things safe if the draft was loaded without the contact join (shouldn't happen, but cheap insurance).

- [ ] **Step 3: Wrap email in expanded draft preview "To:" line (line 538)**

This sits inside the expanded section, no parent click conflict — no stopPropagation needed.

Replace this line:

```tsx
                                    <strong>To:</strong> {(draft as any).contact?.email}
```

With:

```tsx
                                    <strong>To:</strong>{' '}
                                    {(draft as any).contact?.id ? (
                                      <Link
                                        to={`/contacts/${(draft as any).contact.id}`}
                                        className="text-blue-600 hover:text-blue-800 hover:underline"
                                      >
                                        {(draft as any).contact?.email}
                                      </Link>
                                    ) : (
                                      (draft as any).contact?.email
                                    )}
```

- [ ] **Step 4: Wrap email in pipeline table (line 657)**

The `<tr>` has no onClick — no stopPropagation needed.

Replace this line:

```tsx
                              <div className="text-xs text-gray-500">{(fc as any).contact?.email}</div>
```

With:

```tsx
                              <div className="text-xs">
                                {(fc as any).contact?.id ? (
                                  <Link
                                    to={`/contacts/${(fc as any).contact.id}`}
                                    className="text-blue-600 hover:text-blue-800 hover:underline"
                                  >
                                    {(fc as any).contact?.email}
                                  </Link>
                                ) : (
                                  <span className="text-gray-500">{(fc as any).contact?.email}</span>
                                )}
                              </div>
```

- [ ] **Step 5: Wrap email in sent draft preview "To:" line (line 751)**

Inside expanded section — no stopPropagation.

Replace this line:

```tsx
                                  To: {draft.contact?.email}
```

With:

```tsx
                                  To:{' '}
                                  {draft.contact?.id ? (
                                    <Link
                                      to={`/contacts/${draft.contact.id}`}
                                      className="text-blue-600 hover:text-blue-800 hover:underline"
                                    >
                                      {draft.contact?.email}
                                    </Link>
                                  ) : (
                                    draft.contact?.email
                                  )}
```

- [ ] **Step 6: Run the build**

```bash
npm run build
```

Expected: completes without errors.

- [ ] **Step 7: Manually verify**

```bash
npm run dev
```

Navigate to AI Agents. Confirm:

1. **Drafts tab** — emails in each draft card header are blue links. Click one → navigates to `/contacts/<id>`. Click the surrounding card area (not the email) → expands the draft instead.
2. **Drafts tab, expanded view** — in the email preview's "To:" line, the email is a clickable link.
3. **Pipeline tab** — emails under each contact name are blue links. Click → navigates.
4. **Sent tab** (if you have one with sent drafts) — expand an item; in the email preview's "To:" line, the email is a link.

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/pages/AIAgents.tsx
git commit -m "$(cat <<'EOF'
Link emails to contact pages across AI Agents views

Wrap emails in the drafts list header (with stopPropagation),
the expanded draft preview, the pipeline table, and the
sent-email preview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final cross-page sanity check

- [ ] **Step 1: Run the build one more time**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 2: Click-through every changed location in one session**

```bash
npm run dev
```

Walk through all 9 sites in order (Analytics × 5 → BounceRecovery → Automations → AIAgents × 4). For each: click the email, confirm it lands on the right contact's detail page, then back-button.

If any link routes to the wrong contact or to a 404, stop and investigate before considering the work complete.

- [ ] **Step 3: Done — no commit needed for this verification step.**

---

## Self-Review Notes

**Spec coverage:**
- ✓ Analytics × 5 (lines 1423, 1541, 1615, 2198, 2499) — Tasks 1 and 2.
- ✓ BounceRecovery — Task 3.
- ✓ Automations enrollments — Task 4.
- ✓ AIAgents × 4 — Task 5.
- ✓ Contacts.tsx:885 — verified during planning that it already navigates; documented as no-op in plan header.

**Placeholder scan:** No TBDs, TODOs, or "implement appropriately." Each step has either exact code or an exact command with expected output.

**Type consistency:** All sites use `to={\`/contacts/${...id}\`}` with the same className string. AIAgents uses `(draft as any).contact?.id` consistent with how the file already accesses joined fields.

**Scope:** One spec → one plan, focused, single feature. No risk of bloat.
