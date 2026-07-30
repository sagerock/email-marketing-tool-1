-- Stabilize campaign recipient selection and keep UI counts aligned with sends.

UPDATE public.contacts
SET bounce_status = 'none'
WHERE bounce_status IS NULL;

ALTER TABLE public.contacts
  ALTER COLUMN bounce_status SET DEFAULT 'none',
  ALTER COLUMN bounce_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sf_campaign_members_keyset
  ON public.salesforce_campaign_members (client_id, salesforce_campaign_id, id);

CREATE INDEX IF NOT EXISTS idx_woo_orders_keyset
  ON public.woocommerce_orders (client_id, id);

DROP FUNCTION IF EXISTS public.count_campaign_recipients(uuid, text[], uuid, text[], jsonb);

CREATE FUNCTION public.count_campaign_recipients(
  p_client_id        uuid,
  p_tags             text[],
  p_sf_campaign_id   uuid,
  p_audience         text[],
  p_purchase         jsonb,
  p_bypass_safe_send boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count              integer;
  v_aud_active         boolean := p_audience IS NOT NULL AND array_length(p_audience, 1) BETWEEN 1 AND 2;
  v_min_spend          numeric;
  v_min_orders         integer;
  v_recency_mode       text;
  v_recency_days       integer;
  v_product_mode       text;
  v_skus               text[];
  v_cutoff             timestamptz;
  v_safe_send_only     boolean := false;
  v_safe_window_days   integer := 365;
  v_safe_activity_days integer := 60;
  v_safe_new_days      integer := 30;
BEGIN
  SELECT
    COALESCE(safe_send_only, false),
    COALESCE(safe_send_window_days, 365),
    COALESCE(safe_send_activity_days, 60),
    COALESCE(safe_send_new_days, 30)
  INTO
    v_safe_send_only,
    v_safe_window_days,
    v_safe_activity_days,
    v_safe_new_days
  FROM public.clients
  WHERE id = p_client_id;

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
    v_cutoff := now() - make_interval(days => v_recency_days);
  END IF;

  SELECT count(DISTINCT lower(btrim(c.email))) INTO v_count
  FROM public.contacts c
  WHERE c.client_id = p_client_id
    AND NULLIF(btrim(c.email), '') IS NOT NULL
    AND c.unsubscribed = false
    AND c.bounce_status <> 'hard'
    AND (
      p_bypass_safe_send
      OR NOT v_safe_send_only
      OR c.last_engaged_at >= now() - make_interval(days => v_safe_window_days)
      OR c.last_activity_at >= now() - make_interval(days => v_safe_activity_days)
      OR (
        c.created_at >= now() - make_interval(days => v_safe_new_days)
        AND (
          c.salesforce_created_date IS NULL
          OR c.salesforce_created_date >= now() - make_interval(days => v_safe_new_days * 3)
        )
      )
    )
    AND (p_tags IS NULL OR array_length(p_tags, 1) IS NULL OR c.tags && p_tags)
    AND (p_sf_campaign_id IS NULL OR EXISTS (
      SELECT 1
      FROM public.salesforce_campaign_members m
      WHERE m.salesforce_campaign_id = p_sf_campaign_id
        AND m.client_id = p_client_id
        AND m.contact_id = c.id
    ))
    AND (NOT v_aud_active OR (
         ('lead' = ANY(p_audience) AND c.record_type = 'lead')
      OR ('customer' = ANY(p_audience) AND c.record_type = 'contact' AND c.contact_type = 'Customer'
          AND (c.account_type IS NULL OR c.account_type <> 'Dealer'))
      OR ('dealer' = ANY(p_audience) AND c.record_type = 'contact'
          AND (c.account_type = 'Dealer' OR c.contact_type = 'Dealer'))
    ))
    AND (v_min_spend IS NULL OR c.total_spent >= v_min_spend)
    AND (v_min_orders IS NULL OR c.order_count >= v_min_orders)
    AND (v_recency_mode IS NULL OR v_recency_mode = 'any' OR v_cutoff IS NULL OR (
         (v_recency_mode = 'within' AND c.last_order_date >= v_cutoff)
      OR (v_recency_mode = 'lapsed' AND c.last_order_date IS NOT NULL AND c.last_order_date < v_cutoff)
    ))
    AND (v_product_mode IS NULL OR v_product_mode = 'any' OR v_skus IS NULL OR (
         (v_product_mode = 'purchased' AND EXISTS (
           SELECT 1
           FROM public.woocommerce_orders o, jsonb_array_elements(o.line_items) li
           WHERE o.client_id = p_client_id
             AND lower(btrim(o.email)) = lower(btrim(c.email))
             AND o.status NOT IN ('cancelled','refunded','failed','trash','checkout-draft','pending')
             AND (li->>'sku') = ANY(v_skus)
         ))
      OR (v_product_mode = 'not_purchased' AND NOT EXISTS (
           SELECT 1
           FROM public.woocommerce_orders o, jsonb_array_elements(o.line_items) li
           WHERE o.client_id = p_client_id
             AND lower(btrim(o.email)) = lower(btrim(c.email))
             AND o.status NOT IN ('cancelled','refunded','failed','trash','checkout-draft','pending')
             AND (li->>'sku') = ANY(v_skus)
         ))
    ));

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.count_campaign_recipients(uuid, text[], uuid, text[], jsonb, boolean)
  TO authenticated, service_role;
