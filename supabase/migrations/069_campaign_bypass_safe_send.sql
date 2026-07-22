-- Per-campaign escape hatch from the safe-send gate. Default false (all campaigns
-- stay gated). Set true only for deliberate re-engagement sends to a fresh,
-- intent-based list (e.g. recent content downloaders). Honored in sendCampaignById():
--   if (client.safe_send_only && !campaign.bypass_safe_send) { ...apply gate... }
alter table public.campaigns add column if not exists bypass_safe_send boolean not null default false;
