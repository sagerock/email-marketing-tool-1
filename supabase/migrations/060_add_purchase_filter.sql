-- Migration 060: Purchase-based recipient filtering for campaigns
-- Adds campaigns.purchase_filter (jsonb) and a single authoritative recipient
-- count RPC that mirrors sendCampaignById's resolution semantics (tags,
-- Salesforce campaign membership, audience segment, and purchase history).
--
-- purchase_filter shape (any field null/absent = not applied):
--   {
--     "min_spend":     number,                       -- contacts.total_spent >= n
--     "min_orders":    number,                       -- contacts.order_count >= n
--     "recency_mode":  "within" | "lapsed" | "any",  -- vs contacts.last_order_date
--     "recency_days":  number,
--     "product_mode":  "purchased" | "not_purchased" | "any",
--     "product_skus":  ["1104-1", ...]               -- matched against woo line_items
--   }

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS purchase_filter jsonb;

CREATE OR REPLACE FUNCTION count_campaign_recipients(
  p_client_id       uuid,
  p_tags            text[],
  p_sf_campaign_id  uuid,
  p_audience        text[],
  p_purchase        jsonb
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count        integer;
  v_aud_active   boolean := p_audience IS NOT NULL AND array_length(p_audience, 1) BETWEEN 1 AND 2;
  v_min_spend    numeric;
  v_min_orders   integer;
  v_recency_mode text;
  v_recency_days integer;
  v_product_mode text;
  v_skus         text[];
  v_cutoff       timestamptz;
BEGIN
  IF p_purchase IS NOT NULL THEN
    v_min_spend    := NULLIF(p_purchase->>'min_spend', '')::numeric;
    v_min_orders   := NULLIF(p_purchase->>'min_orders', '')::integer;
    v_recency_mode := p_purchase->>'recency_mode';
    v_recency_days := NULLIF(p_purchase->>'recency_days', '')::integer;
    v_product_mode := p_purchase->>'product_mode';
    IF p_purchase ? 'product_skus' THEN
      SELECT array_agg(value) INTO v_skus FROM jsonb_array_elements_text(p_purchase->'product_skus');
    END IF;
  END IF;

  IF v_recency_days IS NOT NULL THEN
    v_cutoff := now() - (v_recency_days || ' days')::interval;
  END IF;

  SELECT count(*) INTO v_count
  FROM contacts c
  WHERE c.client_id = p_client_id
    AND c.unsubscribed = false
    AND c.bounce_status IS DISTINCT FROM 'hard'
    -- tags (overlap / OR within selected tags)
    AND (p_tags IS NULL OR array_length(p_tags, 1) IS NULL OR c.tags && p_tags)
    -- Salesforce campaign membership
    AND (p_sf_campaign_id IS NULL OR EXISTS (
          SELECT 1 FROM salesforce_campaign_members m
          WHERE m.salesforce_campaign_id = p_sf_campaign_id
            AND m.client_id = p_client_id
            AND m.contact_id = c.id))
    -- audience segment (lead / customer / dealer) — only when a strict subset
    AND (NOT v_aud_active OR (
            ('lead' = ANY(p_audience) AND c.record_type = 'lead')
         OR ('customer' = ANY(p_audience) AND c.record_type = 'contact' AND c.contact_type = 'Customer'
             AND (c.account_type IS NULL OR c.account_type <> 'Dealer'))
         OR ('dealer' = ANY(p_audience) AND c.record_type = 'contact'
             AND (c.account_type = 'Dealer' OR c.contact_type = 'Dealer'))
        ))
    -- purchase: spend / orders / recency (denormalized columns)
    AND (v_min_spend IS NULL OR c.total_spent >= v_min_spend)
    AND (v_min_orders IS NULL OR c.order_count >= v_min_orders)
    AND (v_recency_mode IS NULL OR v_recency_mode = 'any' OR v_cutoff IS NULL OR (
            (v_recency_mode = 'within' AND c.last_order_date >= v_cutoff)
         OR (v_recency_mode = 'lapsed' AND c.last_order_date IS NOT NULL AND c.last_order_date < v_cutoff)
        ))
    -- purchase: product (joins woocommerce_orders line_items)
    AND (v_product_mode IS NULL OR v_product_mode = 'any' OR v_skus IS NULL OR (
            (v_product_mode = 'purchased' AND EXISTS (
                SELECT 1 FROM woocommerce_orders o, jsonb_array_elements(o.line_items) li
                WHERE o.client_id = p_client_id AND lower(o.email) = lower(c.email)
                  AND o.status NOT IN ('cancelled','refunded','failed','trash','checkout-draft','pending')
                  AND (li->>'sku') = ANY(v_skus)))
         OR (v_product_mode = 'not_purchased' AND NOT EXISTS (
                SELECT 1 FROM woocommerce_orders o, jsonb_array_elements(o.line_items) li
                WHERE o.client_id = p_client_id AND lower(o.email) = lower(c.email)
                  AND o.status NOT IN ('cancelled','refunded','failed','trash','checkout-draft','pending')
                  AND (li->>'sku') = ANY(v_skus)))
        ));

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION count_campaign_recipients(uuid, text[], uuid, text[], jsonb)
  TO authenticated, service_role;
