# Backup and recovery readiness

## Current scope

The production recovery inventory is read-only. The encrypted round-trip rehearsal
uses only synthetic data and a disposable key. A dedicated private S3 destination
has now been provisioned and tested with synthetic encrypted files, as recorded
below. **No independent production backup, production-data off-site transfer,
scheduled backup job, production restore, or knowledge migration is installed by
these tools.** No paid recovery add-on is enabled.

Provider backups, an independent encrypted copy, and a tested restore solve
different problems. A fresh provider backup is not a complete disaster-recovery plan.
Keep audit output, database exports, credentials, and recovery keys out of this
public repository, including when encrypted. The Git ignores are defense in depth,
not permission to store private backups in a public checkout.

## Read-only inventory

```bash
node scripts/check-recovery-readiness.mjs
node --test scripts/check-recovery-readiness.test.mjs
```

Uses the existing management token, lists completed provider backup timestamps,
and reads database size, schema/table counts, Storage object counts and dependency
counts. It never emits record contents, key values, account identities or passwords.
Exit code 1 means the inventory failed, the latest completed daily backup is over
30 hours old (or invalid), or no compatible installed dump tool was found.
Exit code 0 means only those checks passed: the remaining recovery gates are
explicitly marked unverified. This is an on-demand check, not an installed monitor.

Use `/usr/lib/postgresql/17/bin/pg_dump` for the current PostgreSQL 17 production
server. The desktop's default `pg_dump` is PostgreSQL 16 and cannot dump that server.
Do not change the machine-wide default to fix one workflow. Recheck versions before
each upgrade; use the corresponding `pg_restore` for that archive format.

## Synthetic encrypted restore rehearsal

```bash
bash scripts/test-recovery-roundtrip.sh
```

Requires the existing PostgreSQL 16 server/client binaries and GnuPG. The script:

1. Creates two uniquely located disposable clusters with private Unix sockets,
   no TCP listeners, no production credentials and no application workers.
2. Builds the two-client security fixture and applies migrations 095–097.
3. Streams role definitions (without role passwords) and a custom-format database
   archive through GnuPG encryption, with no plaintext archive files.
4. Verifies a truncated encrypted copy fails integrity verification, then verifies
   both intact archives completely before executing any restored SQL. Streaming
   decryption alone can emit SQL before detecting corruption at the end.
5. Restores the intact encrypted copies into the second cluster, preserving owners
   and grants rather than using `--no-owner` or `--no-acl`.
6. Checks restored record counts/content, RLS, client isolation, anonymous denial,
   backend/reporting access and default privileges for newly created functions.
   It does **not** reapply the migrations before these checks.
7. Stops both servers and the disposable GnuPG agent. The uniquely named `/tmp`
   directory is retained for inspection and can be discarded after review.

The generated unprotected test key must NEVER encrypt real client data. The test
clusters contain plaintext synthetic records as expected; only the archive pipeline
is encrypted. The rehearsal verifies PostgreSQL 16 fixture behavior, not production
PostgreSQL 17/Supabase extensions, Auth/Storage compatibility or real-data recovery.

## Coverage required for production recovery

| Layer | Required coverage |
|---|---|
| Application records and security | All application schemas, including non-`public` schemas; consistent data snapshot, sequences, functions, triggers, RLS, grants, ownership and default privileges |
| Authentication and platform metadata | Auth records and compatible provider-managed schemas; migration records, extension versions, publications and relevant platform configuration |
| Media | Supabase Storage bytes separately from object metadata; application S3 media has separate coverage and permissions |
| Secrets and identity | Recoverable application encryption keys, service credentials, custom database-role credentials and recovery keys, held separately with controlled access |
| Runtime | Reviewed application source, deployment configuration, edge functions, scheduler definitions, callback URLs and integrations |
| Local AI knowledge | Existing temporal ledger, source evidence, review queue, SQLite/JSONL files and operational configuration; source Git history alone is insufficient |

