# Intake guide delivery

Sage asked on November 13, 2026 to enable email delivery through the SageRock email tool for the already-published `/law-firm-intake-guide/` page. This authorizes the requested resource email and its deployment, not a marketing campaign or outreach to past downloaders.

## Flow

The website's same-origin Pages proxy validates the form and forwards it to `POST https://mail.sagerock.com/api/public/intake-guide`. Preview hosts never forward. The email tool uses migration 123's atomic contact merge to preserve existing profile fields, tags, unsubscribe and bounce settings; it records firm size, explicit optional marketing consent, consent wording/version and bounded UTM attribution. New contacts without marketing consent have `unsubscribed=true` to exclude them from blanket marketing sends. Only the specifically requested, fixed-content resource email is attempted; no SendGrid suppression bypass is used, and known hard bounces are skipped.

The handler inserts an `intake_guide_deliveries` reservation unique to tenant, normalized email, resource and UTC date. Only the insert winner sends. The message is from/replies to `jax@sagerock.com`, signed `- Jax`, with SageRock's existing per-client SendGrid credential and IP pool. No BCC, AI-generated content, attachments or externally supplied links. The download points to the website's cookieless counter with source `intake-guide-email`. Email open and provider click tracking are disabled.

Provider acceptance is `sent` in the ledger (not proof of inbox delivery); `provider_message_id` permits verification. A known provider rejection is `failed`; timeouts/ambiguous failures are `uncertain`. Neither clears the reservation or automatically retries. Repeated requests return `already_sent`, `pending` or `unavailable` and keep the immediate download available. Another deliberate request on a later UTC day can request another copy. A failed database status update leaves the reserved row to prevent duplicates; reconcile it using provider evidence, never by resending blindly.

The endpoint has the same IP-limiter approach as the existing public-list endpoint, at 8 requests/15 minutes; the Pages proxy forwards the Cloudflare-provided visitor IP for that limiter. Per-recipient daily uniqueness is durable across processes. Input, content and tenant are bounded; neither anon nor authenticated roles can call the contact RPC or read the delivery ledger. No background worker or cron was added.

## Validation

22 focused Node tests (new delivery handler, existing list signup and existing Sage-note form), backend syntax, frontend production build, SendGrid sandbox validation (200, no send). Migration 123 installed; an SQL transaction tested contact merging, explicit consent, preservation of unsubscribe/hard-bounce settings, reservation uniqueness and role permissions, then rolled back all test rows. Website proxy tests and browser delivery-status checks run in its own repository.

## Operations / rollback

Deploy the email tool first; then the website may switch its proxy and copy. Both Railway frontend and backend services build the same source. Production verification uses one internal SageRock address and checks the duplicate response without sending again. The original landing-page publication check was a CRM-only request, not a delivery.

To stop new delivery, revert the website proxy/copy to its prior CRM-only path and disable/revert this endpoint. Keep migration 123 and its ledger: deleting reservations could permit duplicate sends, and a code rollback cannot retract sent email. Marketing remains separate; use explicit opt-in plus existing suppression status when preparing a later audience. Do not enroll these downloaders in `solo` or `law-firm-workspace` automatically.
