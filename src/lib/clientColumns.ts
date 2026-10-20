// Columns of `clients` the browser may read (migration 120). The browser roles
// have column-level grants, and Postgres rejects `select *` for a role that
// lacks a privilege on any column, so every read of `clients` must name its
// columns. Add new app-visible columns here AND to the grants in
// supabase/migrations/120_client_secret_columns.sql. Secrets (sendgrid_api_key,
// salesforce_client_id/secret/tokens, woocommerce_consumer_key/secret) stay
// server-side; see GET /api/clients/:id/credentials.
export const CLIENT_COLUMNS = [
  'id', 'name', 'created_at', 'updated_at', 'mailing_address', 'verified_senders',
  'salesforce_instance_url', 'salesforce_connected_at', 'salesforce_connected_by',
  'last_salesforce_sync', 'salesforce_sync_status', 'salesforce_sync_message', 'salesforce_sync_count',
  'default_utm_params', 'ip_pool', 'default_reply_to_email',
  'campaign_sync_status', 'campaign_sync_message', 'last_campaign_sync',
  'slug', 'brand_reference_template_id', 'allowed_domain', 'enabled_tools', 'enabled_auth_providers', 's3_prefix',
  'woocommerce_url', 'woocommerce_connected_at', 'woocommerce_sync_status', 'woocommerce_sync_message',
  'woocommerce_sync_count', 'last_woocommerce_sync',
  'safe_send_only', 'safe_send_window_days', 'safe_send_new_days', 'safe_send_activity_days',
  'rss_feed_url', 'last_rss_item_link', 'last_rss_checked_at', 'rss_sync_status', 'rss_sync_message',
  'rss_filter_tags', 'rss_mode', 'rss_style',
  'brand_story', 'brand_look', 'brand_story_updated_at',
  'board_calendar_enabled', 'board_layout',
] as const

export const CLIENT_SELECT = CLIENT_COLUMNS.join(', ')
