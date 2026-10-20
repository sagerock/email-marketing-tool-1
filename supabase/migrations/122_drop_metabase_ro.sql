-- 122: drop the metabase_ro login role (2026-10-20, Sage approved). It was created for a
-- Metabase proof of concept on Railway that no longer exists (its URL returns 404); it owned
-- nothing, had 115 table grants (public + alconox), no connections, and no mentions in the
-- Postgres logs. An unused login role with a password is one more way in.
--
-- Applied in production 2026-10-20 through the management API as `postgres`, which is not a
-- superuser on Supabase: DROP OWNED needs membership in the role, hence the GRANT first.
-- Guarded so the migration replays on databases that never had the role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'metabase_ro') then
    execute 'grant metabase_ro to postgres';
    execute 'drop owned by metabase_ro';
    execute 'drop role metabase_ro';
  end if;
end $$;
