# Backup and recovery readiness

## Current scope

One supervised production database export has been encrypted and uploaded to the
dedicated private S3 destination. All five encrypted objects were downloaded by
their exact S3 version IDs and matched their recorded SHA-256 hashes. This is a
manual database backup; no recurring schedule, deletion rule, hosted production
restore or local-knowledge migration has been enabled. No paid recovery add-on is
enabled. The latest full-data restore result is recorded at the end of this file;
earlier dated sections describe the preceding preparation, not the current state.

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

## Recovery gates and remaining coverage before cutover

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

## Earlier preparation handoff — September 11, 2026

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
is enabled. Sage subsequently approved the private 1Password vault for recovery-key
custody. A real passphrase-protected RSA4096 encryption key was generated in a
private Linux directory under `~/.local/state/sagerock-recovery/pending-key-*`.
The exported key recovered synthetic ciphertext in a separate keyring; an empty
passphrase was rejected. The protected key export, public key and recovery document
remain local, outside Git. No production backup uses this key yet.

The existing Windows Chrome session reached 1Password's Private vault and a new
Document form titled `SageRock Backup Recovery Key — 2026-09-11` was prepared.
The browser upload tool refused the private Linux directory because it is outside
its configured file roots. No recovery document was uploaded or saved, and no key
was relocated into a shared/public repository to bypass that restriction. The
local `status.json` records this pending state. Resume by completing the authorized
private-vault upload and verifying the downloaded recovery document and key before
declaring custody complete. Reuse the pending key instead of generating another.
Then prepare the limited writer, consistent export and isolated full-data restore.

### Custody update — shared-vault save and download verified

Sage changed the approved recovery-key destination from Private to his chosen
shared 1Password vault for continuity and reported uploading the recovery document
under a more descriptive item title. This supersedes the earlier pending-upload
destination. The exact vault/title and confirmation provenance are recorded in
the private local key-status file and `D:\dev\private-recovery-keys\RECOVERY-LOCATION.txt`.
No key or passphrase is stored in this source repository.

The exact item title and vault location were then verified in the existing Windows
Chrome session. A newly downloaded attachment exactly matched the original kit's
SHA-256. Using only that downloaded document, a new isolated keyring imported the
key, matched its fingerprint and recovered synthetic ciphertext with the supplied
passphrase; an empty passphrase failed. This verifies the saved recovery document
and key on this desktop, not a separate-machine or full production restore.

Reuse this existing key and vault item. Do not create a duplicate or move it back
to Private. The user-requested accessible local copy remains in
`D:\dev\private-recovery-keys`, outside Git; a verification download remains in
`D:\Downloads`. The private local status and location note record the exact paths
and verification time. No production backup or automatic deletion of local key
material has been performed. Next: limited backup-writer access, consistent export
and isolated full-data recovery verification before scheduling.

## Supervised production backup tools

These tools require Python 3 with boto3 and psycopg2, GnuPG, and the PostgreSQL 17
clients at `/usr/lib/postgresql/17/bin`. Private configuration, the verified key
status and operational receipts live under `~/.local/state/sagerock-recovery`.
The public-key hash and verified-vault status are checked before export or upload.
The supervising operator still has administrative credentials on this machine;
this workflow is not an unattended worker with independently isolated credentials.

- `scripts/backup-database.py`: obtains a short-lived Supabase CLI administrative
  login without resetting the main database password. Uses session-pooler port
  5432 and `sslmode=verify-full` with the official Supabase CA bundle. A read-only
  repeatable-read transaction exports the snapshot shared by pg_dump and the
  count/sample evidence. Lock waits are bounded. Roles are a separate catalog
  read and omit passwords. The Vault recovery root is separately encrypted.
- `scripts/upload-recovery.py`: accepts only the four expected completed encrypted
  export files, encrypts the manifest, then assumes the dedicated upload-only IAM
  role. Each object gets a unique prefix, AES256 bucket encryption and a version
  ID. The supervising identity separately downloads exact versions and verifies
  the complete ciphertext hashes. Interrupted uploads require receipt review;
  blindly rerunning is intentionally refused. No object versions are pruned.
- `scripts/recovery_s3.py`: defines the dedicated role's trust and prefix-scoped
  PutObject/multipart permissions. Provisioning requires an IAM administrator.
  The existing CLI user lacks IAM administration, so the first role and its only
  inline policy were created in the authorized AWS console session. The role was
  added to the existing bucket principal allowlist. Temporary-role upload passed;
  reads, deletion and writes outside its prefixes returned AccessDenied. Account
  administrators retain the power to change policies; this is not immutable WORM
  storage. No long-lived writer access key was created.
- `scripts/verify-recovery.py`: checks the readback against its independent local
  upload receipt, then runs `restore-recovery-isolated.py` in bubblewrap with all
  namespaces unshared, no network, a fresh private writable scratch directory and
  read-only input/key/tool mounts. Ordinary AWS/Supabase credentials and project
  directories are not mounted. Requires the downloaded vault recovery kit only
  for decryption. All ciphertexts pass full integrity verification before SQL
  executes. PostgreSQL listens only on a private Unix socket; cron execution is
  disabled. The server and GnuPG agent stop on completion or failure. Private
  scratch holds plaintext restored data and must be reviewed and removed after
  verification; it is not part of the encrypted off-site backup.

