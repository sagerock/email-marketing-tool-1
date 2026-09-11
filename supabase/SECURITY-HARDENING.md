# Scoped client-data hardening

Migrations 095 and 096 restrict the owner-privileged SQL utility and explicitly
scope access to contact notes/tasks, knowledge bases, email conversations,
discovered media, Constant Contact mirrors, and sync-run metadata.

## Access contract

- Anonymous users have no privileges on the nine tables or `sync_health`.
- Authenticated application admins read only clients allowed by
  `can_access_client`; unassigned accounts have no client-data access.
- Notes, tasks, and knowledge remain editable within that boundary. Notes/tasks
  also require the referenced contact to belong to the same client.
- Conversation history, mirrors, discovered media and sync records are written
  by trusted backend workers, not browser identities.
- Existing service-role and database-owner workers retain access.
- The existing cross-client `metabase_ro` reporting role retains its previous
  SELECT access. `sync_health` intentionally remains an owner-rights operations
  summary, available only to trusted roles, so reporting needs no new raw-log grant.
- `execute_sql(text)` is available to the trusted service role, not PUBLIC,
  anonymous users or ordinary authenticated users.
- The knowledge API independently checks ownership before changing a record or
  deactivating siblings. Every final edit/delete includes both row and client IDs.

## Checks and deployment

`node scripts/apply-security-hardening.mjs` is read-only by default. Production
application requires explicit `--apply --migration=095` or `--migration=096`.
These files are transactional and repeatable. They change permissions, not data.
The management-query runner does not register Supabase CLI migration history;
the checked-in files remain mandatory recovery steps.

`node scripts/verify-security-hardening.mjs` performs live anonymous-denial probes
and read-only, transaction-local identity checks for the existing application
users and service role. It returns no client records or credentials.

`scripts/test-security-hardening.sql` requires a **disposable** PostgreSQL database
named `security_hardening_test`; it creates synthetic roles/data and tests allowed
and denied CRUD, tenant reassignment, contact ownership, reporting/worker access,
and migration idempotence. Never run that fixture against production.

`node --test api/knowledge-security.test.js` tests both the ownership helper and
the actual edit/delete handlers without starting the application or its schedulers.

Deploy the API changes to every email backend instance. Do not roll back database
permissions to public access when rolling back application code. On an integration
failure, identify the exact worker identity and repair its scoped access.

This is targeted remediation, not a full security certification. Other database
functions, authentication settings, transport settings, access history, independent
backups, and restore testing require separate review. No local knowledge corpus is
uploaded by these migrations or scripts.
