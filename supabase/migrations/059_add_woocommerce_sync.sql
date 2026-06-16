-- Migration 059: WooCommerce order sync
-- Adds per-client WooCommerce credentials + sync status, denormalized purchase
-- rollups on contacts, a source-of-truth orders table (email-keyed so guest
-- checkouts survive), and an RPC to recompute rollups for a set of emails.
--
-- Enrich-only: never touches `unsubscribed`. Mirrors the Salesforce sync model.

-- ============================================================
-- 1. clients: credentials (encrypted at rest) + sync status
-- ============================================================
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS woocommerce_url             text,
  ADD COLUMN IF NOT EXISTS woocommerce_consumer_key    text,  -- encrypted (crypto-utils)
  ADD COLUMN IF NOT EXISTS woocommerce_consumer_secret text,  -- encrypted (crypto-utils)
  ADD COLUMN IF NOT EXISTS woocommerce_connected_at    timestamptz,
  ADD COLUMN IF NOT EXISTS woocommerce_sync_status     text,
  ADD COLUMN IF NOT EXISTS woocommerce_sync_message    text,
  ADD COLUMN IF NOT EXISTS woocommerce_sync_count       integer,
  ADD COLUMN IF NOT EXISTS last_woocommerce_sync       timestamptz;

-- ============================================================
-- 2. contacts: denormalized purchase rollups for fast segmentation
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS total_spent           numeric(12,2),
  ADD COLUMN IF NOT EXISTS order_count           integer,
  ADD COLUMN IF NOT EXISTS first_order_date      timestamptz,
  ADD COLUMN IF NOT EXISTS last_order_date       timestamptz,
  ADD COLUMN IF NOT EXISTS woocommerce_synced_at timestamptz;

-- ============================================================
-- 3. woocommerce_orders: source of truth (email-keyed)
-- ============================================================
CREATE TABLE IF NOT EXISTS woocommerce_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  woo_order_id  bigint NOT NULL,
  email         text,
  status        text,
  total         numeric(12,2),
  currency      text,
  order_date    timestamptz,
  line_items    jsonb,         -- [{sku, name, qty, total}]
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, woo_order_id)
);

CREATE INDEX IF NOT EXISTS idx_woo_orders_client_email
  ON woocommerce_orders (client_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_woo_orders_client_date
  ON woocommerce_orders (client_id, order_date);

-- ============================================================
-- 4. RLS (mirrors migration 034: can_access_client + service_role)
-- ============================================================
ALTER TABLE woocommerce_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select woo orders" ON woocommerce_orders;
DROP POLICY IF EXISTS "Admins can insert woo orders" ON woocommerce_orders;
DROP POLICY IF EXISTS "Admins can update woo orders" ON woocommerce_orders;
DROP POLICY IF EXISTS "Admins can delete woo orders" ON woocommerce_orders;

CREATE POLICY "Admins can select woo orders" ON woocommerce_orders
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert woo orders" ON woocommerce_orders
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update woo orders" ON woocommerce_orders
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete woo orders" ON woocommerce_orders
  FOR DELETE USING (can_access_client(client_id));

-- ============================================================
-- 5. Rollup RPC: recompute contact rollups for a set of emails.
--    Excludes non-revenue statuses so a now-cancelled/refunded order
--    correctly drops out of a contact's totals on the next sync.
-- ============================================================
CREATE OR REPLACE FUNCTION recompute_woo_rollups(
  p_client_id uuid,
  p_emails    text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lower text[];
  v_count integer;
BEGIN
  SELECT array_agg(lower(e)) INTO v_lower FROM unnest(p_emails) e;

  -- Contacts that match a synced email but have no qualifying orders get zeroed.
  WITH agg AS (
    SELECT lower(email) AS em,
           sum(total)        AS spend,
           count(*)          AS cnt,
           min(order_date)   AS first_o,
           max(order_date)   AS last_o
    FROM woocommerce_orders
    WHERE client_id = p_client_id
      AND lower(email) = ANY(v_lower)
      AND status NOT IN ('cancelled','refunded','failed','trash','checkout-draft','pending')
    GROUP BY lower(email)
  )
  UPDATE contacts c SET
    total_spent      = COALESCE(agg.spend, 0),
    order_count      = COALESCE(agg.cnt, 0),
    first_order_date = agg.first_o,
    last_order_date  = agg.last_o,
    woocommerce_synced_at = now()
  FROM (SELECT unnest(v_lower) AS em) keys
  LEFT JOIN agg ON agg.em = keys.em
  WHERE c.client_id = p_client_id AND lower(c.email) = keys.em;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION recompute_woo_rollups(uuid, text[]) TO authenticated, service_role;
