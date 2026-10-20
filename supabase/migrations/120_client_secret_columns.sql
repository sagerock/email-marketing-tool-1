-- 120: keep client credentials off the browser roles (2026-10-20).
--
-- Before this, `authenticated` had table-level SELECT/UPDATE on public.clients,
-- so any client admin could read their client's SendGrid key, Salesforce
-- consumer key/secret/tokens and WooCommerce consumer key/secret through the
-- REST API (RLS scopes rows, not columns). `anon` had the same grants, and the
-- RomaLume database role could read every client's secrets.
--
-- After: browser roles get column-level grants on the non-secret columns only.
-- The server (service_role / postgres) is unchanged. Super admins set the
-- SendGrid key through PUT /api/clients/:id/sendgrid-key (api/client-credentials.js);
-- Salesforce and WooCommerce already had server-side connect routes.
--
-- MAINTENANCE: a restricted role cannot `select *` on this table any more. Every
-- new column on public.clients that the app should see must be added to the
-- grants below AND to CLIENT_COLUMNS in src/lib/clientColumns.ts.

begin;

revoke all on table public.clients from anon;
revoke all on table public.clients from authenticated;
revoke all on table public.clients from romalume_app;

-- Super admins delete whole clients from Settings; RLS ("Super admins can manage
-- all clients") still decides which rows.
grant delete on table public.clients to authenticated;

grant select (
  id, name, created_at, updated_at, mailing_address, verified_senders,
  salesforce_instance_url, salesforce_connected_at, salesforce_connected_by,
  last_salesforce_sync, salesforce_sync_status, salesforce_sync_message, salesforce_sync_count,
  default_utm_params, ip_pool, default_reply_to_email,
  campaign_sync_status, campaign_sync_message, last_campaign_sync,
  slug, brand_reference_template_id, allowed_domain, enabled_tools, enabled_auth_providers, s3_prefix,
  woocommerce_url, woocommerce_connected_at, woocommerce_sync_status, woocommerce_sync_message,
  woocommerce_sync_count, last_woocommerce_sync,
  safe_send_only, safe_send_window_days, safe_send_new_days, safe_send_activity_days,
  rss_feed_url, last_rss_item_link, last_rss_checked_at, rss_sync_status, rss_sync_message,
  rss_filter_tags, rss_mode, rss_style,
  brand_story, brand_look, brand_story_updated_at,
  board_calendar_enabled, board_layout
) on table public.clients to authenticated, romalume_app;

grant insert (
  id, name, created_at, updated_at, mailing_address, verified_senders,
  salesforce_instance_url, default_utm_params, ip_pool, default_reply_to_email,
  slug, brand_reference_template_id, allowed_domain, enabled_tools, enabled_auth_providers, s3_prefix,
  woocommerce_url, safe_send_only, safe_send_window_days, safe_send_new_days, safe_send_activity_days,
  rss_feed_url, rss_filter_tags, rss_mode, rss_style, brand_story, brand_look, brand_story_updated_at,
  board_calendar_enabled, board_layout
) on table public.clients to authenticated;

grant update (
  name, updated_at, mailing_address, verified_senders,
  salesforce_instance_url, default_utm_params, ip_pool, default_reply_to_email,
  slug, brand_reference_template_id, allowed_domain, enabled_tools, enabled_auth_providers, s3_prefix,
  woocommerce_url, safe_send_only, safe_send_window_days, safe_send_new_days, safe_send_activity_days,
  rss_feed_url, rss_filter_tags, rss_mode, rss_style, brand_story, brand_look, brand_story_updated_at,
  board_calendar_enabled, board_layout
) on table public.clients to authenticated;

commit;
