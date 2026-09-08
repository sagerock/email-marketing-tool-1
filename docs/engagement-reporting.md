# Verified engagement reporting

Migration `091_engagement_reporting_snapshots.sql` and
`api/engagement-reporting.js` add a reporting-only Salesforce path for the
Engagement page, its digest, and Athena. The path queries Salesforce Leads and
Contacts by exact record ID for cached people, or enumerates a bounded explicit
cohort for recent-lead and inactivity questions. It never calls the normal sync,
does not advance `clients.last_salesforce_sync`, and has no tagging, enrollment,
campaign, send, Task, owner, or other Salesforce-write behavior.

Each refresh stores a run manifest and immutable per-record evidence. A returned
null clears a stale cached `LastActivityDate`; an omitted/inaccessible ID remains
unresolved and does not become false inactivity. Classification is centralized in
`engagement_evidence_classification()` and keeps verified human outbound,
Salesforce's date-only rollup, automation, genuine replies, ambiguous evidence,
and coverage separate. Each verified snapshot also enumerates the authoritative
visible Opportunity set and freezes exact-ContactId pipeline signals. Cached
records that disappear become unresolved rather than silently closed; unavailable
Opportunity access or linkage makes coverage partial instead of producing zero.

The Engagement page returns partial refresh manifests so unresolved people remain
visible as `unable to verify`. The scheduled digest remains fail-closed and is
withheld unless the entire bounded dashboard cohort resolves.

Athena calls `POST /api/internal/engagement/report`. The request cannot select a
tenant: the server binds it to `ASK_ENGAGEMENT_CLIENT_ID` and authenticates with
`ASK_ENGAGEMENT_API_KEY`. The endpoint is unavailable unless
`ENGAGEMENT_REPORTING_ENABLED=true`. Concurrent identical refreshes share one
in-process flight, each query has a bounded record budget, and the internal route
has an independent request rate limit.

Release order:

1. Apply migration 091 to the intended email-tool database.
2. Set a new random `ASK_ENGAGEMENT_API_KEY` on both services and set the fixed
   Alconox mail-tool tenant as `ASK_ENGAGEMENT_CLIENT_ID` on the email tool.
3. Deploy the email tool with `ENGAGEMENT_REPORTING_ENABLED=false`; run a bounded
   read-only verification and inspect its manifest and unsent digest render.
4. Deploy Ask with its engagement capability disabled and the approved
   person-level requester allowlist.
5. After requester scope and results are approved, set
   `ENGAGEMENT_REPORTING_ENABLED=true` on the email tool and
   `ATHENA_ENGAGEMENT_REPORTING_ENABLED=true` on Ask, then re-run
   `scripts/seed_athena.py`.

Rollback is disabling either feature flag. Retain snapshot manifests for
diagnosis; do not fall back to the old unsupported labels or stale digest.

Run the focused checks with:

```bash
node --test api/engagement-reporting.test.js
psql -v ON_ERROR_STOP=1 "$TEST_DATABASE_URL" \
  -f api/engagement-reporting.pgtest.sql
npm run build
```
