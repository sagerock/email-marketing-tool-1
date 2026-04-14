---
name: AI Email Assistant - Multi-Tenant Rollout Guide
description: What's needed to replicate the AI email assistant (currently SageRock-only) for a new client like Spring Garden Waldorf School
type: project
---

## AI Email Assistant: Replicating for a New Client

The AI email assistant (inbound parse → AI reply → conversation logging) currently works for SageRock but has hardcoded values that need to be made configurable before rolling out to another client.

### What's Already Multi-Tenant (no changes needed)
- `knowledge_bases` table — per client_id, managed via UI
- `ai_followup_config` table — per client, has `from_email`, `from_name`, `reply_to`, `bcc_email` fields
- Gravity Forms webhook (`/api/webhook/gravity-forms/:webhookKey`) — routes by webhook key tied to AI agent config
- `email_conversations` table — scoped by client_id
- Contact management, tags — all scoped by client_id

### What's Hardcoded to SageRock (needs work)
1. **Inbound email domain** — `reply.sagerock.com` hardcoded in regex at line ~3041 and reply-to addresses at lines ~3251, ~5322
2. **From/BCC in inbound handler** — `ai@sagerock.com` and `sage@sagerock.com` hardcoded at lines ~3107-3108, ~3256-3257
3. **From/BCC in welcome email sender** — hardcoded at lines ~5326-5327
4. **Escalation/notification recipient** — always `sage@sagerock.com`
5. **Public signup endpoint** — single `PUBLIC_SIGNUP_CLIENT_ID` env var, hardcoded tags `ai-for-business` and `youtube-lead`
6. **SendGrid API key for AI emails** — single `CONTACT_SENDGRID_API_KEY` env var (campaign sending already uses per-client keys from DB)

### Steps to Make Multi-Tenant
1. **Inbound parse handler**: Look up client/config from the incoming `To` address instead of assuming SageRock. The `ai_followup_config` already has `reply_to` — use that to match.
2. **Email sending**: Read `from_email`, `from_name`, `reply_to`, `bcc_email` from `ai_followup_config` instead of hardcoded values. This applies to both the inbound reply handler (`generateAndSendAiReply`) and the welcome email sender (`sendAiWelcomeEmail`).
3. **Reply domain**: Either set up a per-client reply subdomain with SendGrid Inbound Parse, or use a shared domain (e.g., `reply.mail.sagerock.com`) and route by the `+` address portion.
4. **SendGrid API key**: Either use a shared key or add an AI-specific SendGrid key to the `clients` or `ai_followup_config` table.
5. **Public signup**: Make the endpoint accept a `client_id` or config identifier so it's not locked to one client.
6. **Notification emails**: Use `bcc_email` from config for escalation notifications instead of hardcoded `sage@sagerock.com`.

### For a New Client (e.g., Spring Garden Waldorf School)
1. Create the client in the platform
2. Set up their knowledge base via the UI
3. Create an `ai_followup_config` record with their from/reply-to/BCC preferences
4. Configure their form (Gravity Forms or other) to hit the webhook endpoint with their webhook key
5. Set up DNS/SendGrid Inbound Parse for their reply domain (or use shared domain)
6. Test the full loop: form submission → welcome email → reply → AI response → escalation

**Why:** User (Sage) wants to offer this as a service to other clients. The data model is mostly ready; it's the email-sending code paths that need to read from config instead of hardcoded values.

**How to apply:** When asked to set up AI email for a new client, reference this checklist and tackle the hardcoded items first.
