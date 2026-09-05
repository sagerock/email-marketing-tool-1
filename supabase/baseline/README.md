# Baseline schema

`schema_2026-07-28.sql` is the complete, replayable definition of this
database's `public` schema. **This is the recovery artifact. The migrations are
not.**

## Why this directory exists

On 2026-07-28 a Supabase branch build failed after replaying 25 of 72
migrations. Investigating it turned up something worse than a broken branch:

**39 of the 91 tables in production are created by no recorded migration.**

They were applied by hand in the SQL editor over about a year and never
registered in `supabase_migrations.schema_migrations`. Production is correct and
always has been — but the migration history stopped being able to describe it a
long time ago, and nothing surfaced that until someone tried to build a copy.

The missing tables are not obscure. They include `prospects`, `families`,
`tours`, `pipeline_stages`, `pipeline_history`, `applications` and
`school_events` — SGWS's entire admissions pipeline, which Linden's Monday
digest reads — plus `gmail_threads` and `gmail_messages`, the whole `cc_*`
Constant Contact mirror, `facts_applications`, `facts_inquiries`, the Meta and
GA4 daily tables, and `cfa_consolidated_people`.

The single worst instance was `can_access_client()`, the function that **131 RLS
policies across 48 tables** call to enforce multi-tenant isolation. It was
defined only in the unregistered `034_lock_down_rls_policies.sql`. A replay
produced a database in which every one of those policies failed to create. That
specific gap is now repaired in migration `003`.

## What this does and doesn't protect you from

| Scenario | Covered by |
|---|---|
| Database is lost or corrupted | Supabase backups (Database → Backups). Not this file. |
| Need a test copy / branch | This file |
| Migrating to another project or host | This file |
| Standing up a dev database | This file |
| Understanding what the schema actually is | This file |

Backups are a photocopy including data. This is a blueprint including nothing
else. They solve different problems and you want both.

## Using it

On a fresh Supabase project: create the project, run this file, then apply only
migrations dated **after 2026-07-28**. Everything earlier is already inside it.
Do not replay the old history on top.

`metabase_ro` is a custom role and won't exist on a new project. Either create
it first or delete the 13 `GRANT ... TO metabase_ro` lines at the end.

## Regenerating

```bash
pg_dump "$SUPABASE_DB_URL" --schema-only --schema=public \
  --no-owner --no-privileges --quote-all-identifiers -f schema_$(date +%F).sql
```

Then append the GRANTs, which `pg_dump --no-privileges` omits and Supabase's
REST API cannot work without:

```sql
SELECT DISTINCT format('GRANT %s ON TABLE public.%I TO %I;',
                       privilege_type, table_name, grantee)
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon','authenticated','service_role','metabase_ro');
```

Requires `pg_dump` 17+ (the server is PostgreSQL 17.6; older clients refuse) and
a role that can read every table. The `metabase_ro` analytics user cannot —
`pg_dump` takes a read lock on every table even for `--schema-only`.

**Refresh this after any material schema change.** A stale baseline is worse
than an obviously missing one, because it looks like coverage.
