-- Safe-send gate: new-contact grace window. A contact created within
-- safe_send_new_days (default 30) is sendable before their first engagement,
-- provided any linked Salesforce record is also recent (3x the window) — so a
-- bulk import of old leads (created_at = import time) stays gated.
-- Enforced in sendCampaignById(); mirrored in refresh_alconox_safe_send().
alter table public.clients add column if not exists safe_send_new_days integer not null default 30;
