# Webinar registration

Sage approved this on November 18, 2026 for the free December 8 webinar (Rocky Lewis of SageRock and Vicki Larson of Alma Partners, "Planning for 2027-28: Advancement, Admissions and Marketing", 3:00-3:45pm ET on Zoom). It authorizes the registration page and its one confirmation email, not reminder campaigns or marketing to registrants.

## Flow

`sagerock.com/budget-webinar/` posts to its same-origin Pages proxy (`functions/api/budget-webinar.js` in sagerock-website), which forwards production requests to `POST https://mail.sagerock.com/api/public/webinar-registration`. Preview hosts validate but never forward. The handler (`api/public-webinar-registration.js`) accepts only events in its server-side `EVENTS` table and refuses registrations after the event ends (410).

Migration 125's `record_webinar_registration` does two things in one transaction:

- Merges the SageRock contact like the intake guide: fills only empty profile fields (company = school, job_function = role, utm_params), appends the submission to `form_submissions`, adds the tag `webinar-<event>` (here `webinar-budget-2026-12-08`) and, with optional consent, `webinar-<event>-opt-in`. A new contact without consent is `unsubscribed=true` so blanket SageRock marketing skips them. Existing unsubscribe and bounce flags never change.
- Inserts one `webinar_registrations` row per tenant, event and email (`ON CONFLICT DO NOTHING`). That row holds name, school, role, heard-from (`alma`/`sagerock`/`other`), UTM attribution, consent, and the confirmation status. Only the request that created the row sends the confirmation, so a second signup with the same email, a retry, or a double click never sends a second one; the first registration's answers are kept.

The confirmation is fixed content (nothing from the form appears in it), from and reply-to `jax@sagerock.com`, signed `- Jax`, with an `.ics` file (METHOD:PUBLISH, UID `<event>@sagerock.com`) and a Google Calendar link. It says the Zoom link comes in the reminder emails; no Zoom link is invented. Open and click tracking are off. Status is `sent` on provider acceptance, `failed` on a known 4xx, `uncertain` on a timeout, `suppressed` for a known hard bounce. None of these is retried automatically; reconcile from SendGrid evidence, never by resending blindly.

Same IP limiter as the intake guide (8 per 15 minutes). Neither anon nor authenticated can call the function or read the table.

## Reminders and follow-up (built 2026-11-23, Jax item #4351)

`api/webinar-mailings.js` + migration 128 (`webinar_mailings`, one row per registration and kind, the reservation that makes
each email send at most once). Kinds: `reminder-day` (Dec 7, window 8am ET to midnight), `reminder-hour` (Dec 8, 1:45-3:00pm ET)
and `followup` (after 3:45pm Dec 8). Fixed content from jax@sagerock.com, signed `- Jax`, tracking off. Recipients come from
`webinar_registrations` (not tag campaigns, which skip `unsubscribed=true`), minus the two test rows
(`sage+webinar-test@`, `sage+webinar-test2@`), hard bounces and anyone whose `unsubscribed_at` is later than their registration.
A send outside its window is refused (`not_due`); a timeout is recorded `uncertain` and never retried.

Run on the Railway backend (`railway ssh`), from `api/`, dry run first:

    node scripts/webinar-mailing.js reminder-day --join=<Zoom meeting Invite Link>        # preview
    node scripts/webinar-mailing.js reminder-day --join=<link> --send [--only=addr]
    node scripts/webinar-mailing.js followup --recording=<url> --checklist=<pdf url> --send

The Zoom link is the meeting 863 7184 9307 "Invite Link" (with passcode) from the SageRock Zoom; it is passed on the command
line, never stored here. The checklist draft is `sagerock/clients/alma-partners/budget-webinar/planning-checklist-2027-28.md`.
Go-live: apply migration 128, merge and deploy, dry-run. Tests: `node --test api/webinar-mailings.test.js`,
`node scripts/webinar-registration.pgtest.mjs` (also covers 128).

Lead ownership (agreed with Alma): a school belongs to whoever invited it; a school on both lists is Alma's. `heard_from` and `attribution.utm_source` (`alma` on Alma's newsletter link) are recorded for that; the ownership decision itself is made when the list is reviewed, not in code. Don't market SageRock to Alma-attributed registrants without agreeing it with Vicki, even if they ticked the SageRock consent box.

## Validation

`node --test api/public-webinar-registration.test.js` (8 tests: validation, fixed content and calendar file, duplicate and simultaneous signups, failed/ambiguous sends, lost status write, honeypot, post-event refusal, hard bounce). `node scripts/webinar-registration.pgtest.mjs` runs migration 125 in a disposable local cluster (contact merge, consent, duplicate registration, preserved unsubscribe/bounce, validation, role permissions); it never touches the application database.

## Go-live / rollback

1. `node scripts/apply-webinar-registration-migration.mjs` (check), then `--apply`.
2. Merge and deploy the email tool (Railway builds frontend and backend from this repo).
3. Then merge the website PR. Verify with one internal registration and a second identical one (expect `already_registered`, no second email).

To stop: revert the website page/proxy, or remove the route. Keep migration 125 and its rows: they are the registrant list and the duplicate guard.
