# Handoff: Alconox AI Chat case follow-ups (2026-09-22)

From: Jax session in `sagerock/clients/alconox`. To: the email-tool session that built the
download bridge (`339f58d`). Sage approved building this on 2026-09-22. Everything lives in the
existing **AI automation** (`ai_followup_config` agents), same as the download follow-ups.
Wider plan: `/mnt/d/dev/sagerock/clients/alconox/meetings/2026-09-22-salesforce-marketing-connection.md`.

## Source data

The alconox.com AI chat writes a **Closed Case** in Salesforce:

- `Case` where `Case_Origin_Subtype__c = 'AI Chat'`, `Origin = 'Web'`.
- `Description` = full transcript (`[timestamp] Visitor: …` / `Alconox: …` lines), then `---`,
  `Pages: <urls>`, `IP: <ip>`, `Session: <id>`.
- Person: `SuppliedEmail`, `SuppliedName`, `SuppliedCompany`, `Lead__c` (or `ContactId`).
- Each chat also writes a `Prospect_Activity__c` with Channel = AI Chat (already synced) and
  adds the person to campaign "AI Chat 2026" (`701Nv00000kUke6IAC`).
- Our API user can read Case (granted 2026-09-22). Examples: case `00001054`
  (alessandra@aloiaaerospace.com, chat 9/16, the only real one so far), `00001053` (Cheyenne's
  test "Jane Doe", cheyenne@cloudadoptionsolutions.com; exclude).

## Build

1. **Sync AI Chat cases** on the same hourly schedule as downloads (incremental by
   `LastModifiedDate`). Store the transcript, pages, person, and case number. **Strip the IP** and
   don't store it. Service-role writes, client-scoped read, like migration 101.
2. **New agent "AI Chat Follow-up"** (Alconox), enrolled per case, idempotent per case ID,
   same cutover-at-enable pattern as downloads (no backfill), same internal/test exclusions.
3. **Content: keep it very general** (Sage, 2026-09-22):
   - Thank them for chatting with Alconox; at most a light, non-technical mention of the
     topic (e.g. "about cleaning your parts washer").
   - **Never answer or restate technical guidance.** No product recommendations, dilutions,
     times, or compatibility claims, even if the chat covered them.
   - Close with the invitation: if they have any questions, reply to this email or use
     **Ask Alconox** (`https://alconox.com/ask-alconox/`).
   - Reply-To `cleaning@alconox.com` (a human answers). House subject line
     `<short phrase> — Alconox, LLC`, under ~60 chars. SUPER short.
   - One email, not a 3-step sequence, unless Sage says otherwise.
4. **Review before send: Stacy, Michelle, and Sage review every chat follow-up.**
   `auto_send = false`. Stacy and Michelle have no mail.sagerock.com login, so the review has to
   reach them by email: for each draft, send the three a review email (draft subject + body,
   chat transcript for context, case number) with one-click **Approve and send** / **Skip**
   links (signed, single-use, expiring). Nothing sends until someone approves. The Thinkific
   lead notice (`server.js` ~3259) is the existing notification pattern.
   - Reviewers: ssilverstein@alconox.com, mmodica@alconox.com, sage@sagerock.com.
   - **Reply-to-approve (Sage, 2026-09-22), like the Ask agents.** The review email comes from
     an address on `email.alconox.com` (inbound already routes through SendGrid Inbound Parse to
     this tool; use a per-draft address or token, e.g. `review+<token>@email.alconox.com`).
     Reviewers can just reply:
     - "send it" / "approve" → sends the draft as-is
     - "skip" → cancels it
     - anything else → treated as a revision note: regenerate with the note applied and send a
       fresh review email. Never send on an ambiguous reply.
   - Guardrails: act only on replies from the three reviewer addresses **with passing SPF/DKIM**
     in the Parse payload, matching an open draft token; first decision wins and the other
     reviewers get a short "already sent by X" note. Keep the one-click links as a fallback.
   - Do **not** switch to auto-send.
5. Tests, a dry run against case `00001054`, then send Sage one real review email built from it
   (to Sage only) so he can see what Stacy and Michelle will get.

## Leave out / later

- Campaign + Lead/Contact IDs in the email: waiting on Cheyenne's format (asked 9/22). Keep the
  send path ready for a hidden block + visible `Ref:` line.
- Open question to Cheyenne: the 9/16 chat's case appeared 9/22. If cases routinely lag days,
  the follow-up copy should not say "today" or "recently".

## Built (2026-09-22, email-tool session)

- `api/ai-chat-followups.js` + `api/ai-chat-followups.test.js` (10 unit tests). Sync,
  enrollment, review email, signed review links, review page/actions.
- Migration `103_ai_chat_case_followups.sql`, installed on production via
  `scripts/apply-ai-chat-migration.mjs --apply`: table `salesforce_ai_chat_cases` (IP
  stripped before storage, never a column), `ai_followup_config.trigger_ai_chat` /
  `chat_trigger_since` / `review_notify_emails`, `ai_followup_contacts.source_case_id`
  (unique), `ai_followup_drafts.reviewed_by_email` / `review_notified_at`, and the Alconox
  agent row "AI Chat Follow-up" (enabled, `auto_send=false`, one email, prompt in the
  migration). Its `trigger_tag` is a value no source code contains, so the Salesforce
  source-code enrollment hook never matches it.
- `api/server.js`: cases sync + enroll + reviewer notification after the manual and daily
  Salesforce syncs and on the hourly :20 job; review routes mounted; the auth middleware
  exempts `/api/ai-followup/review/*` (signed, reviewer-bound tokens are the auth).
- **One-click deviation, on purpose:** the emailed link opens a review page; approving or
  skipping is a second click that POSTs. A GET that sent mail would let Barracuda/Proofpoint
  style link scanners "approve" drafts. Links are HMAC-signed per reviewer, expire in 7 days,
  and become inert once the draft is sent or skipped (single use).
- Only the visitor's own messages reach the model (`Topic`), never the bot's answers, so the
  follow-up cannot restate technical guidance. Prompt also bans "today/recently".
- Dry run against case `00001054`: synced, routed to the agent, and initially skipped as
  `hard_bounced`. That flag came from the 2026-01-22 cold-IP blast (SendGrid recorded
  "550 No Such User Here" that day) but the person typed this address into the chat on
  2026-09-16, so the SendGrid bounce entry and the DB flag were cleared for this one address.
- First live sample: reviewers temporarily set to `sage@sagerock.com` only; cutover set to
  2026-09-15 so case 00001054 qualifies. The production server's next hourly run enrolls,
  drafts, and emails Sage the review. **Next:** once Sage OKs the format,
  `node scripts/ai-chat-followups.mjs reviewers ssilverstein@alconox.com,mmodica@alconox.com,sage@sagerock.com`.
- Not done: campaign/person IDs in the email (waiting on Cheyenne).
