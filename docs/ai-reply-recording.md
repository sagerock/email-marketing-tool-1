# Recording forwarded AI follow-up replies

The operator tool `scripts/record-ai-reply.mjs` records a reviewed human response
against the exact sent AI draft. Use it when a client forwards replies from their
ordinary inbox. In **Engagement → Replies**, the response appears with its original
time. **AI Agents → Sent Emails → Delivery & Engagement** shows the `reply` event
on the matching send. No application deployment or database migration is required.

Status (2026-09-15): operator import and report tested against a disposable
PostgreSQL database, then verified with a scoped live import and repeat-import
check. Automatic inbox capture remains outstanding. Code is retained locally;
the production branch also contains earlier outgoing work outside this task.

## Review and record

Read the actual customer response. Exclude staff forwarding notes, out-of-office
messages, bounces and quoted outbound messages. Match the original sender to a
contact in the client and match the outbound message ID in the thread's References
to `ai_followup_drafts.sendgrid_message_id`. Do not guess based on the latest send:
one contact can have multiple agents, steps, or duplicated sends.

Create a private JSON file outside Git (for example `reply.local`, ignored here):

```json
{
  "clientId": "CLIENT_UUID",
  "draftId": "SENT_DRAFT_UUID",
  "senderEmail": "customer@example.com",
  "originalMessageId": "<original-customer-message@example.com>",
  "outboundMessageId": "EXACT_STORED_SENDGRID_MESSAGE_ID",
  "sourceUrl": "https://mail.google.com/mail/u/0/#all/FORWARDED_MESSAGE_ID",
  "receivedAt": "2026-09-15T14:10:00-04:00",
  "body": "Customer's actual response, without the forwarded wrapper or quoted send.",
  "kind": "human_reply",
  "recordedBy": "Operator name"
}
```

Use the **original customer's** Message-ID, not a forward's Message-ID. Record the
customer's response time with an explicit UTC offset; forwarded headers sometimes
only establish minute precision. Keep the source email for verification. Missing
or ambiguous attribution needs human review before importing.

```sh
node --env-file=.env scripts/record-ai-reply.mjs record reply.local
node --env-file=.env scripts/record-ai-reply.mjs record reply.local --apply
```

The first command validates inside a transaction and rolls back. Apply atomically
adds a `reply` event to `ai_followup_analytics`, an inbound `email_conversations`
entry with provenance, the contact's `Replied` tag / `last_replied_at`, and the
matching AI enrollment's `replied` flag. Existing tags and later reply timestamps
survive. A client-scoped hash of the original reply ID prevents duplicate imports;
conflicting attribution fails rather than moving an existing reply. No email is
sent and no forwarding or scheduling settings change.

Credentials follow the existing migration tools: `VITE_SUPABASE_URL` in `.env`,
and `SUPABASE_ACCESS_TOKEN` or `~/.supabase/access-token`. The Supabase management
query API executes the transaction. Keep actual reply JSON and reports private.

## Response rate

```sh
node --env-file=.env scripts/record-ai-reply.mjs report CLIENT_UUID \
  2026-09-15T00:00:00-04:00 2026-09-16T00:00:00-04:00
```

The end is exclusive. The report counts replies received through the run time
against emails sent in that window, including replies received on later days.
It shows the overall cohort and each agent:

- Sent emails: stored drafts with status `sent` (provider accepted, not a delivery guarantee).
- Recipients: distinct contacts sent those emails; multiple sends count once.
- Responders: distinct contacts with a `reply` event on those exact sends.
- Recorded response rate: responders / recipients × 100. No recipients yields null.

This is **provisional while inbox coverage is incomplete**. Unreported replies
are unknown. Legacy contact-level reply flags cannot prove which send was answered
and are not counted. Auto-responses, bounces and other event types are excluded.

## Remaining automatic capture work

Alconox's active AI agents currently use `cleaning@alconox.com` as Reply-To.
That bypasses the existing branded-domain receiver. This operator workflow covers
reviewed forwarded replies; it does not install a Gmail watcher or alter Reply-To.
Automatic capture needs exact send attribution, deduplication and reliable inbox
delivery in `api/campaign-replies.js` before rollout. The receiver currently logs
contact-level conversations but does not create attributed AI `reply` events.

Do not treat `ai_followup_contacts.replied` as a confirmed automation stop: the
current scheduler does not check that flag. This tool records evidence only and
does not change enrollment statuses.

## Verification

```sh
node --test scripts/ai-reply-records.test.mjs
node scripts/ai-reply-records.pgtest.mjs
```

The PostgreSQL test creates and removes a disposable cluster. It checks rollback,
repeat imports, conflicting attribution, tenant/sender checks, timestamps,
preservation of existing data, and recipient-based cohort reporting.
