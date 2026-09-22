# Alconox: recover false hard-bounces before the next big send

Written 2026-09-22. Trigger: the mid-October 2026 Alconox Scoop. Calendar reminder set
for 2026-10-07.

## Why

Two summer sends went out on a cold Alconox IP (134.128.77.155, pool "Alconox") and
were refused by receiving servers at 25–33% instead of the normal <10%:

| Send | Delivered | Bounced |
|---|---|---|
| Parts Cleaning Conference 2026 - 3 (2026-06-29) | 13,576 | 6,570 |
| The Alconox Scoop — July 2026 (2026-07-09) | 28,895 | 9,572 |

The tool recorded those refusals as `bounce_status='hard'`, so those people get nothing
from us any more. SendGrid itself never suppressed most of them. Reconciliation dry run
on 2026-09-22 (`api/reconcile-bounces.js`, same method as the January cleanup):

| Flagged hard in our DB | 19,914 |
|---|---|
| Genuine (on SendGrid bounces/invalid list) | 3,229 |
| SendGrid blocks list (recoverable) | 88 |
| Not suppressed by SendGrid at all (false flags) | 16,597 |

## Checklist (about a week before the send)

1. **IP warmup.** Check `GET /v3/ips` with the Alconox key; `warmup` must be `true` for
   134.128.77.155. As of 2026-09-22 it was `false` and `/v3/ips/warmup` was empty.
   Enabled 2026-09-22 (`POST /v3/ips/warmup {"ip":"134.128.77.155"}`). SendGrid
   throttles that IP on its warmup schedule, so enable it weeks ahead, not the day of.
2. **Dry run again** (numbers drift as people engage or bounce):
   `node api/reconcile-bounces.js ea7f1422-2d20-4299-85a7-c1201e953409`
3. **Apply:**
   `node api/reconcile-bounces.js ea7f1422-2d20-4299-85a7-c1201e953409 --apply`
   `node api/reconcile-bounces.js ea7f1422-2d20-4299-85a7-c1201e953409 --apply-blocked`
   The 3,229 genuine bounces stay flagged.
4. **Ramp the send.** Sendable goes from roughly 28K to 45K. Send in batches and watch
   the first batch's bounce rate before releasing the rest. A cold-IP refusal shows up
   as `550 5.7.606 Access denied, banned sending IP` in SendGrid's bounce reasons.

Related: `docs/` January write-up lives in the Jax memory note
`jan-2026-cold-ip-bounce-event`; per-address reasons via `node api/sendgrid-lookup.js <email>`.