Supabase's database backups do not include Storage object bytes. Deleting a
Supabase project also deletes its associated provider backups. See the official
[backup documentation](https://supabase.com/docs/guides/platform/backups).
Use the official [Supabase restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
for provider-managed schemas and target compatibility, not a blind restore of
the synthetic fixture into a hosted project.

## Gates before an independent production copy or cutover

- Sage selects/approves a private off-machine destination and any cost. Do not use
  the existing public media bucket as a backup destination or create a new paid
  service implicitly. Encrypted copies still contain sensitive cross-client data.
- Agree recovery-key custody: the backup writer should need only a public
  encryption key; a tested private recovery key must survive loss of this desktop.
  Do not keep the only decryption key beside the only backup.
- Scope a consistent export with approved credentials, verified TLS and a compatible
  dump tool. Bound lock waits and failure handling. Never place a database password
  in command arguments, source code, terminal output or a Git artifact.
- Inventory and protect media, secrets and local knowledge separately. Define
  retention, storage limits, failure alerts and backup freshness expectations before
  enabling recurring writes. Do not silently prune existing archives.
- Restore into a separate, isolated compatible environment first. Block outbound
  network access and keep mail/payment jobs, application schedulers, database cron,
  webhooks and event-trigger side effects disabled. Restoring SQL can execute code;
  encrypted archives must pass integrity checks before an operational restore.
- Validate counts and selected records without logging personal data, plus client
  access boundaries, authentication, media and worker configuration. Prove key
  recovery and record elapsed recovery time. A synthetic pass is not this evidence.
- Only then decide a controlled local-knowledge migration. Keep chronology,
  supersession, source provenance and client ownership intact; retain the local
  source until reconciliation and rollback are demonstrated.

Production restores, database SSL enforcement restarts, MFA enrollment and paid
recovery options require their own scoped operational decisions. This document
does not authorize sending mail, changing enrollment/payment records, or outages.

## Continuation handoff — September 11, 2026

The resumed session verified fresh completed provider backups and an installed
PostgreSQL 17 dump client. Five readiness tests and the isolated encrypted restore
rehearsal passed. The rehearsal now fully verifies both archives before executing
restored SQL; malformed provider inventories fail instead of appearing healthy.
The rehearsal still uses PostgreSQL 16 synthetic fixtures because only the version
17 client tools are installed. Production recovery compatibility remains untested.

The source changes are operational tools and documentation, not an installed
backup schedule. Production services follow `main`; publish this preparation on a
review branch to preserve it without restarting the email services.

### Proposed first independent backup

Sage selected the existing AWS/S3 account on September 11. A dedicated private
bucket has been provisioned there, separate from public application media. The
remaining full backup setup follows this plan:

- Block all public access, disable object ACLs, enforce TLS and enable versioning.
- Encrypt archives before upload using a dedicated recovery public key; use bucket
  encryption as an additional layer. The backup worker gets the public key only.
- Restrict the backup identity to its destination prefix with no delete or bucket
  administration rights. Keep restore access separate. Versioning alone does not
  protect against a credential that can delete versions.
- Keep the private recovery key and its unlock secret recoverable outside the
  desktop, in Sage's chosen private vault/offline location. Test recovery on a
  separate machine before trusting the first real backup. Do not reuse the
  disposable rehearsal key or place key material in this repository.
- Start with one manually verified encrypted backup and an isolated restore.
  Agree daily cadence, retention, cost ceiling and failure notification before
  scheduling or enabling any expiration rule. No automatic pruning is prepared.
- Include the local knowledge stores and original source evidence as a separately
  scoped archive once their destination is authorized. Snapshot live SQLite stores
  consistently and coordinate the corpus/ledger/queue capture; copying changing
  files independently is not proof of a consistent recovery point.

Account, region and bucket permissions were checked during provisioning. Before
production uploads, estimate storage/request/transfer charges from the actual
archive size and agreed retention. Destination choice alone does not settle the
recovery-key location or full-data restore procedure.

References: [S3 security practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
and [S3 pricing](https://aws.amazon.com/s3/pricing/). Actual archive size and retention,
including media, must inform the estimate; database size is not an archive-size
measurement.

### S3 destination provisioned and tested — September 11

`scripts/provision-recovery-bucket.py` uses boto3 and the current AWS credential
chain. It defaults to a read-only plan, verifies the expected account, requires a
dedicated bucket name, and refuses to adopt or change existing buckets. Its
explicit `--apply` creates only a new bucket and its protective configuration.
Failed configuration retains the empty bucket for explicit repair; it does not
automatically delete resources or upload data.

The new destination passed readback of all public-access blocks, disabled ACLs,
versioning, AES256 server-side encryption, the exact bucket policy, nonpublic
policy status and initial emptiness. The policy denies unencrypted transport and
object/list access outside the provisioning IAM user and account root. This is an
administrative allowlist, not a dedicated worker identity; no new IAM credential
was created. A future limited backup identity must be explicitly admitted while
preserving the separation from existing application media credentials. Account
administrators with policy-management access can still change these controls.

Anonymous bucket listing and reads of both actual synthetic objects returned 403.
Two locally encrypted synthetic archives (6,215 bytes total) were uploaded under
a unique `synthetic-drills/` prefix, returned real object version IDs, downloaded
by version, matched SHA-256 hashes and passed complete decryption integrity checks.
The same source archives passed the isolated database/permissions restore before
upload. No separate full database restore was run from S3; matching ciphertext and
decryption were the transport checks. No production records were uploaded.

Destination identifiers, object versions, checksums and the dated verification
receipt are private local operational state under
`~/.local/state/sagerock-recovery/s3-destination-*.json`; do not commit these
receipts or data. The synthetic keys and fixtures are disposable temporary test
artifacts, never production recovery keys. No expiration/deletion rule or schedule
is enabled. Production recovery-key custody is pending with Sage; then prepare
the limited writer, consistent export and isolated full-data recovery test.
