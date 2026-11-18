# Webinar registration

Sage approved this on November 18, 2026 for the free December 8 webinar (Rocky Lewis of SageRock and Vicki Larson of Alma Partners, "Planning for 2027-28: Advancement, Admissions and Marketing", 3:00-3:45pm ET on Zoom). It authorizes the registration page and its one confirmation email, not reminder campaigns or marketing to registrants.

## Flow

`sagerock.com/budget-webinar/` posts to its same-origin Pages proxy (`functions/api/budget-webinar.js` in sagerock-website), which forwards production requests to `POST https://mail.sagerock.com/api/public/webinar-registration`. Preview hosts validate but never forward. The handler (`api/public-webinar-registration.js`) accepts only events in its server-side `EVENTS` table and refuses registrations after the event ends (410).

Migration 125's `record_webinar_registration` does two things in one transaction:

- Merges the SageRock contact like the intake guide: fills only empty profile fields (company = school, job_function = role, utm_params), appends the submission to `form_submissions`, adds the tag `webinar-<event>` (here `webinar-budget-2026-12-08`) and, with optional consent, `webinar-<event>-opt-in`. A new contact without consent is `unsubscribed=true` so blanket SageRock marketing skips them. Existing unsubscribe and bounce flags never change.
- Inserts one `webinar_registrations` row per tenant, event and email (`ON CONFLICT DO NOTHING`). That row holds name, school, role, heard-from (`alma`/`sagerock`/`other`), UTM attribution, consent, and the confirmation status. Only the request that created the row sends the confirmation, so a second signup with the same email, a retry, or a double click never sends a second one; the first registration's answers are kept.

The confirmation is fixed content (nothing from the form appears in it), from and reply-to `jax@sagerock.com`, signed `- Jax`, with an `.ics` file (METHOD:PUBLISH, UID `<event>@sagerock.com`) and a Google Calendar link. It says the Zoom link comes in the reminder emails; no Zoom link is invented. Open and click tracking are off. Status is `sent` on provider acceptance, `failed` on a known 4xx, `uncertain` on a timeout, `suppressed` for a known hard bounce. None of these is retried automatically; reconcile from SendGrid evidence, never by resending blindly.

Same IP limiter as the intake guide (8 per 15 minutes). Neither anon nor authenticated can call the function or read the table.

## Reminders (not built)

The registrant list is `webinar_registrations WHERE event='budget-2026-12-08'` (also the contact tag `webinar-budget-2026-12-08`). **The campaign sender and sequence scheduler both skip `unsubscribed=true` contacts**, and new registrants who left marketing unticked are created that way. A tag-filtered campaign would therefore miss most registrants. Reminders and the recording are event mail the registrant asked for, so send them from `webinar_registrations` (same fixed-content, one-per-row ledger pattern as the confirmation), excluding hard bounces and anyone who unsubscribed after registering (`contacts.unsubscribed_at` later than the registration). Decide that path with the reminder build; do not flip registrants to `unsubscribed=false` to make a campaign reach them.

Lead ownership (agreed with Alma): a school belongs to whoever invited it; a school on both lists is Alma's. `heard_from` and `attribution.utm_source` (`alma` on Alma's newsletter link) are recorded for that; the ownership decision itself is made when the list is reviewed, not in code. Don't market SageRock to Alma-attributed registrants without agreeing it with Vicki, even if they ticked the SageRock consent box.

## Validation

`node --test api/public-webinar-registration.test.js` (8 tests: validation, fixed content and calendar file, duplicate and simultaneous signups, failed/ambiguous sends, lost status write, honeypot, post-event refusal, hard bounce). `node scripts/webinar-registration.pgtest.mjs` runs migration 125 in a disposable local cluster (contact merge, consent, duplicate registration, preserved unsubscribe/bounce, validation, role permissions); it never touches the application database.

## Go-live / rollback

1. `node scripts/apply-webinar-registration-migration.mjs` (check), then `--apply`.
2. Merge and deploy the email tool (Railway builds frontend and backend from this repo).
3. Then merge the website PR. Verify with one internal registration and a second identical one (expect `already_registered`, no second email).

To stop: revert the website page/proxy, or remove the route. Keep migration 125 and its rows: they are the registrant list and the duplicate guard.
