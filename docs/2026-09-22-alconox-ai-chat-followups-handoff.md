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
