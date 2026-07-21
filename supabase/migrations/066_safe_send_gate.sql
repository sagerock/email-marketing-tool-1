-- Safe-send guardrail: per-client opt-in that restricts every broadcast to
-- contacts who engaged (opened/clicked) within a rolling window, so a send can
-- never reach stale, never-validated addresses regardless of the tags picked.
-- Enforced in sendCampaignById() (api/server.js). Only ever narrows an audience.
alter table public.clients add column if not exists safe_send_only boolean not null default false;
alter table public.clients add column if not exists safe_send_window_days integer not null default 365;

-- Enabled for Alconox (July 2026) after monthly-newsletter blasts to the full
-- stale list drove bounce rates to 25-34% and damaged sender reputation.
update public.clients set safe_send_only = true, safe_send_window_days = 365
where id = 'ea7f1422-2d20-4299-85a7-c1201e953409';