Each command defaults to a plan. Use `--help` for required arguments and pass
`--apply` only for the intended export, upload or isolated restore. Export/restore
outputs must remain under the private recovery paths, never inside this checkout.
Use a new export directory for each backup; preserve the upload intent and
per-object receipts if a run stops. Do not upload plaintext logs or recovery keys.

Offline failure checks:

```bash
python3 -B scripts/test-backup-pipeline.py
```

These verify synthetic encrypt/decrypt integrity, producer failure, encryption
failure and altered-readback rejection. An export is not marked complete merely
because GnuPG successfully encrypted a failed producer's partial output.

### Isolated recovery toolchain

The first full-data drill uses a local PostgreSQL 17.11 server distribution under
`~/.local/share/sagerock-recovery/pg17`; system clients remain unchanged. Official
APT packages were downloaded and extracted with `dpkg-deb -x`, without installing
a system database service: `postgresql-17`, `postgresql-17-cron`,
`postgresql-server-dev-17`, and `libsodium-dev`. Bubblewrap was similarly extracted
under `~/.local/share/sagerock-recovery/bubblewrap`. The launcher currently assumes
Ubuntu amd64, the existing system libraries, and Python 3.12 user packages. A new
machine needs this toolchain assembled and checked before using the launcher.

Supabase Vault 0.3.1 was built from the official
[`supabase/vault` source](https://github.com/supabase/vault/tree/e68456a5c0a020294b2f4b00400abacd3f857cbb),
pinned to commit `e68456a5c0a020294b2f4b00400abacd3f857cbb`. Its shared library,
extension control file (version 0.3.1), and SQL files were placed in the extracted
PG17 library/share directories. Compilation used `gcc -D_GNU_SOURCE -std=c99
-shared -fPIC -O2`, the extracted PG17 server headers and libsodium headers,
`-DEXTVERSION=\"0.3.1\"`, and `-l:libsodium.so.23`. Vault's root is read from the
decrypted recovery artifact inside the sandbox and is never printed.

The production source is PostgreSQL 17.6. The local pg_cron package is 1.6.8 and
reports SQL extension version 1.6, versus the source's 1.6.4. This is a recorded
compatibility difference, not an exact hosted-platform replica. Hosted Auth API,
Storage bytes, edge functions and application workers need separate recovery tests.

PG17 role membership restoration requires matching Supabase's bootstrap grantor,
`supabase_admin`. The verifier initializes that bootstrap role and removes only
its single duplicate `CREATE ROLE` statement from the decrypted in-memory roles
script; it preserves role attributes and the original membership grants. See the
[PostgreSQL bootstrap-grantor discussion](https://www.postgresql.org/message-id/afpHwTR1IJypF1md%40nathan).
The archive itself is not modified. A NULL table ACL is normalized with
`acldefault('r', owner)` when comparing permissions: pg_dump may omit an explicit
owner-only grant that is equivalent to the default.

## Latest result — first real S3 backup and isolated restore verified

On September 11, 2026, the first consistent production database export completed.
Five client-side encrypted artifacts totaling **663,807,551 bytes** were uploaded
with the temporary upload-only role. All five exact S3 object versions were
downloaded and matched their recorded SHA-256 hashes. The saved, downloaded vault
recovery kit decrypted these real archives in the isolated restore environment.

The completed PostgreSQL 17 restore and checks took **122 seconds**, excluding
export, upload/download, toolchain preparation and troubleshooting. This is a
same-desktop drill duration, not a promised disaster-recovery time. It verified:

- All **176 table row counts** against the export's consistent snapshot, plus
  content hashes from five sampled application tables.
- RLS/force-RLS flags and effective table ACLs for all 176 tables.
- Two temporary client identities, each limited to its own restored records
  across ten tables, with cross-client tag RPC access returning no records.
- Anonymous knowledge denial, the privileged SQL RPC boundary, and restored
  default permissions for a newly created postgres-owned function.
- Network/filesystem isolation and disabled database cron execution. Temporary
  test identities and the function probe were rolled back. Servers were stopped,
  and all four task-created plaintext restore scratch directories were removed.

Private `manifest.json`, `upload-receipt.json`, per-object version receipts and
`restore-verification.json` are retained in the dated private backup directory.
The export manifest records its original pre-upload state; the later upload and
restore receipts are authoritative for subsequent stages. Never edit encrypted
archive manifests to imply a later step happened. An accessible status note lives
beside Sage's local recovery-key copy outside Git.

This covers the logical database, role definitions without passwords and the
encrypted Vault recovery root. It does **not** cover Supabase/S3 media bytes,
local temporal-knowledge stores/source evidence, the complete application secret
inventory, deployment/runtime configuration, hosted Auth/API behavior or recovery
on a separate machine. The pg_cron version difference above remains recorded.
Production database contents, mail services and knowledge routing were not changed
by the restore test. No migration or recurring backup schedule was enabled.

Next: define recurring backup freshness, retention, cost limits and failure
notification; scope consistent local-knowledge and media backups; then plan the
knowledge migration with provenance, client ownership and rollback checks intact.
