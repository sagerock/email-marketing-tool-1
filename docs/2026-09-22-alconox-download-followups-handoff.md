# Handoff: restart Alconox download follow-ups from Salesforce (2026-09-22)

From: Jax session in `sagerock/clients/alconox` (built the Prospect Activity sync, commit
`41107b3`). To: the email-tool session that diagnosed the stopped follow-ups. Sage approved
building the bridge below. Meeting notes and wider plan:
`/mnt/d/dev/sagerock/clients/alconox/meetings/2026-09-22-salesforce-marketing-connection.md`.

## Confirmed situation

- White Paper and Aqueous Cleaning Handbook agents stopped enrolling because alconox.com's
  Gravity download forms were replaced (2026-09-19) by member-download pages. Free Sample is fine.
- Member downloads are recorded in Salesforce `Prospect_Activity__c` (Channel = Resource
  Download, `Source_Detail__c` = resource name, `Web_Page__c` = member-download URL, linked by
  `Lead__c`/`Contact__c`). Synced into `salesforce_prospect_activities` by
  `api/salesforce-prospect-activities.js`, daily 06:00 UTC and on manual sync.

## Build: bridge download activities → the existing agents

Content stays exactly as today. Only the trigger source changes.

1. For each **new** activity with `channel = 'Resource Download'`, enroll the matching contact
   through the same enroll + generate path the Gravity webhook uses:
   - `source_detail = 'Aqueous Cleaning Handbook'` → Aqueous Cleaning Handbook Follow-up
     (`743a4aa9-…`)
   - any other resource → White Paper Follow-up (`30bca9c2-…`)
2. **Idempotent per activity.** Record which activity (`salesforce_prospect_activities.id` or
   `salesforce_id`) produced an enrollment so re-syncs never enroll twice. Several downloads by one
   person must not start parallel sequences in the same agent; keep the existing contact spacing
   and leases (migrations 099/100).
3. **Cutover, no backfill.** Only enroll activities with `touchpoint_at` after the deploy time.
   Every row so far is internal/test (sage@sagerock.com ×2, dan@914digital.com = the site's
   developer, plus 1 AI Chat row). Also skip `@alconox.com` and contacts tagged `Alconox Internal`.
4. **Resource link.** The old path took it from the form. Use the activity's `Web_Page__c`
   (member page; the person has an account, so the login wall is fine).
5. **Latency.** Daily sync means step 1 lands up to a day late. The Prospect Activity query is
   cheap and incremental, so consider running just that piece more often (e.g. hourly) instead
   of waiting for an Alconox-side webhook.
6. Tests + a dry run against production data before enabling, then report to Sage.

## Not in this task (waiting or later)

- Salesforce campaign ID + Lead/Contact ID in every email (hidden block + visible `Ref:` line).
  Waiting on Cheyenne's format answer (asked 2026-09-22 in the "Accessing Email Engagement in
  Salesforce" thread). Build the bridge so adding these later is easy.
- AI Chat case follow-ups (Case where `Case_Origin_Subtype__c = 'AI Chat'`). Tailored to the chat,
  **never answers questions**, points to Ask Alconox / cleaning@alconox.com. Stacy approves the
  template first.

## Worth telling Sage / Alconox

- **Zero real member downloads since launch.** All 3 Resource Download rows (9/19–9/22) are
  internal tests, versus roughly 1–2 per day through the old forms. Either the account wall is
  suppressing downloads or some downloads aren't writing activities. The campaign-roster check
  shows no gap between the "Resource Download 2026" campaign and the activity rows.
- The 9/15 and 9/18 step 2/3 backlog burst (median 31 days late) may produce a few confused
  replies at cleaning@alconox.com.
