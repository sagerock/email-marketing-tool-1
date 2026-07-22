-- Recent-activity grace for the safe-send gate. A contact who showed fresh intent
-- (download, order, email open/click, or signup) within safe_send_activity_days
-- (default 60) is sendable without a prior email open — as long as not bounced or
-- unsubscribed. Honored in sendCampaignById() via the last_activity_at column.
--
-- last_activity_at = greatest(last_engaged_at, last_order_date, most-recent dated
-- event in source_code_history). source_code_history dates are the real event dates,
-- so they're immune to bulk-import created_at artifacts. Maintained nightly by
-- refresh_alconox_safe_send() (also refreshes the "Safe Send" tag to match the gate).
alter table public.contacts add column if not exists last_activity_at timestamptz;
alter table public.clients  add column if not exists safe_send_activity_days integer not null default 60;

-- public.try_date(text): safe YYYY-MM-DD cast, returns null on malformed history dates.
-- Full function bodies (try_date, refresh_alconox_safe_send) applied via the
-- Supabase migration API on 2026-07-22; see that migration for the definitions.
