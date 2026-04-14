# General AI Chatbot via Email

**Date:** 2026-04-13
**Status:** Approved

## Summary

Add a fallback path in the existing inbound email handler so that emails sent to `ai@reply.sagerock.com` (without a `+uuid`) are answered by the AI using SageRock's knowledge bases. This turns the email address into a general-purpose Q&A chatbot that also serves as a lead generation tool — new senders become contacts in the system automatically.

## Approach

**Approach A (selected):** Add a fallback branch in the existing `/api/webhook/inbound-email` handler. No new endpoints, no DNS or SendGrid Inbound Parse changes needed.

## Design

### Trigger

When an email arrives at `/api/webhook/inbound-email` and the To address does NOT contain a `+uuid` (i.e., the existing regex `ai+([a-f0-9-]+)@reply.sagerock.com` does not match), the fallback path activates instead of silently dropping the email.

This covers any email to `@reply.sagerock.com` that doesn't have the `ai+{uuid}` format — most commonly `ai@reply.sagerock.com`.

### Contact Resolution

1. Parse sender email and display name from the From header (e.g., `"John Smith <john@example.com>"` → email: `john@example.com`, first: `John`, last: `Smith`)
2. Look up sender email in `contacts` table under the SageRock client (`PUBLIC_SIGNUP_CLIENT_ID` env var)
3. **If found:** Use existing contact record as-is
4. **If not found:** Create new contact with:
   - `email`, `first_name`, `last_name` parsed from From header
   - `tags: ['ai-chatbot']`
   - `client_id` from `PUBLIC_SIGNUP_CLIENT_ID`
   - `unsubscribed: false`

### AI Reply Generation

1. Load all active knowledge bases for the SageRock client from `knowledge_bases` table
2. Concatenate them into one context block for Claude
3. Check for existing conversation history for this contact in `email_conversations` — if present, include it (last 20 messages) for continuity
4. Use Claude `claude-sonnet-4-6` with a system prompt similar to the existing `generateAndSendAiReply`, instructing the AI to:
   - Answer using the knowledge base content
   - Not make up links, prices, or details not in the knowledge base
   - Return JSON with `{subject, body, escalate}` fields
   - Flag `escalate: true` for questions beyond KB scope
5. Claude returns `{subject, body, escalate}`

### Email Response

- **To:** sender's email
- **From:** `ai@sagerock.com` / `SageRock AI Assistant`
- **Reply-To:** `ai+{contact-uuid}@reply.sagerock.com` — funnels future replies into the existing UUID-based handler with full conversation history
- **BCC:** `sage@sagerock.com`
- Send via `CONTACT_SENDGRID_API_KEY`

### Forward Inbound to Sage

Forward the inbound email to `sage@sagerock.com` for visibility, same pattern as the existing handler.

### Conversation Logging

- Log inbound message to `email_conversations` (direction: `inbound`, ai_generated: `false`)
- Log AI reply to `email_conversations` (direction: `outbound`, ai_generated: `true`)

### Escalation

If Claude sets `escalate: true`, send a notification email to `sage@sagerock.com` with:
- The contact's original message
- The AI's reply (already sent)
- Contact info for follow-up

Same pattern as the existing escalation flow.

### Future Multi-Tenant Considerations

Currently hardcoded to SageRock (`PUBLIC_SIGNUP_CLIENT_ID`). When another client (e.g., Alconox) wants their own general chatbot, the routing logic would need to determine which client based on the To address or domain. This is out of scope for now but the contact resolution and KB loading are already client-scoped, so the extension point is clear.

## Code Changes

All changes are in `api/server.js`, specifically the `/api/webhook/inbound-email` handler (around line 3018):

1. **Where the `contactId` null check currently returns early (line ~3044):** Replace with the fallback path that does contact resolution, AI reply, logging, and forwarding
2. **Reuse existing functions:** `loadKnowledgeBase()` for KB loading, similar Claude prompt pattern as `generateAndSendAiReply()`
3. **New helper (optional):** Extract the fallback logic into a `handleGeneralChatbotEmail()` function to keep the main handler readable

## Data Flow

```
Email to ai@reply.sagerock.com
  → SendGrid Inbound Parse webhook
  → /api/webhook/inbound-email handler
  → No +uuid match → fallback path
  → Look up sender in contacts (SageRock client)
    → Found: use existing contact
    → Not found: create contact with 'ai-chatbot' tag
  → Forward inbound to sage@sagerock.com
  → Log inbound to email_conversations
  → Load SageRock knowledge bases + conversation history
  → Generate AI reply via Claude
  → Send reply (from: ai@sagerock.com, reply-to: ai+{uuid}@reply.sagerock.com)
  → Log outbound to email_conversations
  → If escalated: notify sage@sagerock.com
  → Future replies from this person → existing UUID handler
```
