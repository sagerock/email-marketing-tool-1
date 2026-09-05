-- ===========================================================================
-- schema_2026-07-28.sql — full baseline of the `public` schema, production.
--
-- WHAT THIS IS
--   A complete, replayable definition of this database's public schema as it
--   actually existed on 2026-07-28. Tables, columns, constraints, indexes,
--   sequences, types, functions, triggers, views, RLS enablement, every RLS
--   policy, and every GRANT to anon / authenticated / service_role.
--
-- WHY IT EXISTS
--   The migration ledger cannot rebuild this database. 39 of 91 tables are
--   created by no recorded migration -- including `prospects`, `families`,
--   `tours` and `pipeline_stages` (SGWS's admissions pipeline, which Linden's
--   Monday digest reads), `gmail_threads` and `gmail_messages`, the whole cc_*
--   Constant Contact mirror, the FACTS and Meta and GA4 tables, and
--   `cfa_consolidated_people`. Those objects were applied by hand in the SQL
--   editor over roughly a year and never registered.
--
--   A branch build proved it: replay died after 25 of 72 migrations because
--   can_access_client() -- the function 131 RLS policies call -- was defined
--   only in an unregistered local file. That one is now repaired in migration
--   003, but the other 36 gaps remain, and reverse-engineering them by hand
--   would be both enormous and unreliable. This file replaces that work.
--
-- HOW IT WAS MADE
--   pg_dump 17.10 --schema-only --schema=public --no-owner --no-privileges,
--   run through the session-mode pooler. GRANTs were generated separately from
--   information_schema and appended, because the dumping role could not read
--   them. Nothing here was hand-written.
--
-- HOW TO USE IT ON A FRESH PROJECT
--   1. Create the project. anon / authenticated / service_role already exist.
--   2. Run this file.
--   3. Apply only migrations dated AFTER 2026-07-28. Everything earlier is
--      already contained here -- do not replay the old history on top of it.
--
-- WHAT IT DOES NOT CONTAIN
--   No data, only structure. Only the `public` schema -- auth, storage and
--   realtime are Supabase-managed and rebuilt automatically. Roles themselves
--   are not created; `metabase_ro` is a custom role and must exist before its
--   GRANTs at the end of this file will apply (or delete those 13 lines).
--
-- REGENERATE THIS FILE whenever the schema changes materially. It is the
--   recovery artifact; the migrations are a change log. They are not the same
--   thing, and this database is proof.
-- ===========================================================================

--
-- PostgreSQL database dump
--

\restrict 8XnNg6zO7Ka8IjlW9LixNTtFx6ua2MLDKSQSwuwFBuMlxpgcz6gcxh5DF4GMEmV

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: enrollment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."enrollment_status" AS ENUM (
    'active',
    'completed',
    'paused',
    'cancelled',
    'failed'
);


--
-- Name: sequence_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."sequence_status" AS ENUM (
    'draft',
    'active',
    'paused',
    'archived'
);


--
-- Name: append_tag_to_contacts("uuid", "text", "text"[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."append_tag_to_contacts"("p_client_id" "uuid", "p_tag_name" "text", "p_emails" "text"[]) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE contacts
  SET tags = CASE
    WHEN tags IS NULL THEN ARRAY[p_tag_name]
    ELSE array_append(tags, p_tag_name)
  END,
  updated_at = NOW()
  WHERE client_id = p_client_id
    AND email = ANY(p_emails)
    AND (tags IS NULL OR NOT (p_tag_name = ANY(tags)));

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;


--
-- Name: can_access_client("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."can_access_client"("target_client_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = auth.uid()
      AND (
        role IN ('super_admin', 'admin')
        OR (role = 'client_admin' AND client_id = target_client_id)
      )
  );
$$;


--
-- Name: cfa_dashboard_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."cfa_dashboard_stats"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
  with ev as (select * from public.cfa_page_events where created_at > now() - interval '90 days'),
  leads as (select first_name, email, intake_data, created_at from public.contacts
            where client_id = '22500cd6-052a-42ff-a0cb-4f3ba9125dfd' and source_code = 'website')
  select jsonb_build_object(
    'generated_at', now(),
    'totals', jsonb_build_object(
      'pageviews', (select count(*) from ev where event='pageview'),
      'sessions',  (select count(distinct session_id) from ev where coalesce(session_id,'')<>''),
      'cta_clicks',(select count(*) from ev where event='cta_click'),
      'conversions',(select count(*) from ev where event='form_submit'),
      'leads',     (select count(*) from leads)),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'pageviews', c) order by d), '[]'::jsonb)
      from (select generate_series(current_date-29, current_date, interval '1 day')::date d) days
      left join lateral (select count(*) c from ev where event='pageview' and created_at::date = days.d) x on true),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', src, 'visits', c) order by c desc), '[]'::jsonb)
      from (select public.cfa_source_of(referrer) src, count(*) c from ev where event='pageview' group by 1 order by c desc) t),
    'top_pages', (select coalesce(jsonb_agg(jsonb_build_object('path', path, 'views', c) order by c desc), '[]'::jsonb)
      from (select path, count(*) c from ev where event='pageview' and coalesce(path,'')<>'' group by path order by c desc limit 8) t),
    'recent_leads', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', first_name, 'email', email, 'program', intake_data->>'program_interest',
        'source', intake_data->>'source', 'at', created_at) order by created_at desc), '[]'::jsonb)
      from (select * from leads order by created_at desc limit 12) t)
  )
$$;


--
-- Name: cfa_source_of("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."cfa_source_of"("ref" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when ref ilike '%google%'    then 'Google'
    when ref ilike '%facebook%' or ref ilike '%fb.%' then 'Facebook'
    when ref ilike '%instagram%' then 'Instagram'
    when ref ilike '%linkedin%' or ref ilike '%lnkd%' then 'LinkedIn'
    when ref ilike '%bing%'      then 'Bing'
    when ref ilike '%t.co%' or ref ilike '%twitter%' or ref ilike '%x.com%' then 'X/Twitter'
    when ref = 'newsletter' or ref ilike '%mailchi%' or ref ilike '%sendgrid%' then 'Newsletter'
    when coalesce(ref,'') = '' then 'Direct'
    when ref ilike '%centerforanthroposophy%' then 'Direct'
    else 'Other' end
$$;


--
-- Name: cfa_website_lead("text", "text", "text", "text", "text", "text", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."cfa_website_lead"("p_email" "text", "p_first" "text", "p_last" "text", "p_phone" "text", "p_program" "text", "p_message" "text", "p_source" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_client uuid := '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
  v_email  text := lower(trim(p_email));
  v_tags   text[] := array_remove(array['website-inquiry', nullif(trim(p_program),'')], null);
  v_intake jsonb := jsonb_strip_nulls(jsonb_build_object(
    'phone', nullif(trim(p_phone),''),
    'program_interest', nullif(trim(p_program),''),
    'message', nullif(trim(p_message),''),
    'source_path', nullif(trim(p_source),''),
    'submitted_via', 'website'
  ));
  v_id uuid;
begin
  if v_email = '' or v_email not like '%_@_%' then
    raise exception 'invalid email';
  end if;
  insert into public.contacts
    (email, first_name, last_name, client_id, source_code, tags, intake_summary, intake_data)
  values
    (v_email, nullif(trim(p_first),''), nullif(trim(p_last),''), v_client,
     'website', v_tags, nullif(trim(p_message),''), v_intake)
  on conflict (email, client_id) do update set
    first_name     = coalesce(contacts.first_name, excluded.first_name),
    last_name      = coalesce(contacts.last_name,  excluded.last_name),
    source_code    = coalesce(contacts.source_code, excluded.source_code),
    tags           = (select array(select distinct t
                        from unnest(coalesce(contacts.tags,'{}'::text[]) || excluded.tags) t)),
    intake_summary = coalesce(excluded.intake_summary, contacts.intake_summary),
    intake_data    = coalesce(contacts.intake_data,'{}'::jsonb) || excluded.intake_data
  returning id into v_id;
  return v_id;
end $$;


--
-- Name: cfa_website_lead("text", "text", "text", "text", "text", "text", "text", "text", "jsonb"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."cfa_website_lead"("p_email" "text", "p_first" "text", "p_last" "text", "p_phone" "text", "p_program" "text", "p_message" "text", "p_source" "text", "p_channel" "text" DEFAULT ''::"text", "p_utm" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_client uuid := '22500cd6-052a-42ff-a0cb-4f3ba9125dfd';
  v_email  text := lower(trim(p_email));
  v_tags   text[] := array_remove(array['website-inquiry', nullif(trim(p_program),'')], null);
  v_intake jsonb := jsonb_strip_nulls(jsonb_build_object(
    'phone', nullif(trim(p_phone),''), 'program_interest', nullif(trim(p_program),''),
    'message', nullif(trim(p_message),''), 'source_path', nullif(trim(p_source),''),
    'source', nullif(trim(p_channel),''), 'submitted_via', 'website'
  ));
  v_utm jsonb := case when p_utm is null or p_utm = '{}'::jsonb then null else p_utm end;
  v_id uuid;
begin
  if v_email = '' or v_email not like '%_@_%' then raise exception 'invalid email'; end if;
  insert into public.contacts
    (email, first_name, last_name, client_id, source_code, tags, intake_summary, intake_data, utm_params)
  values
    (v_email, nullif(trim(p_first),''), nullif(trim(p_last),''), v_client,
     'website', v_tags, nullif(trim(p_message),''), v_intake, v_utm)
  on conflict (email, client_id) do update set
    first_name     = coalesce(contacts.first_name, excluded.first_name),
    last_name      = coalesce(contacts.last_name,  excluded.last_name),
    source_code    = coalesce(contacts.source_code, excluded.source_code),
    tags           = (select array(select distinct t from unnest(coalesce(contacts.tags,'{}'::text[]) || excluded.tags) t)),
    intake_summary = coalesce(excluded.intake_summary, contacts.intake_summary),
    intake_data    = coalesce(contacts.intake_data,'{}'::jsonb) || excluded.intake_data,
    utm_params     = coalesce(contacts.utm_params, excluded.utm_params)
  returning id into v_id;
  return v_id;
end $$;


--
-- Name: count_campaign_recipients("uuid", "text"[], "uuid", "text"[], "jsonb"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."count_campaign_recipients"("p_client_id" "uuid", "p_tags" "text"[], "p_sf_campaign_id" "uuid", "p_audience" "text"[], "p_purchase" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
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
    AND (p_tags IS NULL OR array_length(p_tags, 1) IS NULL OR c.tags && p_tags)
    AND (p_sf_campaign_id IS NULL OR EXISTS (
          SELECT 1 FROM salesforce_campaign_members m
          WHERE m.salesforce_campaign_id = p_sf_campaign_id
            AND m.client_id = p_client_id
            AND m.contact_id = c.id))
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


--
-- Name: execute_sql("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."execute_sql"("query" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  result jsonb;
  trimmed text;
  first_word text;
BEGIN
  SET LOCAL statement_timeout = '30s';
  trimmed := regexp_replace(query, '^\s+', '');
  first_word := lower(regexp_replace(trimmed, '\s.*', ''));
  IF first_word NOT IN ('select', 'with') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;
  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || trimmed || ') t' INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;


--
-- Name: generate_unsubscribe_token(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."generate_unsubscribe_token"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Only generate token if it doesn't exist
  IF NEW.unsubscribe_token IS NULL THEN
    NEW.unsubscribe_token = encode(gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: get_campaign_link_stats("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_campaign_link_stats"("p_campaign_id" "uuid") RETURNS TABLE("url" "text", "total_clicks" bigint, "unique_clicks" bigint)
    LANGUAGE "sql" STABLE
    AS $$
    SELECT split_part(ae.url, '?', 1) AS url,
           COUNT(*)::BIGINT AS total_clicks,
           COUNT(DISTINCT ae.email)::BIGINT AS unique_clicks
    FROM analytics_events ae
    WHERE ae.campaign_id = p_campaign_id
      AND ae.event_type = 'click'
      AND ae.url IS NOT NULL
      AND split_part(ae.url, '?', 1) NOT ILIKE '%/unsubscribe'
    GROUP BY 1
    ORDER BY 2 DESC;
  $$;


--
-- Name: get_campaign_unique_clicks("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_campaign_unique_clicks"("p_campaign_id" "uuid") RETURNS TABLE("engaged_clicks" bigint, "unsub_clicks" bigint)
    LANGUAGE "sql" STABLE
    AS $$
    SELECT
      COUNT(DISTINCT CASE WHEN url NOT LIKE '%/unsubscribe%' THEN email END)::BIGINT,
      COUNT(DISTINCT CASE WHEN url LIKE '%/unsubscribe%' THEN email END)::BIGINT
    FROM analytics_events
    WHERE campaign_id = p_campaign_id AND event_type = 'click';
  $$;


--
-- Name: get_campaign_unique_opens("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_campaign_unique_opens"("p_campaign_id" "uuid") RETURNS bigint
    LANGUAGE "plpgsql"
    AS $$                                                                          
  BEGIN
    RETURN (
      SELECT COUNT(DISTINCT email)
      FROM analytics_events
      WHERE campaign_id = p_campaign_id
        AND event_type = 'open'
    );
  END;
  $$;


--
-- Name: get_program_enrollment_counts("uuid", integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_program_enrollment_counts"("p_client_id" "uuid", "p_year" integer) RETURNS TABLE("name" "text", "format" "text", "count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.name, p.format, count(e.id)::bigint
  from programs p
  left join enrollments e
    on e.program_id = p.id and e.status = 'registered'
  where p.client_id = p_client_id
    and p.year = p_year
  group by p.name, p.format
  order by p.name, p.format
$$;


--
-- Name: get_tag_counts("uuid", "text"[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_tag_counts"("p_client_id" "uuid", "p_audience_filter" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("tag_name" "text", "cnt" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT t::text, COUNT(*)::bigint
  FROM contacts, UNNEST(tags) AS t
  WHERE client_id = p_client_id
    AND (
      p_audience_filter IS NULL
      OR array_length(p_audience_filter, 1) IS NULL
      OR ('lead' = ANY(p_audience_filter) AND record_type = 'lead')
      OR (
        'customer' = ANY(p_audience_filter)
        AND record_type = 'contact'
        AND contact_type = 'Customer'
        AND (account_type IS NULL OR account_type <> 'Dealer')
      )
      OR (
        'dealer' = ANY(p_audience_filter)
        AND record_type = 'contact'
        AND (account_type = 'Dealer' OR contact_type = 'Dealer')
      )
    )
  GROUP BY t
  ORDER BY t
$$;


--
-- Name: get_user_client_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_user_client_id"() RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT client_id FROM admin_users
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;


--
-- Name: has_client_access("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."has_client_access"("check_user_id" "uuid", "check_client_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = check_user_id
    AND (
      role = 'super_admin'
      OR (role = 'client_admin' AND client_id = check_client_id)
      OR (role = 'admin')
    )
  );
END;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = auth.uid()
  );
$$;


--
-- Name: is_admin("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_admin"("check_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users WHERE user_id = check_user_id
  );
END;
$$;


--
-- Name: is_internal_staff(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_internal_staff"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin')
  );
$$;


--
-- Name: FUNCTION "is_internal_staff"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."is_internal_staff"() IS 'True for super_admin and admin only. Used by the sr_* prospecting tables so client_admins cannot read SageRock''s own sales pipeline.';


--
-- Name: is_super_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_super_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = auth.uid() AND role = 'super_admin'
  );
$$;


--
-- Name: is_super_admin("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."is_super_admin"("check_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = check_user_id AND role = 'super_admin'
  );
END;
$$;


--
-- Name: log_prospect_stage_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."log_prospect_stage_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NEW.current_stage_id IS DISTINCT FROM OLD.current_stage_id THEN
    INSERT INTO pipeline_history (client_id, prospect_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.client_id, NEW.id, OLD.current_stage_id, NEW.current_stage_id, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: recompute_woo_rollups("uuid", "text"[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."recompute_woo_rollups"("p_client_id" "uuid", "p_emails" "text"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_lower text[];
  v_count integer;
BEGIN
  SELECT array_agg(lower(e)) INTO v_lower FROM unnest(p_emails) e;

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


--
-- Name: reengagement_classify("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."reengagement_classify"("p_client" "uuid") RETURNS json
    LANGUAGE "plpgsql"
    AS $$
DECLARE cfg reengagement_config;
BEGIN
  SELECT * INTO cfg FROM reengagement_config WHERE client_id = p_client;
  IF NOT FOUND OR NOT cfg.enabled THEN
    RETURN json_build_object('ran', false, 'reason', 'not enabled');
  END IF;

  WITH recv AS (
    SELECT lower(e.email) AS email, count(*) AS delivered_recent
    FROM analytics_events e
    JOIN campaigns cam ON cam.id = e.campaign_id
    WHERE cam.client_id = p_client
      AND e.event_type = 'delivered'
      AND e.timestamp > now() - (cfg.cold_after_days || ' days')::interval
    GROUP BY lower(e.email)
  ),
  classified AS (
    SELECT c.id,
      CASE WHEN
            c.unsubscribed = false
        AND (c.bounce_status IS NULL OR c.bounce_status <> 'hard')
        AND c.created_at < now() - (cfg.cold_after_days || ' days')::interval
        AND (c.last_engaged_at IS NULL OR c.last_engaged_at < now() - (cfg.cold_after_days || ' days')::interval)
        AND NOT (cfg.protect_customers AND (c.is_converted IS TRUE OR coalesce(c.order_count,0) > 0 OR coalesce(c.total_spent,0) > 0))
        AND NOT (coalesce(c.tags,'{}') && cfg.protected_tags)
        AND coalesce(r.delivered_recent,0) >= cfg.min_received
      THEN 'cold' ELSE 'active' END AS new_status
    FROM contacts c
    LEFT JOIN recv r ON r.email = lower(c.email)
    WHERE c.client_id = p_client
      AND coalesce(c.engagement_status,'active') IN ('active','cold')
  )
  UPDATE contacts c SET engagement_status = cl.new_status
  FROM classified cl
  WHERE c.id = cl.id AND coalesce(c.engagement_status,'active') <> cl.new_status;

  RETURN reengagement_health(p_client);
END $$;


--
-- Name: reengagement_classify_all(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."reengagement_classify_all"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT client_id FROM reengagement_config WHERE enabled LOOP
    PERFORM reengagement_classify(r.client_id);
  END LOOP;
END $$;


--
-- Name: reengagement_health("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."reengagement_health"("p_client" "uuid") RETURNS json
    LANGUAGE "sql" STABLE
    AS $$
  SELECT json_build_object(
    'total', count(*),
    'sendable', count(*) FILTER (WHERE unsubscribed = false AND (bounce_status IS NULL OR bounce_status <> 'hard')),
    'active', count(*) FILTER (WHERE engagement_status = 'active'),
    'cold', count(*) FILTER (WHERE engagement_status = 'cold'),
    'reengaging', count(*) FILTER (WHERE engagement_status = 'reengaging'),
    'sunset', count(*) FILTER (WHERE engagement_status = 'sunset'),
    'protected_customers', count(*) FILTER (WHERE is_converted IS TRUE OR coalesce(order_count,0) > 0 OR coalesce(total_spent,0) > 0)
  )
  FROM contacts WHERE client_id = p_client;
$$;


--
-- Name: refresh_alconox_safe_send(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."refresh_alconox_safe_send"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  update public.contacts c set last_activity_at = gr.v
  from (
    select id,
      greatest(
        last_engaged_at,
        last_order_date::timestamptz,
        (select max(public.try_date(mm[1]))
           from regexp_matches(coalesce(source_code_history,''), '@ (\d{4}-\d{2}-\d{2})', 'g') mm)::timestamptz
      ) as v
    from public.contacts
    where client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
  ) gr
  where c.id = gr.id and c.last_activity_at is distinct from gr.v;

  update public.contacts set tags = array_append(coalesce(tags,'{}'), 'Safe Send')
   where client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
     and not unsubscribed and coalesce(bounce_status,'none') <> 'hard'
     and (last_engaged_at >= now() - interval '365 days'
          or last_activity_at >= now() - interval '60 days'
          or (created_at >= now() - interval '30 days'
              and (salesforce_created_date is null or salesforce_created_date >= now() - interval '90 days')))
     and not ('Safe Send' = any(coalesce(tags,'{}')));

  update public.contacts set tags = array_remove(tags, 'Safe Send')
   where client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409'
     and 'Safe Send' = any(tags)
     and (unsubscribed or coalesce(bounce_status,'none') = 'hard'
          or not (last_engaged_at >= now() - interval '365 days'
                  or last_activity_at >= now() - interval '60 days'
                  or (created_at >= now() - interval '30 days'
                      and (salesforce_created_date is null or salesforce_created_date >= now() - interval '90 days'))));

  update public.tags set contact_count =
     (select count(*) from public.contacts
       where client_id='ea7f1422-2d20-4299-85a7-c1201e953409' and 'Safe Send' = any(tags))
   where client_id='ea7f1422-2d20-4299-85a7-c1201e953409' and name='Safe Send';
$$;


--
-- Name: sr_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."sr_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: try_date("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."try_date"("t" "text") RETURNS "date"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
begin
  return to_date(t, 'YYYY-MM-DD');
exception when others then
  return null;
end $$;


--
-- Name: update_enrollments_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_enrollments_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: update_programs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_programs_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: update_sequence_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_sequence_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."analytics_events" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "campaign_id" "uuid",
    "email" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "url" "text",
    "user_agent" "text",
    "ip_address" "text",
    "sg_event_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "analytics_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['delivered'::"text", 'open'::"text", 'click'::"text", 'bounce'::"text", 'spam'::"text", 'unsubscribe'::"text", 'block'::"text"])))
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."campaigns" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "template_id" "uuid",
    "subject" "text" NOT NULL,
    "from_email" "text" NOT NULL,
    "from_name" "text" NOT NULL,
    "reply_to" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "recipient_count" integer DEFAULT 0,
    "filter_tags" "text"[],
    "ip_pool" "text",
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "utm_params" "text",
    "folder_id" "uuid",
    "salesforce_campaign_id" "uuid",
    "sent_count" integer DEFAULT 0,
    "failed_count" integer DEFAULT 0,
    "send_error" "text",
    "failed_recipients" "jsonb" DEFAULT '[]'::"jsonb",
    "send_breakdown" "jsonb",
    "audience_filter" "text"[],
    "purchase_filter" "jsonb",
    "bypass_safe_send" boolean DEFAULT false NOT NULL,
    CONSTRAINT "campaigns_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text"])))
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contacts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "email" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "custom_fields" "jsonb" DEFAULT '{}'::"jsonb",
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "unsubscribed" boolean DEFAULT false,
    "unsubscribed_at" timestamp with time zone,
    "unsubscribe_token" "text",
    "salesforce_id" "text",
    "record_type" "text",
    "company" "text",
    "source_code" "text",
    "industry" "text",
    "source_code_history" "text",
    "bounce_status" "text" DEFAULT 'none'::"text",
    "bounced_at" timestamp with time zone,
    "last_bounce_campaign_id" "uuid",
    "engagement_score" integer DEFAULT 0,
    "total_opens" integer DEFAULT 0,
    "total_clicks" integer DEFAULT 0,
    "last_engaged_at" timestamp with time zone,
    "form_submissions" "jsonb" DEFAULT '[]'::"jsonb",
    "salesforce_created_date" timestamp with time zone,
    "product_classification" "text"[],
    "is_converted" boolean,
    "converted_date" timestamp with time zone,
    "state" "text",
    "country" "text",
    "job_function" "text",
    "contact_type" "text",
    "account_type" "text",
    "family_id" "uuid",
    "prospect_id" "uuid",
    "utm_params" "jsonb",
    "facts_person_id" integer,
    "portal_access" boolean DEFAULT false NOT NULL,
    "firm_id" "text",
    "intake_summary" "text",
    "intake_data" "jsonb",
    "total_spent" numeric(12,2),
    "order_count" integer,
    "first_order_date" timestamp with time zone,
    "last_order_date" timestamp with time zone,
    "woocommerce_synced_at" timestamp with time zone,
    "content_groups" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "engagement_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_activity_at" timestamp with time zone,
    CONSTRAINT "contacts_bounce_status_check" CHECK (("bounce_status" = ANY (ARRAY['none'::"text", 'soft'::"text", 'hard'::"text"]))),
    CONSTRAINT "contacts_engagement_status_check" CHECK (("engagement_status" = ANY (ARRAY['active'::"text", 'cold'::"text", 'reengaging'::"text", 'sunset'::"text"]))),
    CONSTRAINT "contacts_record_type_check" CHECK (("record_type" = ANY (ARRAY['lead'::"text", 'contact'::"text"])))
);


--
-- Name: COLUMN "contacts"."content_groups"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."contacts"."content_groups" IS 'Access-control: practice-area groups this client may query (e.g. {estate,medicaid}). Empty = baseline content only. Granted by the attorney in the Client Center.';


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."admin_users" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'admin'::"text" NOT NULL,
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "admin_users_role_check" CHECK (("role" = ANY (ARRAY['super_admin'::"text", 'admin'::"text", 'client_admin'::"text"])))
);


--
-- Name: TABLE "admin_users"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."admin_users" IS 'Manages administrative access to the system. Roles: super_admin (full access), admin (all clients), client_admin (specific client only)';


--
-- Name: ai_followup_analytics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_followup_analytics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "draft_id" "uuid" NOT NULL,
    "email" character varying(255) NOT NULL,
    "event_type" character varying(50) NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"(),
    "url" "text",
    "user_agent" "text",
    "ip_address" character varying(45),
    "sg_event_id" character varying(255),
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: ai_followup_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_followup_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" character varying(255) NOT NULL,
    "enabled" boolean DEFAULT false,
    "trigger_tag" character varying(255) DEFAULT 'Sample Request'::character varying,
    "from_email" character varying(255) NOT NULL,
    "from_name" character varying(255) NOT NULL,
    "reply_to" character varying(255),
    "max_followups" integer DEFAULT 3,
    "followup_delays" integer[] DEFAULT '{1,3,7}'::integer[],
    "system_prompt" "text",
    "log_to_salesforce" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "bcc_email" character varying(255),
    "trigger_type" character varying(20) DEFAULT 'tag'::character varying,
    "webhook_key" character varying(64),
    "include_resource_link" boolean DEFAULT false,
    "field_map" "jsonb" DEFAULT '{}'::"jsonb",
    "auto_send" boolean DEFAULT false NOT NULL,
    CONSTRAINT "ai_followup_config_trigger_type_check" CHECK ((("trigger_type")::"text" = ANY ((ARRAY['tag'::character varying, 'webhook'::character varying])::"text"[])))
);


--
-- Name: COLUMN "ai_followup_config"."auto_send"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."ai_followup_config"."auto_send" IS 'Send drafts immediately on generation (skip the approval queue). Failed sends fall back to pending.';


--
-- Name: ai_followup_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_followup_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "config_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying,
    "current_step" integer DEFAULT 0,
    "enrolled_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "last_email_sent_at" timestamp with time zone,
    "next_followup_at" timestamp with time zone,
    "replied" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_followup_contacts_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'opted_out'::character varying])::"text"[])))
);


--
-- Name: ai_followup_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ai_followup_drafts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "followup_contact_id" "uuid",
    "contact_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "config_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "subject" character varying(255),
    "html_content" "text",
    "plain_text" "text",
    "ai_model" character varying(100),
    "ai_prompt_context" "jsonb" DEFAULT '{}'::"jsonb",
    "status" character varying(20) DEFAULT 'pending'::character varying,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "rejection_reason" "text",
    "sent_at" timestamp with time zone,
    "sendgrid_message_id" character varying(255),
    "salesforce_task_id" character varying(255),
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_followup_drafts_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'sent'::character varying, 'failed'::character varying])::"text"[])))
);


--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "prospect_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone,
    "submitted_at" timestamp with time zone,
    "withdrawn_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cairn_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cairn_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "text" NOT NULL,
    "contact_id" "uuid",
    "topic" "text",
    "outcome" "text",
    "transcript" "jsonb",
    "booked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: calendly_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."calendly_integrations" (
    "client_id" "uuid" NOT NULL,
    "access_token" "text" NOT NULL,
    "user_uri" "text" NOT NULL,
    "organization_uri" "text" NOT NULL,
    "webhook_signing_key" "text",
    "webhook_subscription_uri" "text",
    "excluded_event_type_names" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "last_sync_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: campaign_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."campaign_folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: cc_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "cc_campaign_id" "text" NOT NULL,
    "cc_activity_id" "text" NOT NULL,
    "campaign_name" "text",
    "subject" "text",
    "from_email" "text",
    "from_name" "text",
    "current_status" "text",
    "contact_list_ids" "text"[],
    "sent_at" timestamp with time zone,
    "total_sent" integer,
    "opens_count" integer DEFAULT 0 NOT NULL,
    "clicks_count" integer DEFAULT 0 NOT NULL,
    "bounces_count" integer DEFAULT 0 NOT NULL,
    "raw_payload" "jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cc_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_contacts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "cc_contact_id" "text" NOT NULL,
    "email" "text",
    "first_name" "text",
    "last_name" "text",
    "permission" "text",
    "opt_in_source" "text",
    "opt_in_date" timestamp with time zone,
    "opt_out_date" timestamp with time zone,
    "created_at_cc" timestamp with time zone,
    "updated_at_cc" timestamp with time zone,
    "custom_fields" "jsonb",
    "raw" "jsonb",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: cc_decline_list_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_decline_list_members" (
    "client_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "cc_contact_id" "text",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cc_decline_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_decline_sync_runs" (
    "client_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "completed_at" timestamp with time zone,
    "member_count" integer,
    "list_id" "text",
    "error" "text"
);


--
-- Name: cc_engagement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_engagement" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "cc_activity_id" "text" NOT NULL,
    "email_address" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "link_url" "text",
    "url_id" "text",
    "device_type" "text",
    "bounce_code" "text",
    "raw_payload" "jsonb"
);


--
-- Name: cc_engagement_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."cc_engagement_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cc_engagement_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."cc_engagement_id_seq" OWNED BY "public"."cc_engagement"."id";


--
-- Name: cc_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_integrations" (
    "client_id" "uuid" NOT NULL,
    "cc_client_id" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "token_expires_at" timestamp with time zone NOT NULL,
    "last_sync_at" timestamp with time zone,
    "scopes" "text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cc_list_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_list_memberships" (
    "client_id" "uuid" NOT NULL,
    "cc_contact_id" "text" NOT NULL,
    "cc_list_id" "text" NOT NULL
);


--
-- Name: cc_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cc_lists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "cc_list_id" "text" NOT NULL,
    "name" "text",
    "member_count" integer,
    "raw" "jsonb",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sync_runs" (
    "id" bigint NOT NULL,
    "client_id" "uuid",
    "job" "text" NOT NULL,
    "ok" boolean NOT NULL,
    "duration_ms" integer,
    "summary" "jsonb",
    "error" "text",
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text",
    "error_class" "text",
    "rows_written" integer
);


--
-- Name: cc_sync_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."cc_sync_runs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cc_sync_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."cc_sync_runs_id_seq" OWNED BY "public"."sync_runs"."id";


--
-- Name: cfa_consolidated_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cfa_consolidated_people" (
    "email" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "in_cc" boolean DEFAULT false,
    "in_thinkific" boolean DEFAULT false,
    "in_supabase" boolean DEFAULT false,
    "thinkific_buyer" boolean DEFAULT false,
    "cc_permission" "text",
    "sources" "text"[],
    "built_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: TABLE "cfa_consolidated_people"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."cfa_consolidated_people" IS 'CfA contact consolidation (CC + Thinkific + Cvent/Gravity), email-deduped. Built by consolidation/ scripts. Isolated from the live contacts table.';


--
-- Name: cfa_page_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cfa_page_events" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event" "text" NOT NULL,
    "path" "text",
    "referrer" "text",
    "session_id" "text",
    "meta" "jsonb"
);


--
-- Name: cfa_page_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE "public"."cfa_page_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."cfa_page_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."clients" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "sendgrid_api_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "mailing_address" "text",
    "verified_senders" "jsonb" DEFAULT '[]'::"jsonb",
    "salesforce_instance_url" "text",
    "salesforce_access_token" "text",
    "salesforce_refresh_token" "text",
    "salesforce_connected_at" timestamp with time zone,
    "salesforce_connected_by" "text",
    "last_salesforce_sync" timestamp with time zone,
    "salesforce_sync_status" "text",
    "salesforce_sync_message" "text",
    "salesforce_sync_count" integer,
    "salesforce_client_id" "text",
    "salesforce_client_secret" "text",
    "default_utm_params" "text",
    "ip_pool" "text",
    "default_reply_to_email" "text",
    "campaign_sync_status" "text",
    "campaign_sync_message" "text",
    "last_campaign_sync" timestamp with time zone,
    "slug" "text",
    "brand_reference_template_id" "uuid",
    "allowed_domain" "text",
    "enabled_tools" "text"[] DEFAULT '{}'::"text"[],
    "enabled_auth_providers" "text"[] DEFAULT '{email}'::"text"[],
    "s3_prefix" "text",
    "woocommerce_url" "text",
    "woocommerce_consumer_key" "text",
    "woocommerce_consumer_secret" "text",
    "woocommerce_connected_at" timestamp with time zone,
    "woocommerce_sync_status" "text",
    "woocommerce_sync_message" "text",
    "woocommerce_sync_count" integer,
    "last_woocommerce_sync" timestamp with time zone,
    "safe_send_only" boolean DEFAULT false NOT NULL,
    "safe_send_window_days" integer DEFAULT 365 NOT NULL,
    "safe_send_new_days" integer DEFAULT 30 NOT NULL,
    "safe_send_activity_days" integer DEFAULT 60 NOT NULL,
    CONSTRAINT "clients_campaign_sync_status_check" CHECK (("campaign_sync_status" = ANY (ARRAY['idle'::"text", 'syncing'::"text", 'success'::"text", 'error'::"text"]))),
    CONSTRAINT "clients_salesforce_sync_status_check" CHECK (("salesforce_sync_status" = ANY (ARRAY['idle'::"text", 'syncing'::"text", 'success'::"text", 'error'::"text"])))
);


--
-- Name: COLUMN "clients"."default_reply_to_email"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."clients"."default_reply_to_email" IS 'Default reply-to email for campaigns. Used to pre-populate campaign reply-to field.';


--
-- Name: contact_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contact_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "note_type" "text" DEFAULT 'note'::"text" NOT NULL,
    "content" "text" NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "contact_notes_note_type_check" CHECK (("note_type" = ANY (ARRAY['note'::"text", 'email'::"text", 'call'::"text", 'meeting'::"text"])))
);


--
-- Name: contact_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contact_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "due_date" "date",
    "is_completed" boolean DEFAULT false NOT NULL,
    "completed_at" timestamp with time zone,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: cvent_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cvent_attendees" (
    "id" "text" NOT NULL,
    "event_id" "text",
    "contact_email" "text",
    "first_name" "text",
    "last_name" "text",
    "status" "text",
    "registration_path" "text",
    "checked_in" boolean,
    "created_at" timestamp with time zone,
    "last_modified" timestamp with time zone,
    "raw" "jsonb",
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cvent_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cvent_events" (
    "id" "text" NOT NULL,
    "title" "text",
    "code" "text",
    "category" "text",
    "format" "text",
    "currency" "text",
    "timezone" "text",
    "event_status" "text",
    "status" "text",
    "start_at" timestamp with time zone,
    "end_at" timestamp with time zone,
    "created_at" timestamp with time zone,
    "last_modified" timestamp with time zone,
    "raw" "jsonb",
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cvent_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cvent_order_items" (
    "id" "text" NOT NULL,
    "order_id" "text",
    "event_id" "text",
    "attendee_id" "text",
    "product" "text",
    "name" "text",
    "price" numeric,
    "fee" "text",
    "quantity" numeric,
    "amount_ordered" numeric,
    "amount_paid" numeric,
    "amount_due" numeric,
    "deleted" boolean,
    "raw" "jsonb",
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cvent_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cvent_orders" (
    "id" "text" NOT NULL,
    "event_id" "text",
    "attendee_id" "text",
    "number" "text",
    "invoice_number" "text",
    "type" "text",
    "payment_method" "text",
    "reference_number" "text",
    "cancelled" boolean,
    "deleted" boolean,
    "amount_ordered" numeric,
    "amount_paid" numeric,
    "amount_due" numeric,
    "raw" "jsonb",
    "pulled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: dashboard_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."dashboard_summaries" (
    "client_id" "uuid" NOT NULL,
    "generated_for_date" "date" NOT NULL,
    "summary" "text" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: discovered_media_urls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."discovered_media_urls" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "url" "text" NOT NULL,
    "filename" "text",
    "first_seen_in" "text",
    "last_scanned_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: email_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."email_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid",
    "contact_id" "uuid",
    "direction" "text" NOT NULL,
    "subject" "text",
    "body" "text" NOT NULL,
    "ai_generated" boolean DEFAULT false,
    "escalated" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "email_conversations_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"])))
);


--
-- Name: email_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."email_sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "status" "public"."sequence_status" DEFAULT 'draft'::"public"."sequence_status",
    "trigger_type" character varying(50) DEFAULT 'manual'::character varying,
    "trigger_config" "jsonb" DEFAULT '{}'::"jsonb",
    "from_email" character varying(255) NOT NULL,
    "from_name" character varying(255) NOT NULL,
    "reply_to" character varying(255),
    "filter_tags" "text"[] DEFAULT '{}'::"text"[],
    "total_enrolled" integer DEFAULT 0,
    "total_completed" integer DEFAULT 0,
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "start_time" time without time zone,
    "trigger_salesforce_campaign_id" "uuid",
    "trigger_salesforce_campaign_ids" "uuid"[] DEFAULT '{}'::"uuid"[]
);


--
-- Name: enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "program_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "enrolled_at" timestamp with time zone,
    "platform_enrollment_id" "text",
    "raw_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "enrollments_status_check" CHECK (("status" = ANY (ARRAY['registered'::"text", 'cancelled'::"text", 'waitlisted'::"text"])))
);


--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."eval_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "persona" "text" NOT NULL,
    "cases_passed" integer NOT NULL,
    "cases_total" integer NOT NULL,
    "cost_usd" numeric(10,6),
    "details" "jsonb" DEFAULT '[]'::"jsonb",
    "run_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: facts_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."facts_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "facts_student_id" integer NOT NULL,
    "status" "text" NOT NULL,
    "substatus" "text",
    "grade_level" "text",
    "next_status" "text",
    "next_grade_level" "text",
    "school_code" "text",
    "student_first_name" "text",
    "student_last_name" "text",
    "modified_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: facts_inquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."facts_inquiries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "facts_request_id" integer NOT NULL,
    "facts_internal_student_id" integer,
    "inquiry_date" timestamp with time zone,
    "parent_email" "text",
    "parent_first_name" "text",
    "parent_last_name" "text",
    "student_first_name" "text",
    "student_last_name" "text",
    "grade_level" "text",
    "school_year" "text",
    "raw_payload" "jsonb",
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."families" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text",
    "household_phone" "text",
    "household_address" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: form_intake_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."form_intake_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "webhook_key" "text" NOT NULL,
    "form_name" "text",
    "gravity_form_id" integer,
    "field_mappings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: form_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."form_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "form_intake_config_id" "uuid" NOT NULL,
    "gravity_entry_id" "text" NOT NULL,
    "raw_payload" "jsonb" NOT NULL,
    "contact_id" "uuid",
    "prospect_id" "uuid",
    "school_event_id" "uuid",
    "submitted_at" timestamp with time zone NOT NULL,
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_spam" boolean DEFAULT false NOT NULL,
    "spam_reason" "text"
);


--
-- Name: ga4_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ga4_daily" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "property_id" "text" NOT NULL,
    "stat_date" "date" NOT NULL,
    "channel" "text" NOT NULL,
    "sessions" bigint DEFAULT 0 NOT NULL,
    "total_users" bigint DEFAULT 0 NOT NULL,
    "new_users" bigint DEFAULT 0 NOT NULL,
    "engaged_sessions" bigint DEFAULT 0 NOT NULL,
    "key_events" numeric(12,2) DEFAULT 0 NOT NULL,
    "screen_page_views" bigint DEFAULT 0 NOT NULL,
    "engagement_duration_sec" bigint DEFAULT 0 NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ga4_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."ga4_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ga4_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."ga4_daily_id_seq" OWNED BY "public"."ga4_daily"."id";


--
-- Name: ga4_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ga4_integrations" (
    "client_id" "uuid" NOT NULL,
    "property_id" "text" NOT NULL,
    "property_name" "text",
    "time_zone" "text",
    "currency_code" "text",
    "last_sync_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ga4_key_events_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ga4_key_events_daily" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "property_id" "text" NOT NULL,
    "stat_date" "date" NOT NULL,
    "channel" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ga4_key_events_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."ga4_key_events_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ga4_key_events_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."ga4_key_events_daily_id_seq" OWNED BY "public"."ga4_key_events_daily"."id";


--
-- Name: ga4_pages_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ga4_pages_daily" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "property_id" "text",
    "stat_date" "date" NOT NULL,
    "page_path" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "sessions" bigint DEFAULT 0 NOT NULL,
    "screen_page_views" bigint DEFAULT 0 NOT NULL,
    "key_events" numeric(12,2) DEFAULT 0 NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ga4_pages_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."ga4_pages_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ga4_pages_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."ga4_pages_daily_id_seq" OWNED BY "public"."ga4_pages_daily"."id";


--
-- Name: gmail_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."gmail_integrations" (
    "client_id" "uuid" NOT NULL,
    "google_email" "text" NOT NULL,
    "aliases" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "access_token" "text",
    "refresh_token" "text",
    "token_expires_at" timestamp with time zone,
    "scopes" "text"[] NOT NULL,
    "last_history_id" "text",
    "backfill_completed_at" timestamp with time zone,
    "backfill_cursor" "text",
    "last_sync_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: gmail_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."gmail_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "gmail_thread_id" "text" NOT NULL,
    "gmail_message_id" "text" NOT NULL,
    "rfc822_message_id" "text",
    "in_reply_to" "text",
    "references" "text"[],
    "from_email" "text",
    "from_name" "text",
    "to_emails" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "cc_emails" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "bcc_emails" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "subject" "text",
    "snippet" "text",
    "body_text" "text",
    "body_html" "text",
    "sent_at" timestamp with time zone,
    "is_from_owner_inbox" boolean DEFAULT false NOT NULL,
    "labels" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "has_attachments" boolean DEFAULT false NOT NULL,
    "attachment_count" integer DEFAULT 0 NOT NULL,
    "history_id" "text",
    "raw_payload" "jsonb",
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: gmail_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."gmail_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "gmail_thread_id" "text" NOT NULL,
    "subject" "text",
    "participants" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "message_count" integer DEFAULT 0 NOT NULL,
    "first_message_at" timestamp with time zone,
    "last_message_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: google_ads_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."google_ads_campaigns" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "customer_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "campaign_name" "text",
    "campaign_status" "text",
    "stat_date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0 NOT NULL,
    "clicks" bigint DEFAULT 0 NOT NULL,
    "cost_micros" bigint DEFAULT 0 NOT NULL,
    "conversions" numeric(12,2) DEFAULT 0 NOT NULL,
    "conversions_value" numeric(14,2) DEFAULT 0 NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: google_ads_campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."google_ads_campaigns_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: google_ads_campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."google_ads_campaigns_id_seq" OWNED BY "public"."google_ads_campaigns"."id";


--
-- Name: google_ads_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."google_ads_integrations" (
    "client_id" "uuid" NOT NULL,
    "customer_id" "text" NOT NULL,
    "login_customer_id" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "descriptive_name" "text",
    "currency_code" "text",
    "time_zone" "text",
    "last_sync_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: industry_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."industry_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "industry" "text" NOT NULL,
    "link_url" "text" NOT NULL,
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: invite_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."invite_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token" "text" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "client_id" "uuid",
    "created_by" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "invite_tokens_role_check" CHECK (("role" = ANY (ARRAY['super_admin'::"text", 'admin'::"text", 'client_admin'::"text"])))
);


--
-- Name: knowledge_bases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."knowledge_bases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "is_active" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: legal_firms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."legal_firms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "firm_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "attorney_name" "text" NOT NULL,
    "attorney_title" "text" DEFAULT 'Estate Planning Attorney'::"text" NOT NULL,
    "qdrant_collection" "text" NOT NULL,
    "system_prompt" "text" NOT NULL,
    "calendly_url" "text",
    "subdomain" "text",
    "custom_domain" "text",
    "branding" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "attorney_email" "text",
    "content_groups" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "attorney_emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL
);


--
-- Name: COLUMN "legal_firms"."branding"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."legal_firms"."branding" IS 'Keys: primary_color, accent_color, avatar_letter, portal_heading';


--
-- Name: COLUMN "legal_firms"."content_groups"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."legal_firms"."content_groups" IS 'Firm-defined content groups: [{"key","label"}]. Reserved keys staff/baseline are implicit.';


--
-- Name: COLUMN "legal_firms"."attorney_emails"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."legal_firms"."attorney_emails" IS 'All emails with attorney/admin access. The legacy attorney_email is always treated as included.';


--
-- Name: meta_ads_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."meta_ads_daily" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "ad_account_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "campaign_name" "text",
    "stat_date" "date" NOT NULL,
    "spend" numeric(14,2) DEFAULT 0 NOT NULL,
    "impressions" bigint DEFAULT 0 NOT NULL,
    "clicks" bigint DEFAULT 0 NOT NULL,
    "reach" bigint DEFAULT 0 NOT NULL,
    "conversions" numeric(12,2) DEFAULT 0 NOT NULL,
    "actions" "jsonb",
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: meta_ads_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."meta_ads_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meta_ads_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."meta_ads_daily_id_seq" OWNED BY "public"."meta_ads_daily"."id";


--
-- Name: meta_ig_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."meta_ig_daily" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "ig_user_id" "text" NOT NULL,
    "stat_date" "date" NOT NULL,
    "followers" bigint,
    "reach" bigint,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: meta_ig_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."meta_ig_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meta_ig_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."meta_ig_daily_id_seq" OWNED BY "public"."meta_ig_daily"."id";


--
-- Name: meta_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."meta_integrations" (
    "client_id" "uuid" NOT NULL,
    "ad_account_id" "text" NOT NULL,
    "page_id" "text",
    "ig_user_id" "text",
    "business_id" "text",
    "user_access_token" "text" NOT NULL,
    "page_access_token" "text",
    "token_expires_at" timestamp with time zone,
    "ad_account_name" "text",
    "currency_code" "text",
    "time_zone" "text",
    "last_sync_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: meta_page_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."meta_page_daily" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "page_id" "text" NOT NULL,
    "stat_date" "date" NOT NULL,
    "followers" bigint,
    "impressions" bigint,
    "engagements" bigint,
    "views" bigint,
    "new_follows" bigint,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: meta_page_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."meta_page_daily_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meta_page_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."meta_page_daily_id_seq" OWNED BY "public"."meta_page_daily"."id";


--
-- Name: pipeline_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."pipeline_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "prospect_id" "uuid" NOT NULL,
    "from_stage_id" integer,
    "to_stage_id" integer NOT NULL,
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."pipeline_stages" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: pipeline_stages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."pipeline_stages_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pipeline_stages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."pipeline_stages_id_seq" OWNED BY "public"."pipeline_stages"."id";


--
-- Name: portal_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portal_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "firm_id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "token" "text" NOT NULL,
    "invited_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL
);


--
-- Name: portal_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portal_questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "firm_id" "text" NOT NULL,
    "email" "text",
    "question" "text" NOT NULL,
    "answer" "text",
    "escalated" boolean DEFAULT false NOT NULL,
    "top_score" real,
    "asked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "site_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "blocks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_public" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "posts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text"])))
);


--
-- Name: programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."programs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "year" integer NOT NULL,
    "format" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "platform_id" "text" NOT NULL,
    "tag" "text" NOT NULL,
    "instructor" "text",
    "start_date" "date",
    "end_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "programs_format_check" CHECK (("format" = ANY (ARRAY['online'::"text", 'in-person'::"text", 'hybrid'::"text"]))),
    CONSTRAINT "programs_platform_check" CHECK (("platform" = ANY (ARRAY['cvent'::"text", 'gravity_forms'::"text", 'thinkific'::"text", 'manual'::"text"])))
);


--
-- Name: prospects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."prospects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "family_id" "uuid",
    "child_name" "text",
    "grade_applying_for" "text",
    "enrollment_year" "text",
    "current_stage_id" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "student_birthdays_raw" "text",
    "ai_ok" boolean DEFAULT false NOT NULL,
    "birthday_cohort" "text"
);


--
-- Name: reengagement_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."reengagement_config" (
    "client_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "cold_after_days" integer DEFAULT 120 NOT NULL,
    "min_received" integer DEFAULT 3 NOT NULL,
    "protect_customers" boolean DEFAULT true NOT NULL,
    "protected_tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: salesforce_campaign_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."salesforce_campaign_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "salesforce_id" "text" NOT NULL,
    "salesforce_campaign_id" "uuid",
    "contact_id" "uuid",
    "status" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: salesforce_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."salesforce_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "salesforce_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text",
    "status" "text",
    "start_date" timestamp with time zone,
    "end_date" timestamp with time zone,
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: scheduled_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."scheduled_emails" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "enrollment_id" "uuid" NOT NULL,
    "step_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying,
    "sent_at" timestamp with time zone,
    "error_message" "text",
    "attempts" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: school_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."school_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "occurs_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: sequence_analytics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sequence_analytics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "step_id" "uuid" NOT NULL,
    "enrollment_id" "uuid",
    "email" character varying(255) NOT NULL,
    "event_type" character varying(50) NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"(),
    "url" "text",
    "user_agent" "text",
    "ip_address" character varying(45),
    "sg_event_id" character varying(255),
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "sequence_analytics_event_type_check" CHECK ((("event_type")::"text" = ANY ((ARRAY['delivered'::character varying, 'open'::character varying, 'click'::character varying, 'bounce'::character varying, 'spam'::character varying, 'unsubscribe'::character varying, 'block'::character varying])::"text"[])))
);


--
-- Name: sequence_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sequence_enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "status" "public"."enrollment_status" DEFAULT 'active'::"public"."enrollment_status",
    "current_step" integer DEFAULT 0,
    "enrolled_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "paused_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "last_email_sent_at" timestamp with time zone,
    "next_email_scheduled_at" timestamp with time zone,
    "trigger_campaign_id" "uuid"
);


--
-- Name: sequence_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sequence_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "step_order" integer NOT NULL,
    "subject" character varying(255) NOT NULL,
    "template_id" "uuid",
    "html_content" "text",
    "delay_days" integer DEFAULT 0,
    "delay_hours" integer DEFAULT 0,
    "send_time" time without time zone,
    "sent_count" integer DEFAULT 0,
    "open_count" integer DEFAULT 0,
    "click_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "timing_anchor" "text" DEFAULT 'previous_step'::"text" NOT NULL,
    "fixed_send_at" timestamp with time zone,
    CONSTRAINT "sequence_steps_timing_anchor_check" CHECK (("timing_anchor" = ANY (ARRAY['previous_step'::"text", 'fixed_date'::"text"])))
);


--
-- Name: service_health_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."service_health_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "service_name" "text" NOT NULL,
    "url" "text" NOT NULL,
    "ok" boolean NOT NULL,
    "response_time_ms" integer,
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "error" "text",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: site_404_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."site_404_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "path" "text" NOT NULL,
    "referrer" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: site_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."site_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "site_id" "uuid" NOT NULL,
    "subscribed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: sr_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sr_findings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "url" "text",
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "detector" "text",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "verified_at" timestamp with time zone,
    "verified_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sr_findings_kind_check" CHECK (("kind" = ANY (ARRAY['broken_donate_link'::"text", 'broken_apply_link'::"text", 'broken_link'::"text", 'missing_analytics'::"text", 'broken_analytics'::"text", 'no_ssl'::"text", 'mixed_content'::"text", 'slow_page'::"text", 'missing_redirect'::"text", 'other'::"text"]))),
    CONSTRAINT "sr_findings_severity_check" CHECK (("severity" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))
);


--
-- Name: TABLE "sr_findings"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sr_findings" IS 'What is broken or notable at a prospect org. The reason an email is worth sending. Nothing should go out on an unverified finding.';


--
-- Name: sr_orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sr_orgs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "domain" "text",
    "org_type" "text" DEFAULT 'school'::"text",
    "affiliation" "text",
    "city" "text",
    "state_region" "text",
    "country" "text" DEFAULT 'US'::"text",
    "platform" "text",
    "platform_checked_at" timestamp with time zone,
    "tech" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "client_id" "uuid",
    "do_not_contact" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner" "text",
    "snoozed_until" "date",
    "next_action" "text",
    CONSTRAINT "sr_orgs_org_type_check" CHECK (("org_type" = ANY (ARRAY['school'::"text", 'nonprofit'::"text", 'business'::"text", 'other'::"text"]))),
    CONSTRAINT "sr_orgs_owner_check" CHECK ((("owner" IS NULL) OR ("owner" = ANY (ARRAY['sage'::"text", 'rocky'::"text"])))),
    CONSTRAINT "sr_orgs_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'researching'::"text", 'ready'::"text", 'contacted'::"text", 'conversation'::"text", 'client'::"text", 'dead'::"text", 'do_not_contact'::"text"])))
);


--
-- Name: TABLE "sr_orgs"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sr_orgs" IS 'SageRock outbound pipeline: organizations. Internal sales data, NOT client constituent data. See contacts/prospects for those.';


--
-- Name: sr_outreach; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sr_outreach" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "person_id" "uuid",
    "finding_id" "uuid",
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "subject" "text",
    "body_ref" "text",
    "gmail_thread_id" "text",
    "sent_at" timestamp with time zone,
    "replied_at" timestamp with time zone,
    "outcome" "text" DEFAULT 'sent'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "direction" "text",
    "mailbox" "text",
    "participants" "text"[],
    "last_message_at" timestamp with time zone,
    "message_count" integer DEFAULT 0 NOT NULL,
    "matched_on" "text",
    "synced_at" timestamp with time zone,
    CONSTRAINT "sr_outreach_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'linkedin'::"text", 'phone'::"text", 'in_person'::"text", 'other'::"text"]))),
    CONSTRAINT "sr_outreach_direction_check" CHECK ((("direction" IS NULL) OR ("direction" = ANY (ARRAY['outbound'::"text", 'inbound'::"text", 'mixed'::"text"])))),
    CONSTRAINT "sr_outreach_outcome_check" CHECK (("outcome" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'bounced'::"text", 'no_reply'::"text", 'replied'::"text", 'meeting'::"text", 'won'::"text", 'lost'::"text", 'unsubscribed'::"text"])))
);


--
-- Name: TABLE "sr_outreach"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."sr_outreach" IS 'Mostly DERIVED. gmail_thread_id, direction, participants, subject, sent_at, replied_at, last_message_at, message_count and mailbox are written by the sync job and should never be hand-edited -- an edit will be overwritten on the next run. The only human column is `outcome`, and only for terminal decisions (won, lost, unsubscribed). Everything else is observation.';


--
-- Name: sr_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sr_people" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "email" "text",
    "phone" "text",
    "title" "text",
    "role_category" "text",
    "source" "text",
    "verified_at" timestamp with time zone,
    "do_not_contact" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "opted_out_at" timestamp with time zone,
    "opt_out_source" "text",
    CONSTRAINT "sr_people_role_category_check" CHECK (("role_category" = ANY (ARRAY['head'::"text", 'marketing'::"text", 'advancement'::"text", 'admissions'::"text", 'technology'::"text", 'finance'::"text", 'other'::"text"])))
);


--
-- Name: COLUMN "sr_people"."opted_out_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."sr_people"."opted_out_at" IS 'Set once, never cleared. An opt-out is permanent. Enforced by sr_worklist.';


--
-- Name: sr_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sr_sync_state" (
    "mailbox" "text" NOT NULL,
    "last_history_id" "text",
    "last_run_at" timestamp with time zone,
    "last_ok_at" timestamp with time zone,
    "last_error" "text",
    "threads_seen" integer DEFAULT 0 NOT NULL,
    "threads_matched" integer DEFAULT 0 NOT NULL
);


--
-- Name: sr_worklist; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW "public"."sr_worklist" WITH ("security_invoker"='true') AS
 SELECT "o"."id" AS "org_id",
    "o"."name",
    "o"."domain",
    "o"."platform",
    "o"."tech",
    "o"."status",
    "o"."owner",
    "o"."next_action",
    "f"."id" AS "finding_id",
    "f"."summary" AS "why_now",
    "f"."kind" AS "finding_kind",
    "f"."severity",
    "f"."url" AS "finding_url",
    ("f"."verified_at" IS NOT NULL) AS "finding_verified",
    ( SELECT "count"(*) AS "count"
           FROM "public"."sr_findings" "fx"
          WHERE (("fx"."org_id" = "o"."id") AND ("fx"."resolved_at" IS NULL))) AS "open_findings",
    "p"."id" AS "person_id",
    NULLIF(TRIM(BOTH FROM ((COALESCE("p"."first_name", ''::"text") || ' '::"text") || COALESCE("p"."last_name", ''::"text"))), ''::"text") AS "contact_name",
    "p"."email" AS "contact_email",
    "p"."title" AS "contact_title",
    "x"."last_message_at" AS "last_touch_at",
    "x"."mailbox" AS "last_touch_mailbox",
    "x"."gmail_thread_id",
    ("x"."replied_at" IS NOT NULL) AS "replied",
        CASE
            WHEN ("x"."replied_at" IS NOT NULL) THEN 'replied'::"text"
            WHEN ("x"."sent_at" IS NOT NULL) THEN 'awaiting reply'::"text"
            ELSE 'never contacted'::"text"
        END AS "touch_state"
   FROM ((("public"."sr_orgs" "o"
     LEFT JOIN LATERAL ( SELECT "f2"."id",
            "f2"."org_id",
            "f2"."kind",
            "f2"."summary",
            "f2"."url",
            "f2"."severity",
            "f2"."detail",
            "f2"."detector",
            "f2"."first_seen_at",
            "f2"."last_seen_at",
            "f2"."resolved_at",
            "f2"."verified_at",
            "f2"."verified_by",
            "f2"."created_at",
            "f2"."updated_at"
           FROM "public"."sr_findings" "f2"
          WHERE (("f2"."org_id" = "o"."id") AND ("f2"."resolved_at" IS NULL))
          ORDER BY ("f2"."verified_at" IS NOT NULL) DESC,
                CASE "f2"."severity"
                    WHEN 'high'::"text" THEN 1
                    WHEN 'medium'::"text" THEN 2
                    ELSE 3
                END, "f2"."first_seen_at"
         LIMIT 1) "f" ON (true))
     LEFT JOIN LATERAL ( SELECT "p2"."id",
            "p2"."org_id",
            "p2"."first_name",
            "p2"."last_name",
            "p2"."email",
            "p2"."phone",
            "p2"."title",
            "p2"."role_category",
            "p2"."source",
            "p2"."verified_at",
            "p2"."do_not_contact",
            "p2"."notes",
            "p2"."created_at",
            "p2"."updated_at",
            "p2"."opted_out_at",
            "p2"."opt_out_source"
           FROM "public"."sr_people" "p2"
          WHERE (("p2"."org_id" = "o"."id") AND ("p2"."email" IS NOT NULL) AND (NOT "p2"."do_not_contact") AND ("p2"."opted_out_at" IS NULL))
          ORDER BY ("p2"."title" IS NOT NULL) DESC, ("p2"."verified_at" IS NOT NULL) DESC, "p2"."created_at"
         LIMIT 1) "p" ON (true))
     LEFT JOIN LATERAL ( SELECT "x2"."id",
            "x2"."org_id",
            "x2"."person_id",
            "x2"."finding_id",
            "x2"."channel",
            "x2"."subject",
            "x2"."body_ref",
            "x2"."gmail_thread_id",
            "x2"."sent_at",
            "x2"."replied_at",
            "x2"."outcome",
            "x2"."notes",
            "x2"."created_at",
            "x2"."updated_at",
            "x2"."direction",
            "x2"."mailbox",
            "x2"."participants",
            "x2"."last_message_at",
            "x2"."message_count",
            "x2"."matched_on",
            "x2"."synced_at"
           FROM "public"."sr_outreach" "x2"
          WHERE ("x2"."org_id" = "o"."id")
          ORDER BY "x2"."last_message_at" DESC NULLS LAST
         LIMIT 1) "x" ON (true))
  WHERE ((NOT "o"."do_not_contact") AND ("o"."status" <> ALL (ARRAY['dead'::"text", 'do_not_contact'::"text", 'client'::"text"])) AND (("o"."snoozed_until" IS NULL) OR ("o"."snoozed_until" <= CURRENT_DATE)) AND ("p"."id" IS NOT NULL) AND ("f"."id" IS NOT NULL) AND (("x"."last_message_at" IS NULL) OR ("x"."replied_at" IS NOT NULL) OR ("x"."last_message_at" < ("now"() - '14 days'::interval))));


--
-- Name: VIEW "sr_worklist"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW "public"."sr_worklist" IS 'One row per organisation worth contacting today, with the reason attached. Excludes opted-out, snoozed, dead, existing clients, anyone with no contact or no finding, and anyone written to in the last 14 days who has not replied. Replies are NOT excluded -- they sort to the top.';


--
-- Name: subscriber_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."subscriber_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "site_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "type" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscriber_sessions_type_check" CHECK (("type" = ANY (ARRAY['magic_link'::"text", 'session'::"text"])))
);


--
-- Name: sync_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW "public"."sync_health" AS
 WITH "ranked" AS (
         SELECT "s"."id",
            "s"."client_id",
            "s"."job",
            "s"."ok",
            "s"."duration_ms",
            "s"."summary",
            "s"."error",
            "s"."ran_at",
            "s"."status",
            "s"."error_class",
            "s"."rows_written",
            "row_number"() OVER (PARTITION BY "s"."job", "s"."client_id" ORDER BY "s"."ran_at" DESC) AS "rn",
            "lead"("s"."status") OVER (PARTITION BY "s"."job", "s"."client_id" ORDER BY "s"."ran_at" DESC) AS "prev_status"
           FROM "public"."sync_runs" "s"
        )
 SELECT "job",
    "client_id",
    "ran_at" AS "last_attempt_at",
    "status" AS "last_status",
    "error_class",
    "error" AS "last_error",
    "rows_written",
    "duration_ms",
    ( SELECT "max"("s2"."ran_at") AS "max"
           FROM "public"."sync_runs" "s2"
          WHERE (("s2"."job" = "r"."job") AND (NOT ("s2"."client_id" IS DISTINCT FROM "r"."client_id")) AND ("s2"."status" = 'ok'::"text"))) AS "last_success_at",
    ( SELECT "count"(*) AS "count"
           FROM "public"."sync_runs" "s3"
          WHERE (("s3"."job" = "r"."job") AND (NOT ("s3"."client_id" IS DISTINCT FROM "r"."client_id")) AND ("s3"."status" = 'failed'::"text") AND ("s3"."ran_at" > COALESCE(( SELECT "max"("s4"."ran_at") AS "max"
                   FROM "public"."sync_runs" "s4"
                  WHERE (("s4"."job" = "r"."job") AND (NOT ("s4"."client_id" IS DISTINCT FROM "r"."client_id")) AND ("s4"."status" = 'ok'::"text"))), '-infinity'::timestamp with time zone)))) AS "consecutive_failures",
    "prev_status" AS "previous_status"
   FROM "ranked" "r"
  WHERE ("rn" = 1);


--
-- Name: VIEW "sync_health"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW "public"."sync_health" IS 'Derived current state per (job, client_id). previous_status is the status of the run BEFORE the latest, so consumers can detect transitions statelessly. consecutive_failures counts failures since the last success; a job that has NEVER succeeded shows every run as consecutive.';


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "client_id" "uuid",
    "contact_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: template_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."template_folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."templates" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "html_content" "text" NOT NULL,
    "preview_text" "text",
    "thumbnail" "text",
    "client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "folder_id" "uuid",
    "is_starter" boolean DEFAULT false NOT NULL
);


--
-- Name: tours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tours" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "prospect_id" "uuid",
    "scheduled_at" timestamp with time zone,
    "attended" boolean,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "calendly_event_uri" "text",
    "calendly_invitee_uri" "text",
    "calendly_event_type" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "canceled_at" timestamp with time zone,
    "cancel_reason" "text",
    "invitee_email" "text",
    "invitee_name" "text",
    "questions_and_answers" "jsonb",
    "raw_payload" "jsonb"
);


--
-- Name: video_allowed_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."video_allowed_users" (
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'user'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "video_allowed_users_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'admin'::"text"])))
);


--
-- Name: video_generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."video_generations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_by_email" "text" NOT NULL,
    "prompt" "text" NOT NULL,
    "model" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "duration_sec" integer NOT NULL,
    "aspect_ratio" "text" NOT NULL,
    "seed" integer,
    "input_s3_key" "text",
    "runway_task_id" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "output_s3_key" "text",
    "cost_usd" numeric(10,4),
    "failure_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "bridge_from_id" "uuid",
    "bridge_to_id" "uuid",
    CONSTRAINT "video_generations_mode_check" CHECK (("mode" = ANY (ARRAY['text_to_video'::"text", 'image_to_video'::"text", 'uploaded'::"text"]))),
    CONSTRAINT "video_generations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text"])))
);


--
-- Name: visit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."visit_events" (
    "id" bigint NOT NULL,
    "client_id" "uuid" NOT NULL,
    "visitor_id" "uuid" NOT NULL,
    "session_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "url" "text" NOT NULL,
    "path" "text" NOT NULL,
    "referrer" "text",
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "utm_content" "text",
    "utm_term" "text",
    "ua_class" "text",
    "meta" "jsonb"
);


--
-- Name: visit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."visit_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: visit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."visit_events_id_seq" OWNED BY "public"."visit_events"."id";


--
-- Name: woocommerce_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."woocommerce_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "woo_order_id" bigint NOT NULL,
    "email" "text",
    "status" "text",
    "total" numeric(12,2),
    "currency" "text",
    "order_date" timestamp with time zone,
    "line_items" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: cc_engagement id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_engagement" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cc_engagement_id_seq"'::"regclass");


--
-- Name: ga4_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ga4_daily_id_seq"'::"regclass");


--
-- Name: ga4_key_events_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_key_events_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ga4_key_events_daily_id_seq"'::"regclass");


--
-- Name: ga4_pages_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_pages_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ga4_pages_daily_id_seq"'::"regclass");


--
-- Name: google_ads_campaigns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."google_ads_campaigns" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."google_ads_campaigns_id_seq"'::"regclass");


--
-- Name: meta_ads_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ads_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."meta_ads_daily_id_seq"'::"regclass");


--
-- Name: meta_ig_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ig_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."meta_ig_daily_id_seq"'::"regclass");


--
-- Name: meta_page_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_page_daily" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."meta_page_daily_id_seq"'::"regclass");


--
-- Name: pipeline_stages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_stages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pipeline_stages_id_seq"'::"regclass");


--
-- Name: sync_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sync_runs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cc_sync_runs_id_seq"'::"regclass");


--
-- Name: visit_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."visit_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."visit_events_id_seq"'::"regclass");


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id");


--
-- Name: admin_users admin_users_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_key" UNIQUE ("user_id");


--
-- Name: ai_followup_analytics ai_followup_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_analytics"
    ADD CONSTRAINT "ai_followup_analytics_pkey" PRIMARY KEY ("id");


--
-- Name: ai_followup_analytics ai_followup_analytics_sg_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_analytics"
    ADD CONSTRAINT "ai_followup_analytics_sg_event_id_key" UNIQUE ("sg_event_id");


--
-- Name: ai_followup_config ai_followup_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_config"
    ADD CONSTRAINT "ai_followup_config_pkey" PRIMARY KEY ("id");


--
-- Name: ai_followup_contacts ai_followup_contacts_config_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_contacts"
    ADD CONSTRAINT "ai_followup_contacts_config_id_contact_id_key" UNIQUE ("config_id", "contact_id");


--
-- Name: ai_followup_contacts ai_followup_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_contacts"
    ADD CONSTRAINT "ai_followup_contacts_pkey" PRIMARY KEY ("id");


--
-- Name: ai_followup_drafts ai_followup_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_drafts"
    ADD CONSTRAINT "ai_followup_drafts_pkey" PRIMARY KEY ("id");


--
-- Name: analytics_events analytics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id");


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applications"
    ADD CONSTRAINT "applications_pkey" PRIMARY KEY ("id");


--
-- Name: cairn_sessions cairn_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cairn_sessions"
    ADD CONSTRAINT "cairn_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: calendly_integrations calendly_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."calendly_integrations"
    ADD CONSTRAINT "calendly_integrations_pkey" PRIMARY KEY ("client_id");


--
-- Name: campaign_folders campaign_folders_name_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaign_folders"
    ADD CONSTRAINT "campaign_folders_name_client_id_key" UNIQUE ("name", "client_id");


--
-- Name: campaign_folders campaign_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaign_folders"
    ADD CONSTRAINT "campaign_folders_pkey" PRIMARY KEY ("id");


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");


--
-- Name: cc_campaigns cc_campaigns_client_id_cc_activity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_campaigns"
    ADD CONSTRAINT "cc_campaigns_client_id_cc_activity_id_key" UNIQUE ("client_id", "cc_activity_id");


--
-- Name: cc_campaigns cc_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_campaigns"
    ADD CONSTRAINT "cc_campaigns_pkey" PRIMARY KEY ("id");


--
-- Name: cc_contacts cc_contacts_client_id_cc_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_contacts"
    ADD CONSTRAINT "cc_contacts_client_id_cc_contact_id_key" UNIQUE ("client_id", "cc_contact_id");


--
-- Name: cc_contacts cc_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_contacts"
    ADD CONSTRAINT "cc_contacts_pkey" PRIMARY KEY ("id");


--
-- Name: cc_decline_list_members cc_decline_list_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_decline_list_members"
    ADD CONSTRAINT "cc_decline_list_members_pkey" PRIMARY KEY ("client_id", "email");


--
-- Name: cc_decline_sync_runs cc_decline_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_decline_sync_runs"
    ADD CONSTRAINT "cc_decline_sync_runs_pkey" PRIMARY KEY ("client_id");


--
-- Name: cc_engagement cc_engagement_cc_activity_id_email_address_event_type_occur_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_engagement"
    ADD CONSTRAINT "cc_engagement_cc_activity_id_email_address_event_type_occur_key" UNIQUE ("cc_activity_id", "email_address", "event_type", "occurred_at");


--
-- Name: cc_engagement cc_engagement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_engagement"
    ADD CONSTRAINT "cc_engagement_pkey" PRIMARY KEY ("id");


--
-- Name: cc_integrations cc_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_integrations"
    ADD CONSTRAINT "cc_integrations_pkey" PRIMARY KEY ("client_id");


--
-- Name: cc_list_memberships cc_list_memberships_client_id_cc_contact_id_cc_list_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_list_memberships"
    ADD CONSTRAINT "cc_list_memberships_client_id_cc_contact_id_cc_list_id_key" UNIQUE ("client_id", "cc_contact_id", "cc_list_id");


--
-- Name: cc_lists cc_lists_client_id_cc_list_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_lists"
    ADD CONSTRAINT "cc_lists_client_id_cc_list_id_key" UNIQUE ("client_id", "cc_list_id");


--
-- Name: cc_lists cc_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_lists"
    ADD CONSTRAINT "cc_lists_pkey" PRIMARY KEY ("id");


--
-- Name: sync_runs cc_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sync_runs"
    ADD CONSTRAINT "cc_sync_runs_pkey" PRIMARY KEY ("id");


--
-- Name: cfa_consolidated_people cfa_consolidated_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cfa_consolidated_people"
    ADD CONSTRAINT "cfa_consolidated_people_pkey" PRIMARY KEY ("email");


--
-- Name: cfa_page_events cfa_page_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cfa_page_events"
    ADD CONSTRAINT "cfa_page_events_pkey" PRIMARY KEY ("id");


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");


--
-- Name: clients clients_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_slug_key" UNIQUE ("slug");


--
-- Name: contact_notes contact_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contact_notes"
    ADD CONSTRAINT "contact_notes_pkey" PRIMARY KEY ("id");


--
-- Name: contact_tasks contact_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contact_tasks"
    ADD CONSTRAINT "contact_tasks_pkey" PRIMARY KEY ("id");


--
-- Name: contacts contacts_email_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_email_client_id_key" UNIQUE ("email", "client_id");


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");


--
-- Name: contacts contacts_salesforce_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_salesforce_id_unique" UNIQUE ("salesforce_id");


--
-- Name: contacts contacts_unsubscribe_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_unsubscribe_token_key" UNIQUE ("unsubscribe_token");


--
-- Name: cvent_attendees cvent_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_attendees"
    ADD CONSTRAINT "cvent_attendees_pkey" PRIMARY KEY ("id");


--
-- Name: cvent_events cvent_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_events"
    ADD CONSTRAINT "cvent_events_pkey" PRIMARY KEY ("id");


--
-- Name: cvent_order_items cvent_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_order_items"
    ADD CONSTRAINT "cvent_order_items_pkey" PRIMARY KEY ("id");


--
-- Name: cvent_orders cvent_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_orders"
    ADD CONSTRAINT "cvent_orders_pkey" PRIMARY KEY ("id");


--
-- Name: dashboard_summaries dashboard_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboard_summaries"
    ADD CONSTRAINT "dashboard_summaries_pkey" PRIMARY KEY ("client_id", "generated_for_date");


--
-- Name: discovered_media_urls discovered_media_urls_client_id_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."discovered_media_urls"
    ADD CONSTRAINT "discovered_media_urls_client_id_url_key" UNIQUE ("client_id", "url");


--
-- Name: discovered_media_urls discovered_media_urls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."discovered_media_urls"
    ADD CONSTRAINT "discovered_media_urls_pkey" PRIMARY KEY ("id");


--
-- Name: email_conversations email_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_conversations"
    ADD CONSTRAINT "email_conversations_pkey" PRIMARY KEY ("id");


--
-- Name: email_sequences email_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_sequences"
    ADD CONSTRAINT "email_sequences_pkey" PRIMARY KEY ("id");


--
-- Name: enrollments enrollments_contact_id_program_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."enrollments"
    ADD CONSTRAINT "enrollments_contact_id_program_id_key" UNIQUE ("contact_id", "program_id");


--
-- Name: enrollments enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."enrollments"
    ADD CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id");


--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."eval_runs"
    ADD CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id");


--
-- Name: facts_applications facts_applications_client_id_facts_student_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_applications"
    ADD CONSTRAINT "facts_applications_client_id_facts_student_id_key" UNIQUE ("client_id", "facts_student_id");


--
-- Name: facts_applications facts_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_applications"
    ADD CONSTRAINT "facts_applications_pkey" PRIMARY KEY ("id");


--
-- Name: facts_inquiries facts_inquiries_client_id_facts_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_inquiries"
    ADD CONSTRAINT "facts_inquiries_client_id_facts_request_id_key" UNIQUE ("client_id", "facts_request_id");


--
-- Name: facts_inquiries facts_inquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_inquiries"
    ADD CONSTRAINT "facts_inquiries_pkey" PRIMARY KEY ("id");


--
-- Name: families families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_pkey" PRIMARY KEY ("id");


--
-- Name: form_intake_configs form_intake_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_intake_configs"
    ADD CONSTRAINT "form_intake_configs_pkey" PRIMARY KEY ("id");


--
-- Name: form_intake_configs form_intake_configs_webhook_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_intake_configs"
    ADD CONSTRAINT "form_intake_configs_webhook_key_key" UNIQUE ("webhook_key");


--
-- Name: form_submissions form_submissions_form_intake_config_id_gravity_entry_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_form_intake_config_id_gravity_entry_id_key" UNIQUE ("form_intake_config_id", "gravity_entry_id");


--
-- Name: form_submissions form_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id");


--
-- Name: ga4_daily ga4_daily_client_id_stat_date_channel_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_daily"
    ADD CONSTRAINT "ga4_daily_client_id_stat_date_channel_key" UNIQUE ("client_id", "stat_date", "channel");


--
-- Name: ga4_daily ga4_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_daily"
    ADD CONSTRAINT "ga4_daily_pkey" PRIMARY KEY ("id");


--
-- Name: ga4_integrations ga4_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_integrations"
    ADD CONSTRAINT "ga4_integrations_pkey" PRIMARY KEY ("client_id");


--
-- Name: ga4_key_events_daily ga4_key_events_daily_client_id_stat_date_channel_event_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_key_events_daily"
    ADD CONSTRAINT "ga4_key_events_daily_client_id_stat_date_channel_event_name_key" UNIQUE ("client_id", "stat_date", "channel", "event_name");


--
-- Name: ga4_key_events_daily ga4_key_events_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_key_events_daily"
    ADD CONSTRAINT "ga4_key_events_daily_pkey" PRIMARY KEY ("id");


--
-- Name: ga4_pages_daily ga4_pages_daily_client_id_stat_date_page_path_channel_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_pages_daily"
    ADD CONSTRAINT "ga4_pages_daily_client_id_stat_date_page_path_channel_key" UNIQUE ("client_id", "stat_date", "page_path", "channel");


--
-- Name: ga4_pages_daily ga4_pages_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_pages_daily"
    ADD CONSTRAINT "ga4_pages_daily_pkey" PRIMARY KEY ("id");


--
-- Name: gmail_integrations gmail_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_integrations"
    ADD CONSTRAINT "gmail_integrations_pkey" PRIMARY KEY ("client_id");


--
-- Name: gmail_messages gmail_messages_client_id_gmail_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_messages"
    ADD CONSTRAINT "gmail_messages_client_id_gmail_message_id_key" UNIQUE ("client_id", "gmail_message_id");


--
-- Name: gmail_messages gmail_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_messages"
    ADD CONSTRAINT "gmail_messages_pkey" PRIMARY KEY ("id");


--
-- Name: gmail_threads gmail_threads_client_id_gmail_thread_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_threads"
    ADD CONSTRAINT "gmail_threads_client_id_gmail_thread_id_key" UNIQUE ("client_id", "gmail_thread_id");


--
-- Name: gmail_threads gmail_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_threads"
    ADD CONSTRAINT "gmail_threads_pkey" PRIMARY KEY ("id");


--
-- Name: google_ads_campaigns google_ads_campaigns_client_id_campaign_id_stat_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."google_ads_campaigns"
    ADD CONSTRAINT "google_ads_campaigns_client_id_campaign_id_stat_date_key" UNIQUE ("client_id", "campaign_id", "stat_date");


--
-- Name: google_ads_campaigns google_ads_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."google_ads_campaigns"
    ADD CONSTRAINT "google_ads_campaigns_pkey" PRIMARY KEY ("id");


--
-- Name: google_ads_integrations google_ads_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."google_ads_integrations"
    ADD CONSTRAINT "google_ads_integrations_pkey" PRIMARY KEY ("client_id");


--
-- Name: industry_links industry_links_industry_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."industry_links"
    ADD CONSTRAINT "industry_links_industry_client_id_key" UNIQUE ("industry", "client_id");


--
-- Name: industry_links industry_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."industry_links"
    ADD CONSTRAINT "industry_links_pkey" PRIMARY KEY ("id");


--
-- Name: invite_tokens invite_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id");


--
-- Name: invite_tokens invite_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_token_key" UNIQUE ("token");


--
-- Name: knowledge_bases knowledge_bases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."knowledge_bases"
    ADD CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id");


--
-- Name: legal_firms legal_firms_custom_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."legal_firms"
    ADD CONSTRAINT "legal_firms_custom_domain_key" UNIQUE ("custom_domain");


--
-- Name: legal_firms legal_firms_firm_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."legal_firms"
    ADD CONSTRAINT "legal_firms_firm_id_key" UNIQUE ("firm_id");


--
-- Name: legal_firms legal_firms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."legal_firms"
    ADD CONSTRAINT "legal_firms_pkey" PRIMARY KEY ("id");


--
-- Name: legal_firms legal_firms_subdomain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."legal_firms"
    ADD CONSTRAINT "legal_firms_subdomain_key" UNIQUE ("subdomain");


--
-- Name: meta_ads_daily meta_ads_daily_client_id_campaign_id_stat_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ads_daily"
    ADD CONSTRAINT "meta_ads_daily_client_id_campaign_id_stat_date_key" UNIQUE ("client_id", "campaign_id", "stat_date");


--
-- Name: meta_ads_daily meta_ads_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ads_daily"
    ADD CONSTRAINT "meta_ads_daily_pkey" PRIMARY KEY ("id");


--
-- Name: meta_ig_daily meta_ig_daily_client_id_stat_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ig_daily"
    ADD CONSTRAINT "meta_ig_daily_client_id_stat_date_key" UNIQUE ("client_id", "stat_date");


--
-- Name: meta_ig_daily meta_ig_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ig_daily"
    ADD CONSTRAINT "meta_ig_daily_pkey" PRIMARY KEY ("id");


--
-- Name: meta_integrations meta_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_integrations"
    ADD CONSTRAINT "meta_integrations_pkey" PRIMARY KEY ("client_id");


--
-- Name: meta_page_daily meta_page_daily_client_id_stat_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_page_daily"
    ADD CONSTRAINT "meta_page_daily_client_id_stat_date_key" UNIQUE ("client_id", "stat_date");


--
-- Name: meta_page_daily meta_page_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_page_daily"
    ADD CONSTRAINT "meta_page_daily_pkey" PRIMARY KEY ("id");


--
-- Name: pipeline_history pipeline_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_history"
    ADD CONSTRAINT "pipeline_history_pkey" PRIMARY KEY ("id");


--
-- Name: pipeline_stages pipeline_stages_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_stages"
    ADD CONSTRAINT "pipeline_stages_name_key" UNIQUE ("name");


--
-- Name: pipeline_stages pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_stages"
    ADD CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id");


--
-- Name: pipeline_stages pipeline_stages_sort_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_stages"
    ADD CONSTRAINT "pipeline_stages_sort_order_key" UNIQUE ("sort_order");


--
-- Name: portal_invites portal_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_invites"
    ADD CONSTRAINT "portal_invites_pkey" PRIMARY KEY ("id");


--
-- Name: portal_invites portal_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_invites"
    ADD CONSTRAINT "portal_invites_token_key" UNIQUE ("token");


--
-- Name: portal_questions portal_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_questions"
    ADD CONSTRAINT "portal_questions_pkey" PRIMARY KEY ("id");


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("id");


--
-- Name: posts posts_site_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_site_id_slug_key" UNIQUE ("site_id", "slug");


--
-- Name: programs programs_client_id_platform_platform_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."programs"
    ADD CONSTRAINT "programs_client_id_platform_platform_id_key" UNIQUE ("client_id", "platform", "platform_id");


--
-- Name: programs programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."programs"
    ADD CONSTRAINT "programs_pkey" PRIMARY KEY ("id");


--
-- Name: prospects prospects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_pkey" PRIMARY KEY ("id");


--
-- Name: reengagement_config reengagement_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reengagement_config"
    ADD CONSTRAINT "reengagement_config_pkey" PRIMARY KEY ("client_id");


--
-- Name: salesforce_campaign_members salesforce_campaign_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaign_members"
    ADD CONSTRAINT "salesforce_campaign_members_pkey" PRIMARY KEY ("id");


--
-- Name: salesforce_campaign_members salesforce_campaign_members_salesforce_id_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaign_members"
    ADD CONSTRAINT "salesforce_campaign_members_salesforce_id_client_id_key" UNIQUE ("salesforce_id", "client_id");


--
-- Name: salesforce_campaigns salesforce_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaigns"
    ADD CONSTRAINT "salesforce_campaigns_pkey" PRIMARY KEY ("id");


--
-- Name: salesforce_campaigns salesforce_campaigns_salesforce_id_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaigns"
    ADD CONSTRAINT "salesforce_campaigns_salesforce_id_client_id_key" UNIQUE ("salesforce_id", "client_id");


--
-- Name: scheduled_emails scheduled_emails_enrollment_step_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_enrollment_step_unique" UNIQUE ("enrollment_id", "step_id");


--
-- Name: scheduled_emails scheduled_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_pkey" PRIMARY KEY ("id");


--
-- Name: school_events school_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."school_events"
    ADD CONSTRAINT "school_events_pkey" PRIMARY KEY ("id");


--
-- Name: sequence_analytics sequence_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_analytics"
    ADD CONSTRAINT "sequence_analytics_pkey" PRIMARY KEY ("id");


--
-- Name: sequence_enrollments sequence_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id");


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_id_contact_id_key" UNIQUE ("sequence_id", "contact_id");


--
-- Name: sequence_steps sequence_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id");


--
-- Name: sequence_steps sequence_steps_sequence_id_step_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_sequence_id_step_order_key" UNIQUE ("sequence_id", "step_order");


--
-- Name: service_health_checks service_health_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."service_health_checks"
    ADD CONSTRAINT "service_health_checks_pkey" PRIMARY KEY ("id");


--
-- Name: site_404_log site_404_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."site_404_log"
    ADD CONSTRAINT "site_404_log_pkey" PRIMARY KEY ("id");


--
-- Name: site_subscriptions site_subscriptions_contact_id_site_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."site_subscriptions"
    ADD CONSTRAINT "site_subscriptions_contact_id_site_id_key" UNIQUE ("contact_id", "site_id");


--
-- Name: site_subscriptions site_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."site_subscriptions"
    ADD CONSTRAINT "site_subscriptions_pkey" PRIMARY KEY ("id");


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sites"
    ADD CONSTRAINT "sites_pkey" PRIMARY KEY ("id");


--
-- Name: sites sites_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sites"
    ADD CONSTRAINT "sites_slug_key" UNIQUE ("slug");


--
-- Name: sr_findings sr_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_findings"
    ADD CONSTRAINT "sr_findings_pkey" PRIMARY KEY ("id");


--
-- Name: sr_orgs sr_orgs_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_orgs"
    ADD CONSTRAINT "sr_orgs_domain_key" UNIQUE ("domain");


--
-- Name: sr_orgs sr_orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_orgs"
    ADD CONSTRAINT "sr_orgs_pkey" PRIMARY KEY ("id");


--
-- Name: sr_outreach sr_outreach_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_outreach"
    ADD CONSTRAINT "sr_outreach_pkey" PRIMARY KEY ("id");


--
-- Name: sr_people sr_people_email_per_org; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_people"
    ADD CONSTRAINT "sr_people_email_per_org" UNIQUE ("org_id", "email");


--
-- Name: sr_people sr_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_people"
    ADD CONSTRAINT "sr_people_pkey" PRIMARY KEY ("id");


--
-- Name: sr_sync_state sr_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_sync_state"
    ADD CONSTRAINT "sr_sync_state_pkey" PRIMARY KEY ("mailbox");


--
-- Name: subscriber_sessions subscriber_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriber_sessions"
    ADD CONSTRAINT "subscriber_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: subscriber_sessions subscriber_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriber_sessions"
    ADD CONSTRAINT "subscriber_sessions_token_hash_key" UNIQUE ("token_hash");


--
-- Name: tags tags_name_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_name_client_id_key" UNIQUE ("name", "client_id");


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");


--
-- Name: template_folders template_folders_name_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."template_folders"
    ADD CONSTRAINT "template_folders_name_client_id_key" UNIQUE ("name", "client_id");


--
-- Name: template_folders template_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."template_folders"
    ADD CONSTRAINT "template_folders_pkey" PRIMARY KEY ("id");


--
-- Name: templates templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_pkey" PRIMARY KEY ("id");


--
-- Name: tours tours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tours"
    ADD CONSTRAINT "tours_pkey" PRIMARY KEY ("id");


--
-- Name: video_allowed_users video_allowed_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."video_allowed_users"
    ADD CONSTRAINT "video_allowed_users_pkey" PRIMARY KEY ("email");


--
-- Name: video_generations video_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."video_generations"
    ADD CONSTRAINT "video_generations_pkey" PRIMARY KEY ("id");


--
-- Name: visit_events visit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."visit_events"
    ADD CONSTRAINT "visit_events_pkey" PRIMARY KEY ("id");


--
-- Name: woocommerce_orders woocommerce_orders_client_id_woo_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."woocommerce_orders"
    ADD CONSTRAINT "woocommerce_orders_client_id_woo_order_id_key" UNIQUE ("client_id", "woo_order_id");


--
-- Name: woocommerce_orders woocommerce_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."woocommerce_orders"
    ADD CONSTRAINT "woocommerce_orders_pkey" PRIMARY KEY ("id");


--
-- Name: cairn_sessions_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cairn_sessions_contact_id_idx" ON "public"."cairn_sessions" USING "btree" ("contact_id");


--
-- Name: cairn_sessions_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cairn_sessions_outcome_idx" ON "public"."cairn_sessions" USING "btree" ("outcome");


--
-- Name: cairn_sessions_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cairn_sessions_session_id_idx" ON "public"."cairn_sessions" USING "btree" ("session_id");


--
-- Name: cfa_page_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cfa_page_events_created_idx" ON "public"."cfa_page_events" USING "btree" ("created_at");


--
-- Name: contacts_portal_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "contacts_portal_lookup_idx" ON "public"."contacts" USING "btree" ("firm_id", "email", "portal_access") WHERE ("portal_access" = true);


--
-- Name: cvent_attendees_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cvent_attendees_email_idx" ON "public"."cvent_attendees" USING "btree" ("lower"("contact_email"));


--
-- Name: cvent_attendees_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cvent_attendees_event_idx" ON "public"."cvent_attendees" USING "btree" ("event_id");


--
-- Name: cvent_order_items_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cvent_order_items_event_idx" ON "public"."cvent_order_items" USING "btree" ("event_id");


--
-- Name: cvent_order_items_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cvent_order_items_order_idx" ON "public"."cvent_order_items" USING "btree" ("order_id");


--
-- Name: cvent_orders_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cvent_orders_event_idx" ON "public"."cvent_orders" USING "btree" ("event_id");


--
-- Name: enrollments_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "enrollments_client_id_idx" ON "public"."enrollments" USING "btree" ("client_id");


--
-- Name: enrollments_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "enrollments_contact_id_idx" ON "public"."enrollments" USING "btree" ("contact_id");


--
-- Name: enrollments_platform_enrollment_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "enrollments_platform_enrollment_id_key" ON "public"."enrollments" USING "btree" ("client_id", "platform_enrollment_id") WHERE ("platform_enrollment_id" IS NOT NULL);


--
-- Name: enrollments_program_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "enrollments_program_id_idx" ON "public"."enrollments" USING "btree" ("program_id");


--
-- Name: enrollments_program_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "enrollments_program_id_status_idx" ON "public"."enrollments" USING "btree" ("program_id", "status");


--
-- Name: enrollments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "enrollments_status_idx" ON "public"."enrollments" USING "btree" ("status");


--
-- Name: idx_admin_users_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_admin_users_client_id" ON "public"."admin_users" USING "btree" ("client_id");


--
-- Name: idx_admin_users_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_admin_users_user_id" ON "public"."admin_users" USING "btree" ("user_id");


--
-- Name: idx_ai_config_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_config_client_id" ON "public"."ai_followup_config" USING "btree" ("client_id");


--
-- Name: idx_ai_config_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_config_enabled" ON "public"."ai_followup_config" USING "btree" ("client_id", "enabled") WHERE ("enabled" = true);


--
-- Name: idx_ai_config_webhook_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_ai_config_webhook_key" ON "public"."ai_followup_config" USING "btree" ("webhook_key") WHERE ("webhook_key" IS NOT NULL);


--
-- Name: idx_ai_contacts_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_contacts_client_id" ON "public"."ai_followup_contacts" USING "btree" ("client_id");


--
-- Name: idx_ai_contacts_config_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_contacts_config_id" ON "public"."ai_followup_contacts" USING "btree" ("config_id");


--
-- Name: idx_ai_contacts_next_followup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_contacts_next_followup" ON "public"."ai_followup_contacts" USING "btree" ("next_followup_at") WHERE (("status")::"text" = 'in_progress'::"text");


--
-- Name: idx_ai_contacts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_contacts_status" ON "public"."ai_followup_contacts" USING "btree" ("status");


--
-- Name: idx_ai_drafts_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_drafts_client_id" ON "public"."ai_followup_drafts" USING "btree" ("client_id");


--
-- Name: idx_ai_drafts_config_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_drafts_config_id" ON "public"."ai_followup_drafts" USING "btree" ("config_id");


--
-- Name: idx_ai_drafts_followup_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_drafts_followup_contact" ON "public"."ai_followup_drafts" USING "btree" ("followup_contact_id");


--
-- Name: idx_ai_drafts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_drafts_status" ON "public"."ai_followup_drafts" USING "btree" ("status");


--
-- Name: idx_ai_followup_analytics_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_followup_analytics_draft_id" ON "public"."ai_followup_analytics" USING "btree" ("draft_id");


--
-- Name: idx_ai_followup_analytics_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_followup_analytics_email" ON "public"."ai_followup_analytics" USING "btree" ("email");


--
-- Name: idx_ai_followup_analytics_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ai_followup_analytics_event_type" ON "public"."ai_followup_analytics" USING "btree" ("event_type");


--
-- Name: idx_analytics_campaign_event_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_campaign_event_email" ON "public"."analytics_events" USING "btree" ("campaign_id", "event_type", "email");


--
-- Name: idx_analytics_campaign_event_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_campaign_event_url" ON "public"."analytics_events" USING "btree" ("campaign_id", "event_type", "url");


--
-- Name: idx_analytics_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_campaign_id" ON "public"."analytics_events" USING "btree" ("campaign_id");


--
-- Name: idx_analytics_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_email" ON "public"."analytics_events" USING "btree" ("email");


--
-- Name: idx_analytics_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_event_type" ON "public"."analytics_events" USING "btree" ("event_type");


--
-- Name: idx_analytics_events_campaign_click; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_events_campaign_click" ON "public"."analytics_events" USING "btree" ("campaign_id", "event_type", "email") WHERE ("event_type" = 'click'::"text");


--
-- Name: idx_analytics_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_analytics_timestamp" ON "public"."analytics_events" USING "btree" ("timestamp");


--
-- Name: idx_analytics_unique_click; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_analytics_unique_click" ON "public"."analytics_events" USING "btree" ("campaign_id", "email", COALESCE("url", ''::"text")) WHERE ("event_type" = 'click'::"text");


--
-- Name: idx_analytics_unique_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_analytics_unique_delivery" ON "public"."analytics_events" USING "btree" ("campaign_id", "email", "event_type") WHERE ("event_type" = ANY (ARRAY['delivered'::"text", 'bounce'::"text", 'spam'::"text", 'unsubscribe'::"text", 'block'::"text"]));


--
-- Name: idx_analytics_unique_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_analytics_unique_open" ON "public"."analytics_events" USING "btree" ("campaign_id", "email") WHERE ("event_type" = 'open'::"text");


--
-- Name: idx_applications_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_applications_client_id" ON "public"."applications" USING "btree" ("client_id");


--
-- Name: idx_applications_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_applications_prospect_id" ON "public"."applications" USING "btree" ("prospect_id");


--
-- Name: idx_campaign_folders_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_campaign_folders_client_id" ON "public"."campaign_folders" USING "btree" ("client_id");


--
-- Name: idx_campaigns_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_campaigns_client_id" ON "public"."campaigns" USING "btree" ("client_id");


--
-- Name: idx_campaigns_folder_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_campaigns_folder_id" ON "public"."campaigns" USING "btree" ("folder_id");


--
-- Name: idx_campaigns_salesforce_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_campaigns_salesforce_campaign_id" ON "public"."campaigns" USING "btree" ("salesforce_campaign_id");


--
-- Name: idx_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_campaigns_status" ON "public"."campaigns" USING "btree" ("status");


--
-- Name: idx_cc_campaigns_client_sent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_campaigns_client_sent" ON "public"."cc_campaigns" USING "btree" ("client_id", "sent_at" DESC);


--
-- Name: idx_cc_contacts_client_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_contacts_client_email" ON "public"."cc_contacts" USING "btree" ("client_id", "email");


--
-- Name: idx_cc_contacts_client_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_contacts_client_updated" ON "public"."cc_contacts" USING "btree" ("client_id", "updated_at_cc");


--
-- Name: idx_cc_decline_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_decline_lookup" ON "public"."cc_decline_list_members" USING "btree" ("client_id", "email");


--
-- Name: idx_cc_engagement_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_engagement_activity" ON "public"."cc_engagement" USING "btree" ("cc_activity_id");


--
-- Name: idx_cc_engagement_client_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_engagement_client_time" ON "public"."cc_engagement" USING "btree" ("client_id", "occurred_at" DESC);


--
-- Name: idx_cc_engagement_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_engagement_email" ON "public"."cc_engagement" USING "btree" ("email_address");


--
-- Name: idx_cc_list_memberships_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_cc_list_memberships_list" ON "public"."cc_list_memberships" USING "btree" ("client_id", "cc_list_id");


--
-- Name: idx_contact_notes_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_notes_client_id" ON "public"."contact_notes" USING "btree" ("client_id");


--
-- Name: idx_contact_notes_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_notes_contact_id" ON "public"."contact_notes" USING "btree" ("contact_id");


--
-- Name: idx_contact_notes_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_notes_created_at" ON "public"."contact_notes" USING "btree" ("created_at" DESC);


--
-- Name: idx_contact_tasks_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_tasks_client_id" ON "public"."contact_tasks" USING "btree" ("client_id");


--
-- Name: idx_contact_tasks_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_tasks_contact_id" ON "public"."contact_tasks" USING "btree" ("contact_id");


--
-- Name: idx_contact_tasks_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_tasks_due_date" ON "public"."contact_tasks" USING "btree" ("due_date") WHERE (NOT "is_completed");


--
-- Name: idx_contact_tasks_is_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contact_tasks_is_completed" ON "public"."contact_tasks" USING "btree" ("is_completed");


--
-- Name: idx_contacts_account_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_account_type" ON "public"."contacts" USING "btree" ("account_type");


--
-- Name: idx_contacts_bounce_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_bounce_status" ON "public"."contacts" USING "btree" ("bounce_status");


--
-- Name: idx_contacts_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_client_id" ON "public"."contacts" USING "btree" ("client_id");


--
-- Name: idx_contacts_contact_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_contact_type" ON "public"."contacts" USING "btree" ("contact_type");


--
-- Name: idx_contacts_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_country" ON "public"."contacts" USING "btree" ("country");


--
-- Name: idx_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_email" ON "public"."contacts" USING "btree" ("email");


--
-- Name: idx_contacts_engagement_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_engagement_score" ON "public"."contacts" USING "btree" ("engagement_score" DESC);


--
-- Name: idx_contacts_engagement_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_engagement_status" ON "public"."contacts" USING "btree" ("client_id", "engagement_status");


--
-- Name: idx_contacts_facts_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_facts_person" ON "public"."contacts" USING "btree" ("client_id", "facts_person_id") WHERE ("facts_person_id" IS NOT NULL);


--
-- Name: idx_contacts_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_family_id" ON "public"."contacts" USING "btree" ("family_id");


--
-- Name: idx_contacts_industry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_industry" ON "public"."contacts" USING "btree" ("industry");


--
-- Name: idx_contacts_is_converted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_is_converted" ON "public"."contacts" USING "btree" ("is_converted");


--
-- Name: idx_contacts_job_function; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_job_function" ON "public"."contacts" USING "btree" ("job_function");


--
-- Name: idx_contacts_product_classification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_product_classification" ON "public"."contacts" USING "gin" ("product_classification");


--
-- Name: idx_contacts_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_prospect_id" ON "public"."contacts" USING "btree" ("prospect_id");


--
-- Name: idx_contacts_record_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_record_type" ON "public"."contacts" USING "btree" ("record_type");


--
-- Name: idx_contacts_salesforce_created_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_salesforce_created_date" ON "public"."contacts" USING "btree" ("salesforce_created_date");


--
-- Name: idx_contacts_source_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_source_code" ON "public"."contacts" USING "btree" ("source_code");


--
-- Name: idx_contacts_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_state" ON "public"."contacts" USING "btree" ("state");


--
-- Name: idx_contacts_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_tags" ON "public"."contacts" USING "gin" ("tags");


--
-- Name: idx_contacts_unsubscribe_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_unsubscribe_token" ON "public"."contacts" USING "btree" ("unsubscribe_token");


--
-- Name: idx_contacts_unsubscribed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_unsubscribed" ON "public"."contacts" USING "btree" ("unsubscribed");


--
-- Name: idx_contacts_utm_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_contacts_utm_source" ON "public"."contacts" USING "btree" ((("utm_params" ->> 'source'::"text")));


--
-- Name: idx_discovered_media_urls_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_discovered_media_urls_client" ON "public"."discovered_media_urls" USING "btree" ("client_id");


--
-- Name: idx_email_conversations_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_email_conversations_client_id" ON "public"."email_conversations" USING "btree" ("client_id");


--
-- Name: idx_email_conversations_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_email_conversations_contact_id" ON "public"."email_conversations" USING "btree" ("contact_id");


--
-- Name: idx_email_conversations_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_email_conversations_created_at" ON "public"."email_conversations" USING "btree" ("created_at" DESC);


--
-- Name: idx_enrollments_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_enrollments_contact_id" ON "public"."sequence_enrollments" USING "btree" ("contact_id");


--
-- Name: idx_enrollments_next_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_enrollments_next_email" ON "public"."sequence_enrollments" USING "btree" ("next_email_scheduled_at") WHERE ("status" = 'active'::"public"."enrollment_status");


--
-- Name: idx_enrollments_sequence_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_enrollments_sequence_id" ON "public"."sequence_enrollments" USING "btree" ("sequence_id");


--
-- Name: idx_enrollments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_enrollments_status" ON "public"."sequence_enrollments" USING "btree" ("status");


--
-- Name: idx_eval_runs_persona_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_eval_runs_persona_run" ON "public"."eval_runs" USING "btree" ("persona", "run_at" DESC);


--
-- Name: idx_facts_applications_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_facts_applications_contact" ON "public"."facts_applications" USING "btree" ("contact_id", "status") WHERE ("contact_id" IS NOT NULL);


--
-- Name: idx_facts_applications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_facts_applications_status" ON "public"."facts_applications" USING "btree" ("client_id", "status", "modified_at" DESC);


--
-- Name: idx_facts_inquiries_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_facts_inquiries_email" ON "public"."facts_inquiries" USING "btree" ("client_id", "lower"("parent_email")) WHERE ("parent_email" IS NOT NULL);


--
-- Name: idx_facts_inquiries_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_facts_inquiries_year" ON "public"."facts_inquiries" USING "btree" ("client_id", "inquiry_date" DESC) WHERE ("inquiry_date" IS NOT NULL);


--
-- Name: idx_families_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_families_client_id" ON "public"."families" USING "btree" ("client_id");


--
-- Name: idx_form_intake_configs_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_form_intake_configs_client_id" ON "public"."form_intake_configs" USING "btree" ("client_id");


--
-- Name: idx_form_intake_configs_webhook_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_form_intake_configs_webhook_key" ON "public"."form_intake_configs" USING "btree" ("webhook_key");


--
-- Name: idx_form_submissions_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_form_submissions_client" ON "public"."form_submissions" USING "btree" ("client_id", "submitted_at" DESC);


--
-- Name: idx_form_submissions_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_form_submissions_contact" ON "public"."form_submissions" USING "btree" ("contact_id");


--
-- Name: idx_form_submissions_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_form_submissions_prospect" ON "public"."form_submissions" USING "btree" ("prospect_id");


--
-- Name: idx_form_submissions_spam; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_form_submissions_spam" ON "public"."form_submissions" USING "btree" ("client_id", "is_spam") WHERE ("is_spam" = true);


--
-- Name: idx_ga4_daily_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ga4_daily_client_date" ON "public"."ga4_daily" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_ga4_ked_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ga4_ked_client_date" ON "public"."ga4_key_events_daily" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_ga4_pages_daily_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_ga4_pages_daily_client_date" ON "public"."ga4_pages_daily" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_gmail_messages_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_messages_cc" ON "public"."gmail_messages" USING "gin" ("cc_emails");


--
-- Name: idx_gmail_messages_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_messages_from" ON "public"."gmail_messages" USING "btree" ("client_id", "from_email");


--
-- Name: idx_gmail_messages_sent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_messages_sent" ON "public"."gmail_messages" USING "btree" ("client_id", "sent_at" DESC);


--
-- Name: idx_gmail_messages_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_messages_thread" ON "public"."gmail_messages" USING "btree" ("client_id", "gmail_thread_id", "sent_at");


--
-- Name: idx_gmail_messages_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_messages_to" ON "public"."gmail_messages" USING "gin" ("to_emails");


--
-- Name: idx_gmail_threads_participants; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_threads_participants" ON "public"."gmail_threads" USING "gin" ("participants");


--
-- Name: idx_gmail_threads_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_gmail_threads_recent" ON "public"."gmail_threads" USING "btree" ("client_id", "last_message_at" DESC);


--
-- Name: idx_google_ads_campaigns_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_google_ads_campaigns_client_date" ON "public"."google_ads_campaigns" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_industry_links_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_industry_links_client_id" ON "public"."industry_links" USING "btree" ("client_id");


--
-- Name: idx_knowledge_bases_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_knowledge_bases_active" ON "public"."knowledge_bases" USING "btree" ("client_id", "is_active") WHERE ("is_active" = true);


--
-- Name: idx_knowledge_bases_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_knowledge_bases_client_id" ON "public"."knowledge_bases" USING "btree" ("client_id");


--
-- Name: idx_meta_ads_daily_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_meta_ads_daily_client_date" ON "public"."meta_ads_daily" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_meta_ig_daily_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_meta_ig_daily_client_date" ON "public"."meta_ig_daily" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_meta_page_daily_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_meta_page_daily_client_date" ON "public"."meta_page_daily" USING "btree" ("client_id", "stat_date" DESC);


--
-- Name: idx_pipeline_history_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pipeline_history_client" ON "public"."pipeline_history" USING "btree" ("client_id", "changed_at" DESC);


--
-- Name: idx_pipeline_history_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_pipeline_history_prospect" ON "public"."pipeline_history" USING "btree" ("prospect_id", "changed_at" DESC);


--
-- Name: idx_prospects_ai_ok; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prospects_ai_ok" ON "public"."prospects" USING "btree" ("client_id") WHERE ("ai_ok" = true);


--
-- Name: idx_prospects_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prospects_client_id" ON "public"."prospects" USING "btree" ("client_id");


--
-- Name: idx_prospects_family_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prospects_family_id" ON "public"."prospects" USING "btree" ("family_id");


--
-- Name: idx_prospects_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_prospects_stage" ON "public"."prospects" USING "btree" ("current_stage_id");


--
-- Name: idx_salesforce_campaign_members_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_salesforce_campaign_members_campaign_id" ON "public"."salesforce_campaign_members" USING "btree" ("salesforce_campaign_id");


--
-- Name: idx_salesforce_campaign_members_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_salesforce_campaign_members_client_id" ON "public"."salesforce_campaign_members" USING "btree" ("client_id");


--
-- Name: idx_salesforce_campaign_members_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_salesforce_campaign_members_contact_id" ON "public"."salesforce_campaign_members" USING "btree" ("contact_id");


--
-- Name: idx_salesforce_campaigns_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_salesforce_campaigns_client_id" ON "public"."salesforce_campaigns" USING "btree" ("client_id");


--
-- Name: idx_salesforce_campaigns_salesforce_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_salesforce_campaigns_salesforce_id" ON "public"."salesforce_campaigns" USING "btree" ("salesforce_id");


--
-- Name: idx_scheduled_emails_enrollment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_scheduled_emails_enrollment_id" ON "public"."scheduled_emails" USING "btree" ("enrollment_id");


--
-- Name: idx_scheduled_emails_scheduled_for; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_scheduled_emails_scheduled_for" ON "public"."scheduled_emails" USING "btree" ("scheduled_for") WHERE (("status")::"text" = 'pending'::"text");


--
-- Name: idx_school_events_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_school_events_client_id" ON "public"."school_events" USING "btree" ("client_id");


--
-- Name: idx_sequence_analytics_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequence_analytics_event_type" ON "public"."sequence_analytics" USING "btree" ("event_type");


--
-- Name: idx_sequence_analytics_sequence_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequence_analytics_sequence_id" ON "public"."sequence_analytics" USING "btree" ("sequence_id");


--
-- Name: idx_sequence_analytics_step_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequence_analytics_step_id" ON "public"."sequence_analytics" USING "btree" ("step_id");


--
-- Name: idx_sequence_enrollments_trigger_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequence_enrollments_trigger_campaign" ON "public"."sequence_enrollments" USING "btree" ("trigger_campaign_id");


--
-- Name: idx_sequence_steps_sequence_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequence_steps_sequence_id" ON "public"."sequence_steps" USING "btree" ("sequence_id");


--
-- Name: idx_sequences_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequences_client_id" ON "public"."email_sequences" USING "btree" ("client_id");


--
-- Name: idx_sequences_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequences_status" ON "public"."email_sequences" USING "btree" ("status");


--
-- Name: idx_sequences_trigger_campaign_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sequences_trigger_campaign_ids" ON "public"."email_sequences" USING "gin" ("trigger_salesforce_campaign_ids");


--
-- Name: idx_shc_service_checked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_shc_service_checked" ON "public"."service_health_checks" USING "btree" ("service_name", "checked_at" DESC);


--
-- Name: idx_sync_runs_job_ran; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_sync_runs_job_ran" ON "public"."sync_runs" USING "btree" ("job", "client_id", "ran_at" DESC);


--
-- Name: idx_tags_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tags_client_id" ON "public"."tags" USING "btree" ("client_id");


--
-- Name: idx_tags_contact_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tags_contact_count" ON "public"."tags" USING "btree" ("contact_count" DESC);


--
-- Name: idx_template_folders_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_template_folders_client_id" ON "public"."template_folders" USING "btree" ("client_id");


--
-- Name: idx_templates_folder_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_templates_folder_id" ON "public"."templates" USING "btree" ("folder_id");


--
-- Name: idx_templates_is_starter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_templates_is_starter" ON "public"."templates" USING "btree" ("client_id") WHERE ("is_starter" = true);


--
-- Name: idx_tours_calendly_invitee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idx_tours_calendly_invitee" ON "public"."tours" USING "btree" ("client_id", "calendly_invitee_uri") WHERE ("calendly_invitee_uri" IS NOT NULL);


--
-- Name: idx_tours_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tours_client_id" ON "public"."tours" USING "btree" ("client_id");


--
-- Name: idx_tours_invitee_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tours_invitee_email" ON "public"."tours" USING "btree" ("client_id", "invitee_email") WHERE ("invitee_email" IS NOT NULL);


--
-- Name: idx_tours_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tours_prospect_id" ON "public"."tours" USING "btree" ("prospect_id");


--
-- Name: idx_tours_status_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tours_status_scheduled" ON "public"."tours" USING "btree" ("client_id", "status", "scheduled_at" DESC);


--
-- Name: idx_visit_events_client_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_visit_events_client_time" ON "public"."visit_events" USING "btree" ("client_id", "occurred_at" DESC);


--
-- Name: idx_visit_events_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_visit_events_contact" ON "public"."visit_events" USING "btree" ("contact_id", "occurred_at" DESC) WHERE ("contact_id" IS NOT NULL);


--
-- Name: idx_visit_events_unmatched; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_visit_events_unmatched" ON "public"."visit_events" USING "btree" ("occurred_at") WHERE ("contact_id" IS NULL);


--
-- Name: idx_visit_events_visitor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_visit_events_visitor" ON "public"."visit_events" USING "btree" ("visitor_id", "occurred_at");


--
-- Name: idx_woo_orders_client_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_woo_orders_client_date" ON "public"."woocommerce_orders" USING "btree" ("client_id", "order_date");


--
-- Name: idx_woo_orders_client_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_woo_orders_client_email" ON "public"."woocommerce_orders" USING "btree" ("client_id", "lower"("email"));


--
-- Name: legal_firms_active_custom_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "legal_firms_active_custom_domain_idx" ON "public"."legal_firms" USING "btree" ("active", "custom_domain") WHERE ("custom_domain" IS NOT NULL);


--
-- Name: legal_firms_active_subdomain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "legal_firms_active_subdomain_idx" ON "public"."legal_firms" USING "btree" ("active", "subdomain") WHERE ("subdomain" IS NOT NULL);


--
-- Name: portal_invites_firm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "portal_invites_firm_idx" ON "public"."portal_invites" USING "btree" ("firm_id", "created_at" DESC);


--
-- Name: portal_invites_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "portal_invites_token_idx" ON "public"."portal_invites" USING "btree" ("token");


--
-- Name: portal_questions_firm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "portal_questions_firm_idx" ON "public"."portal_questions" USING "btree" ("firm_id", "asked_at" DESC);


--
-- Name: posts_published_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "posts_published_at_idx" ON "public"."posts" USING "btree" ("published_at" DESC);


--
-- Name: posts_site_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "posts_site_id_idx" ON "public"."posts" USING "btree" ("site_id");


--
-- Name: posts_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "posts_tags_idx" ON "public"."posts" USING "gin" ("tags");


--
-- Name: programs_client_id_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "programs_client_id_year_idx" ON "public"."programs" USING "btree" ("client_id", "year");


--
-- Name: site_404_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "site_404_log_created_idx" ON "public"."site_404_log" USING "btree" ("created_at" DESC);


--
-- Name: site_404_log_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "site_404_log_path_idx" ON "public"."site_404_log" USING "btree" ("path");


--
-- Name: site_subscriptions_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "site_subscriptions_contact_id_idx" ON "public"."site_subscriptions" USING "btree" ("contact_id");


--
-- Name: site_subscriptions_site_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "site_subscriptions_site_id_idx" ON "public"."site_subscriptions" USING "btree" ("site_id");


--
-- Name: sr_findings_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sr_findings_dedupe_idx" ON "public"."sr_findings" USING "btree" ("org_id", "kind", COALESCE("url", ''::"text"));


--
-- Name: sr_findings_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_findings_kind_idx" ON "public"."sr_findings" USING "btree" ("kind");


--
-- Name: sr_findings_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_findings_open_idx" ON "public"."sr_findings" USING "btree" ("org_id", "severity") WHERE ("resolved_at" IS NULL);


--
-- Name: sr_findings_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_findings_org_idx" ON "public"."sr_findings" USING "btree" ("org_id");


--
-- Name: sr_orgs_affiliation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_orgs_affiliation_idx" ON "public"."sr_orgs" USING "btree" ("affiliation");


--
-- Name: sr_orgs_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_orgs_owner_idx" ON "public"."sr_orgs" USING "btree" ("owner");


--
-- Name: sr_orgs_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_orgs_platform_idx" ON "public"."sr_orgs" USING "btree" ("platform");


--
-- Name: sr_orgs_snoozed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_orgs_snoozed_idx" ON "public"."sr_orgs" USING "btree" ("snoozed_until") WHERE ("snoozed_until" IS NOT NULL);


--
-- Name: sr_orgs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_orgs_status_idx" ON "public"."sr_orgs" USING "btree" ("status");


--
-- Name: sr_orgs_tech_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_orgs_tech_idx" ON "public"."sr_orgs" USING "gin" ("tech");


--
-- Name: sr_outreach_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_outreach_org_idx" ON "public"."sr_outreach" USING "btree" ("org_id");


--
-- Name: sr_outreach_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_outreach_outcome_idx" ON "public"."sr_outreach" USING "btree" ("outcome");


--
-- Name: sr_outreach_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_outreach_thread_idx" ON "public"."sr_outreach" USING "btree" ("gmail_thread_id");


--
-- Name: sr_outreach_thread_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sr_outreach_thread_uniq" ON "public"."sr_outreach" USING "btree" ("gmail_thread_id") WHERE ("gmail_thread_id" IS NOT NULL);


--
-- Name: sr_people_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_people_email_idx" ON "public"."sr_people" USING "btree" ("lower"("email"));


--
-- Name: sr_people_optout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_people_optout_idx" ON "public"."sr_people" USING "btree" ("opted_out_at") WHERE ("opted_out_at" IS NOT NULL);


--
-- Name: sr_people_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_people_org_idx" ON "public"."sr_people" USING "btree" ("org_id");


--
-- Name: sr_people_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sr_people_role_idx" ON "public"."sr_people" USING "btree" ("role_category");


--
-- Name: subscriber_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriber_sessions_expires_at_idx" ON "public"."subscriber_sessions" USING "btree" ("expires_at");


--
-- Name: subscriber_sessions_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriber_sessions_token_hash_idx" ON "public"."subscriber_sessions" USING "btree" ("token_hash");


--
-- Name: video_generations_bridge_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "video_generations_bridge_from_idx" ON "public"."video_generations" USING "btree" ("bridge_from_id") WHERE ("bridge_from_id" IS NOT NULL);


--
-- Name: video_generations_bridge_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "video_generations_bridge_to_idx" ON "public"."video_generations" USING "btree" ("bridge_to_id") WHERE ("bridge_to_id" IS NOT NULL);


--
-- Name: video_generations_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "video_generations_created_at_idx" ON "public"."video_generations" USING "btree" ("created_at" DESC);


--
-- Name: video_generations_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "video_generations_created_by_idx" ON "public"."video_generations" USING "btree" ("created_by");


--
-- Name: enrollments enrollments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "enrollments_updated_at" BEFORE UPDATE ON "public"."enrollments" FOR EACH ROW EXECUTE FUNCTION "public"."update_enrollments_updated_at"();


--
-- Name: contacts generate_contact_unsubscribe_token; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "generate_contact_unsubscribe_token" BEFORE INSERT ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."generate_unsubscribe_token"();


--
-- Name: programs programs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "programs_updated_at" BEFORE UPDATE ON "public"."programs" FOR EACH ROW EXECUTE FUNCTION "public"."update_programs_updated_at"();


--
-- Name: prospects prospects_stage_change_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "prospects_stage_change_trigger" AFTER UPDATE ON "public"."prospects" FOR EACH ROW EXECUTE FUNCTION "public"."log_prospect_stage_change"();


--
-- Name: sr_findings sr_findings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sr_findings_updated_at" BEFORE UPDATE ON "public"."sr_findings" FOR EACH ROW EXECUTE FUNCTION "public"."sr_set_updated_at"();


--
-- Name: sr_orgs sr_orgs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sr_orgs_updated_at" BEFORE UPDATE ON "public"."sr_orgs" FOR EACH ROW EXECUTE FUNCTION "public"."sr_set_updated_at"();


--
-- Name: sr_outreach sr_outreach_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sr_outreach_updated_at" BEFORE UPDATE ON "public"."sr_outreach" FOR EACH ROW EXECUTE FUNCTION "public"."sr_set_updated_at"();


--
-- Name: sr_people sr_people_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "sr_people_updated_at" BEFORE UPDATE ON "public"."sr_people" FOR EACH ROW EXECUTE FUNCTION "public"."sr_set_updated_at"();


--
-- Name: ai_followup_config update_ai_followup_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_ai_followup_config_updated_at" BEFORE UPDATE ON "public"."ai_followup_config" FOR EACH ROW EXECUTE FUNCTION "public"."update_sequence_updated_at"();


--
-- Name: ai_followup_drafts update_ai_followup_drafts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_ai_followup_drafts_updated_at" BEFORE UPDATE ON "public"."ai_followup_drafts" FOR EACH ROW EXECUTE FUNCTION "public"."update_sequence_updated_at"();


--
-- Name: campaign_folders update_campaign_folders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_campaign_folders_updated_at" BEFORE UPDATE ON "public"."campaign_folders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: campaigns update_campaigns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_campaigns_updated_at" BEFORE UPDATE ON "public"."campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: clients update_clients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_clients_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: contact_tasks update_contact_tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_contact_tasks_updated_at" BEFORE UPDATE ON "public"."contact_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: contacts update_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_contacts_updated_at" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: email_sequences update_email_sequences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_email_sequences_updated_at" BEFORE UPDATE ON "public"."email_sequences" FOR EACH ROW EXECUTE FUNCTION "public"."update_sequence_updated_at"();


--
-- Name: industry_links update_industry_links_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_industry_links_updated_at" BEFORE UPDATE ON "public"."industry_links" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: salesforce_campaigns update_salesforce_campaigns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_salesforce_campaigns_updated_at" BEFORE UPDATE ON "public"."salesforce_campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: sequence_steps update_sequence_steps_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_sequence_steps_updated_at" BEFORE UPDATE ON "public"."sequence_steps" FOR EACH ROW EXECUTE FUNCTION "public"."update_sequence_updated_at"();


--
-- Name: template_folders update_template_folders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_template_folders_updated_at" BEFORE UPDATE ON "public"."template_folders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: templates update_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_templates_updated_at" BEFORE UPDATE ON "public"."templates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: admin_users admin_users_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: admin_users admin_users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");


--
-- Name: admin_users admin_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_analytics ai_followup_analytics_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_analytics"
    ADD CONSTRAINT "ai_followup_analytics_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "public"."ai_followup_drafts"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_config ai_followup_config_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_config"
    ADD CONSTRAINT "ai_followup_config_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_contacts ai_followup_contacts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_contacts"
    ADD CONSTRAINT "ai_followup_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_contacts ai_followup_contacts_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_contacts"
    ADD CONSTRAINT "ai_followup_contacts_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "public"."ai_followup_config"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_contacts ai_followup_contacts_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_contacts"
    ADD CONSTRAINT "ai_followup_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_drafts ai_followup_drafts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_drafts"
    ADD CONSTRAINT "ai_followup_drafts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_drafts ai_followup_drafts_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_drafts"
    ADD CONSTRAINT "ai_followup_drafts_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "public"."ai_followup_config"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_drafts ai_followup_drafts_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_drafts"
    ADD CONSTRAINT "ai_followup_drafts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_drafts ai_followup_drafts_followup_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ai_followup_drafts"
    ADD CONSTRAINT "ai_followup_drafts_followup_contact_id_fkey" FOREIGN KEY ("followup_contact_id") REFERENCES "public"."ai_followup_contacts"("id") ON DELETE CASCADE;


--
-- Name: analytics_events analytics_events_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;


--
-- Name: applications applications_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applications"
    ADD CONSTRAINT "applications_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: applications applications_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applications"
    ADD CONSTRAINT "applications_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE CASCADE;


--
-- Name: cairn_sessions cairn_sessions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cairn_sessions"
    ADD CONSTRAINT "cairn_sessions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id");


--
-- Name: calendly_integrations calendly_integrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."calendly_integrations"
    ADD CONSTRAINT "calendly_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: campaign_folders campaign_folders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaign_folders"
    ADD CONSTRAINT "campaign_folders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: campaigns campaigns_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: campaigns campaigns_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."campaign_folders"("id") ON DELETE SET NULL;


--
-- Name: campaigns campaigns_salesforce_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_salesforce_campaign_id_fkey" FOREIGN KEY ("salesforce_campaign_id") REFERENCES "public"."salesforce_campaigns"("id") ON DELETE SET NULL;


--
-- Name: campaigns campaigns_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE SET NULL;


--
-- Name: cc_campaigns cc_campaigns_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_campaigns"
    ADD CONSTRAINT "cc_campaigns_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_contacts cc_contacts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_contacts"
    ADD CONSTRAINT "cc_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_decline_list_members cc_decline_list_members_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_decline_list_members"
    ADD CONSTRAINT "cc_decline_list_members_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_decline_sync_runs cc_decline_sync_runs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_decline_sync_runs"
    ADD CONSTRAINT "cc_decline_sync_runs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_engagement cc_engagement_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_engagement"
    ADD CONSTRAINT "cc_engagement_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_integrations cc_integrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_integrations"
    ADD CONSTRAINT "cc_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_list_memberships cc_list_memberships_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_list_memberships"
    ADD CONSTRAINT "cc_list_memberships_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: cc_lists cc_lists_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cc_lists"
    ADD CONSTRAINT "cc_lists_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: sync_runs cc_sync_runs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sync_runs"
    ADD CONSTRAINT "cc_sync_runs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: clients clients_brand_reference_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_brand_reference_template_id_fkey" FOREIGN KEY ("brand_reference_template_id") REFERENCES "public"."templates"("id") ON DELETE SET NULL;


--
-- Name: contact_notes contact_notes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contact_notes"
    ADD CONSTRAINT "contact_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: contact_notes contact_notes_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contact_notes"
    ADD CONSTRAINT "contact_notes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: contact_tasks contact_tasks_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contact_tasks"
    ADD CONSTRAINT "contact_tasks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: contact_tasks contact_tasks_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contact_tasks"
    ADD CONSTRAINT "contact_tasks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: contacts contacts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: contacts contacts_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE SET NULL;


--
-- Name: contacts contacts_last_bounce_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_last_bounce_campaign_id_fkey" FOREIGN KEY ("last_bounce_campaign_id") REFERENCES "public"."campaigns"("id");


--
-- Name: contacts contacts_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE SET NULL;


--
-- Name: cvent_attendees cvent_attendees_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_attendees"
    ADD CONSTRAINT "cvent_attendees_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."cvent_events"("id");


--
-- Name: cvent_order_items cvent_order_items_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_order_items"
    ADD CONSTRAINT "cvent_order_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."cvent_events"("id");


--
-- Name: cvent_orders cvent_orders_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cvent_orders"
    ADD CONSTRAINT "cvent_orders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."cvent_events"("id");


--
-- Name: dashboard_summaries dashboard_summaries_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dashboard_summaries"
    ADD CONSTRAINT "dashboard_summaries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: discovered_media_urls discovered_media_urls_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."discovered_media_urls"
    ADD CONSTRAINT "discovered_media_urls_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: email_conversations email_conversations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_conversations"
    ADD CONSTRAINT "email_conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: email_conversations email_conversations_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_conversations"
    ADD CONSTRAINT "email_conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: email_sequences email_sequences_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_sequences"
    ADD CONSTRAINT "email_sequences_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: email_sequences email_sequences_trigger_salesforce_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_sequences"
    ADD CONSTRAINT "email_sequences_trigger_salesforce_campaign_id_fkey" FOREIGN KEY ("trigger_salesforce_campaign_id") REFERENCES "public"."salesforce_campaigns"("id") ON DELETE SET NULL;


--
-- Name: enrollments enrollments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."enrollments"
    ADD CONSTRAINT "enrollments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: enrollments enrollments_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."enrollments"
    ADD CONSTRAINT "enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: enrollments enrollments_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."enrollments"
    ADD CONSTRAINT "enrollments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE CASCADE;


--
-- Name: facts_applications facts_applications_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_applications"
    ADD CONSTRAINT "facts_applications_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: facts_applications facts_applications_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_applications"
    ADD CONSTRAINT "facts_applications_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;


--
-- Name: facts_inquiries facts_inquiries_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."facts_inquiries"
    ADD CONSTRAINT "facts_inquiries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: families families_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: form_intake_configs form_intake_configs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_intake_configs"
    ADD CONSTRAINT "form_intake_configs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;


--
-- Name: form_submissions form_submissions_form_intake_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_form_intake_config_id_fkey" FOREIGN KEY ("form_intake_config_id") REFERENCES "public"."form_intake_configs"("id") ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE SET NULL;


--
-- Name: form_submissions form_submissions_school_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_school_event_id_fkey" FOREIGN KEY ("school_event_id") REFERENCES "public"."school_events"("id") ON DELETE SET NULL;


--
-- Name: ga4_daily ga4_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_daily"
    ADD CONSTRAINT "ga4_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ga4_integrations ga4_integrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_integrations"
    ADD CONSTRAINT "ga4_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ga4_key_events_daily ga4_key_events_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_key_events_daily"
    ADD CONSTRAINT "ga4_key_events_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ga4_pages_daily ga4_pages_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ga4_pages_daily"
    ADD CONSTRAINT "ga4_pages_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: gmail_integrations gmail_integrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_integrations"
    ADD CONSTRAINT "gmail_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: gmail_messages gmail_messages_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_messages"
    ADD CONSTRAINT "gmail_messages_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: gmail_threads gmail_threads_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gmail_threads"
    ADD CONSTRAINT "gmail_threads_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: google_ads_campaigns google_ads_campaigns_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."google_ads_campaigns"
    ADD CONSTRAINT "google_ads_campaigns_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: google_ads_integrations google_ads_integrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."google_ads_integrations"
    ADD CONSTRAINT "google_ads_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: industry_links industry_links_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."industry_links"
    ADD CONSTRAINT "industry_links_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: invite_tokens invite_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");


--
-- Name: invite_tokens invite_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");


--
-- Name: knowledge_bases knowledge_bases_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."knowledge_bases"
    ADD CONSTRAINT "knowledge_bases_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: meta_ads_daily meta_ads_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ads_daily"
    ADD CONSTRAINT "meta_ads_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: meta_ig_daily meta_ig_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_ig_daily"
    ADD CONSTRAINT "meta_ig_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: meta_integrations meta_integrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_integrations"
    ADD CONSTRAINT "meta_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: meta_page_daily meta_page_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meta_page_daily"
    ADD CONSTRAINT "meta_page_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: pipeline_history pipeline_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_history"
    ADD CONSTRAINT "pipeline_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id");


--
-- Name: pipeline_history pipeline_history_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_history"
    ADD CONSTRAINT "pipeline_history_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: pipeline_history pipeline_history_from_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_history"
    ADD CONSTRAINT "pipeline_history_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id");


--
-- Name: pipeline_history pipeline_history_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_history"
    ADD CONSTRAINT "pipeline_history_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE CASCADE;


--
-- Name: pipeline_history pipeline_history_to_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pipeline_history"
    ADD CONSTRAINT "pipeline_history_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id");


--
-- Name: posts posts_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE;


--
-- Name: programs programs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."programs"
    ADD CONSTRAINT "programs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: prospects prospects_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: prospects prospects_current_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "public"."pipeline_stages"("id");


--
-- Name: prospects prospects_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE SET NULL;


--
-- Name: reengagement_config reengagement_config_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reengagement_config"
    ADD CONSTRAINT "reengagement_config_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: salesforce_campaign_members salesforce_campaign_members_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaign_members"
    ADD CONSTRAINT "salesforce_campaign_members_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: salesforce_campaign_members salesforce_campaign_members_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaign_members"
    ADD CONSTRAINT "salesforce_campaign_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: salesforce_campaign_members salesforce_campaign_members_salesforce_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaign_members"
    ADD CONSTRAINT "salesforce_campaign_members_salesforce_campaign_id_fkey" FOREIGN KEY ("salesforce_campaign_id") REFERENCES "public"."salesforce_campaigns"("id") ON DELETE CASCADE;


--
-- Name: salesforce_campaigns salesforce_campaigns_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."salesforce_campaigns"
    ADD CONSTRAINT "salesforce_campaigns_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: scheduled_emails scheduled_emails_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: scheduled_emails scheduled_emails_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE CASCADE;


--
-- Name: scheduled_emails scheduled_emails_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;


--
-- Name: school_events school_events_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."school_events"
    ADD CONSTRAINT "school_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: sequence_analytics sequence_analytics_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_analytics"
    ADD CONSTRAINT "sequence_analytics_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE SET NULL;


--
-- Name: sequence_analytics sequence_analytics_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_analytics"
    ADD CONSTRAINT "sequence_analytics_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."email_sequences"("id") ON DELETE CASCADE;


--
-- Name: sequence_analytics sequence_analytics_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_analytics"
    ADD CONSTRAINT "sequence_analytics_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;


--
-- Name: sequence_enrollments sequence_enrollments_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."email_sequences"("id") ON DELETE CASCADE;


--
-- Name: sequence_enrollments sequence_enrollments_trigger_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_trigger_campaign_id_fkey" FOREIGN KEY ("trigger_campaign_id") REFERENCES "public"."salesforce_campaigns"("id") ON DELETE SET NULL;


--
-- Name: sequence_steps sequence_steps_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."email_sequences"("id") ON DELETE CASCADE;


--
-- Name: sequence_steps sequence_steps_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE SET NULL;


--
-- Name: site_subscriptions site_subscriptions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."site_subscriptions"
    ADD CONSTRAINT "site_subscriptions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: site_subscriptions site_subscriptions_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."site_subscriptions"
    ADD CONSTRAINT "site_subscriptions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE;


--
-- Name: sites sites_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sites"
    ADD CONSTRAINT "sites_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: sr_findings sr_findings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_findings"
    ADD CONSTRAINT "sr_findings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."sr_orgs"("id") ON DELETE CASCADE;


--
-- Name: sr_orgs sr_orgs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_orgs"
    ADD CONSTRAINT "sr_orgs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;


--
-- Name: sr_outreach sr_outreach_finding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_outreach"
    ADD CONSTRAINT "sr_outreach_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "public"."sr_findings"("id") ON DELETE SET NULL;


--
-- Name: sr_outreach sr_outreach_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_outreach"
    ADD CONSTRAINT "sr_outreach_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."sr_orgs"("id") ON DELETE CASCADE;


--
-- Name: sr_outreach sr_outreach_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_outreach"
    ADD CONSTRAINT "sr_outreach_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."sr_people"("id") ON DELETE SET NULL;


--
-- Name: sr_people sr_people_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sr_people"
    ADD CONSTRAINT "sr_people_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."sr_orgs"("id") ON DELETE CASCADE;


--
-- Name: subscriber_sessions subscriber_sessions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriber_sessions"
    ADD CONSTRAINT "subscriber_sessions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;


--
-- Name: subscriber_sessions subscriber_sessions_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriber_sessions"
    ADD CONSTRAINT "subscriber_sessions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE CASCADE;


--
-- Name: tags tags_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: template_folders template_folders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."template_folders"
    ADD CONSTRAINT "template_folders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: templates templates_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: templates templates_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."template_folders"("id") ON DELETE SET NULL;


--
-- Name: tours tours_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tours"
    ADD CONSTRAINT "tours_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: tours tours_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tours"
    ADD CONSTRAINT "tours_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE CASCADE;


--
-- Name: video_generations video_generations_bridge_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."video_generations"
    ADD CONSTRAINT "video_generations_bridge_from_id_fkey" FOREIGN KEY ("bridge_from_id") REFERENCES "public"."video_generations"("id") ON DELETE SET NULL;


--
-- Name: video_generations video_generations_bridge_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."video_generations"
    ADD CONSTRAINT "video_generations_bridge_to_id_fkey" FOREIGN KEY ("bridge_to_id") REFERENCES "public"."video_generations"("id") ON DELETE SET NULL;


--
-- Name: video_generations video_generations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."video_generations"
    ADD CONSTRAINT "video_generations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: visit_events visit_events_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."visit_events"
    ADD CONSTRAINT "visit_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: visit_events visit_events_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."visit_events"
    ADD CONSTRAINT "visit_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;


--
-- Name: woocommerce_orders woocommerce_orders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."woocommerce_orders"
    ADD CONSTRAINT "woocommerce_orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;


--
-- Name: ai_followup_config Admins can delete ai_followup_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete ai_followup_config" ON "public"."ai_followup_config" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_contacts Admins can delete ai_followup_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete ai_followup_contacts" ON "public"."ai_followup_contacts" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_drafts Admins can delete ai_followup_drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete ai_followup_drafts" ON "public"."ai_followup_drafts" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: applications Admins can delete applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete applications" ON "public"."applications" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: campaign_folders Admins can delete campaign_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete campaign_folders" ON "public"."campaign_folders" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: campaigns Admins can delete campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete campaigns" ON "public"."campaigns" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: contact_tasks Admins can delete contact_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete contact_tasks" ON "public"."contact_tasks" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: contacts Admins can delete contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete contacts" ON "public"."contacts" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: email_sequences Admins can delete email_sequences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete email_sequences" ON "public"."email_sequences" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: families Admins can delete families; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete families" ON "public"."families" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: form_intake_configs Admins can delete form_intake_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete form_intake_configs" ON "public"."form_intake_configs" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: industry_links Admins can delete industry_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete industry_links" ON "public"."industry_links" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: pipeline_history Admins can delete pipeline_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete pipeline_history" ON "public"."pipeline_history" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: prospects Admins can delete prospects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete prospects" ON "public"."prospects" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaign_members Admins can delete salesforce_campaign_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete salesforce_campaign_members" ON "public"."salesforce_campaign_members" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaigns Admins can delete salesforce_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete salesforce_campaigns" ON "public"."salesforce_campaigns" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: school_events Admins can delete school_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete school_events" ON "public"."school_events" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: sequence_steps Admins can delete sequence_steps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete sequence_steps" ON "public"."sequence_steps" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_steps"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: tags Admins can delete tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete tags" ON "public"."tags" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: template_folders Admins can delete template_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete template_folders" ON "public"."template_folders" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: templates Admins can delete templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete templates" ON "public"."templates" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: tours Admins can delete tours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete tours" ON "public"."tours" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: woocommerce_orders Admins can delete woo orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete woo orders" ON "public"."woocommerce_orders" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_analytics Admins can insert ai_followup_analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert ai_followup_analytics" ON "public"."ai_followup_analytics" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."ai_followup_drafts" "d"
  WHERE (("d"."id" = "ai_followup_analytics"."draft_id") AND "public"."can_access_client"("d"."client_id")))));


--
-- Name: ai_followup_config Admins can insert ai_followup_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert ai_followup_config" ON "public"."ai_followup_config" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_contacts Admins can insert ai_followup_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert ai_followup_contacts" ON "public"."ai_followup_contacts" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_drafts Admins can insert ai_followup_drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert ai_followup_drafts" ON "public"."ai_followup_drafts" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: analytics_events Admins can insert analytics_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert analytics_events" ON "public"."analytics_events" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."campaigns" "c"
  WHERE (("c"."id" = "analytics_events"."campaign_id") AND "public"."can_access_client"("c"."client_id")))));


--
-- Name: applications Admins can insert applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert applications" ON "public"."applications" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: campaign_folders Admins can insert campaign_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert campaign_folders" ON "public"."campaign_folders" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: campaigns Admins can insert campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert campaigns" ON "public"."campaigns" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: contact_tasks Admins can insert contact_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert contact_tasks" ON "public"."contact_tasks" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: contacts Admins can insert contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert contacts" ON "public"."contacts" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: email_sequences Admins can insert email_sequences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert email_sequences" ON "public"."email_sequences" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: families Admins can insert families; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert families" ON "public"."families" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: form_intake_configs Admins can insert form_intake_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert form_intake_configs" ON "public"."form_intake_configs" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: industry_links Admins can insert industry_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert industry_links" ON "public"."industry_links" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: pipeline_history Admins can insert pipeline_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert pipeline_history" ON "public"."pipeline_history" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: prospects Admins can insert prospects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert prospects" ON "public"."prospects" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaign_members Admins can insert salesforce_campaign_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert salesforce_campaign_members" ON "public"."salesforce_campaign_members" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaigns Admins can insert salesforce_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert salesforce_campaigns" ON "public"."salesforce_campaigns" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: scheduled_emails Admins can insert scheduled_emails; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert scheduled_emails" ON "public"."scheduled_emails" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."contacts" "ct"
  WHERE (("ct"."id" = "scheduled_emails"."contact_id") AND "public"."can_access_client"("ct"."client_id")))));


--
-- Name: school_events Admins can insert school_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert school_events" ON "public"."school_events" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: sequence_analytics Admins can insert sequence_analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert sequence_analytics" ON "public"."sequence_analytics" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_analytics"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: sequence_enrollments Admins can insert sequence_enrollments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert sequence_enrollments" ON "public"."sequence_enrollments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_enrollments"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: sequence_steps Admins can insert sequence_steps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert sequence_steps" ON "public"."sequence_steps" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_steps"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: tags Admins can insert tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert tags" ON "public"."tags" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: template_folders Admins can insert template_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert template_folders" ON "public"."template_folders" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: templates Admins can insert templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert templates" ON "public"."templates" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: tours Admins can insert tours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert tours" ON "public"."tours" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: woocommerce_orders Admins can insert woo orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert woo orders" ON "public"."woocommerce_orders" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_analytics Admins can select ai_followup_analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ai_followup_analytics" ON "public"."ai_followup_analytics" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."ai_followup_drafts" "d"
  WHERE (("d"."id" = "ai_followup_analytics"."draft_id") AND "public"."can_access_client"("d"."client_id")))));


--
-- Name: ai_followup_config Admins can select ai_followup_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ai_followup_config" ON "public"."ai_followup_config" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_contacts Admins can select ai_followup_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ai_followup_contacts" ON "public"."ai_followup_contacts" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_drafts Admins can select ai_followup_drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ai_followup_drafts" ON "public"."ai_followup_drafts" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: analytics_events Admins can select analytics_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select analytics_events" ON "public"."analytics_events" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."campaigns" "c"
  WHERE (("c"."id" = "analytics_events"."campaign_id") AND "public"."can_access_client"("c"."client_id")))));


--
-- Name: applications Admins can select applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select applications" ON "public"."applications" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: campaign_folders Admins can select campaign_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select campaign_folders" ON "public"."campaign_folders" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: campaigns Admins can select campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select campaigns" ON "public"."campaigns" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: cc_campaigns Admins can select cc_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select cc_campaigns" ON "public"."cc_campaigns" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: cc_decline_list_members Admins can select cc_decline_list_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select cc_decline_list_members" ON "public"."cc_decline_list_members" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: cc_decline_sync_runs Admins can select cc_decline_sync_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select cc_decline_sync_runs" ON "public"."cc_decline_sync_runs" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: cc_engagement Admins can select cc_engagement; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select cc_engagement" ON "public"."cc_engagement" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: contact_tasks Admins can select contact_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select contact_tasks" ON "public"."contact_tasks" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: contacts Admins can select contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select contacts" ON "public"."contacts" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: dashboard_summaries Admins can select dashboard_summaries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select dashboard_summaries" ON "public"."dashboard_summaries" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: email_sequences Admins can select email_sequences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select email_sequences" ON "public"."email_sequences" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: facts_applications Admins can select facts_applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select facts_applications" ON "public"."facts_applications" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: facts_inquiries Admins can select facts_inquiries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select facts_inquiries" ON "public"."facts_inquiries" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: families Admins can select families; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select families" ON "public"."families" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: form_intake_configs Admins can select form_intake_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select form_intake_configs" ON "public"."form_intake_configs" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: form_submissions Admins can select form_submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select form_submissions" ON "public"."form_submissions" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: ga4_daily Admins can select ga4_daily; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ga4_daily" ON "public"."ga4_daily" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: ga4_key_events_daily Admins can select ga4_key_events_daily; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ga4_key_events_daily" ON "public"."ga4_key_events_daily" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: ga4_pages_daily Admins can select ga4_pages_daily; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select ga4_pages_daily" ON "public"."ga4_pages_daily" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: gmail_messages Admins can select gmail_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select gmail_messages" ON "public"."gmail_messages" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: gmail_threads Admins can select gmail_threads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select gmail_threads" ON "public"."gmail_threads" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: google_ads_campaigns Admins can select google_ads_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select google_ads_campaigns" ON "public"."google_ads_campaigns" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: industry_links Admins can select industry_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select industry_links" ON "public"."industry_links" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: meta_ads_daily Admins can select meta_ads_daily; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select meta_ads_daily" ON "public"."meta_ads_daily" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: meta_ig_daily Admins can select meta_ig_daily; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select meta_ig_daily" ON "public"."meta_ig_daily" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: meta_page_daily Admins can select meta_page_daily; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select meta_page_daily" ON "public"."meta_page_daily" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: pipeline_history Admins can select pipeline_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select pipeline_history" ON "public"."pipeline_history" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: prospects Admins can select prospects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select prospects" ON "public"."prospects" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaign_members Admins can select salesforce_campaign_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select salesforce_campaign_members" ON "public"."salesforce_campaign_members" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaigns Admins can select salesforce_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select salesforce_campaigns" ON "public"."salesforce_campaigns" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: scheduled_emails Admins can select scheduled_emails; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select scheduled_emails" ON "public"."scheduled_emails" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."contacts" "ct"
  WHERE (("ct"."id" = "scheduled_emails"."contact_id") AND "public"."can_access_client"("ct"."client_id")))));


--
-- Name: school_events Admins can select school_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select school_events" ON "public"."school_events" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: sequence_analytics Admins can select sequence_analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select sequence_analytics" ON "public"."sequence_analytics" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_analytics"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: sequence_enrollments Admins can select sequence_enrollments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select sequence_enrollments" ON "public"."sequence_enrollments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_enrollments"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: sequence_steps Admins can select sequence_steps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select sequence_steps" ON "public"."sequence_steps" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_steps"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: tags Admins can select tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select tags" ON "public"."tags" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: template_folders Admins can select template_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select template_folders" ON "public"."template_folders" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: templates Admins can select templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select templates" ON "public"."templates" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: tours Admins can select tours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select tours" ON "public"."tours" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: visit_events Admins can select visit_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select visit_events" ON "public"."visit_events" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: woocommerce_orders Admins can select woo orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can select woo orders" ON "public"."woocommerce_orders" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_config Admins can update ai_followup_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update ai_followup_config" ON "public"."ai_followup_config" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_contacts Admins can update ai_followup_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update ai_followup_contacts" ON "public"."ai_followup_contacts" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: ai_followup_drafts Admins can update ai_followup_drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update ai_followup_drafts" ON "public"."ai_followup_drafts" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: analytics_events Admins can update analytics_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update analytics_events" ON "public"."analytics_events" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."campaigns" "c"
  WHERE (("c"."id" = "analytics_events"."campaign_id") AND "public"."can_access_client"("c"."client_id")))));


--
-- Name: applications Admins can update applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update applications" ON "public"."applications" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: campaign_folders Admins can update campaign_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update campaign_folders" ON "public"."campaign_folders" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: campaigns Admins can update campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update campaigns" ON "public"."campaigns" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: contact_tasks Admins can update contact_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update contact_tasks" ON "public"."contact_tasks" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: contacts Admins can update contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update contacts" ON "public"."contacts" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: email_sequences Admins can update email_sequences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update email_sequences" ON "public"."email_sequences" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: families Admins can update families; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update families" ON "public"."families" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: form_intake_configs Admins can update form_intake_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update form_intake_configs" ON "public"."form_intake_configs" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: industry_links Admins can update industry_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update industry_links" ON "public"."industry_links" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: pipeline_history Admins can update pipeline_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update pipeline_history" ON "public"."pipeline_history" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: prospects Admins can update prospects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update prospects" ON "public"."prospects" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaign_members Admins can update salesforce_campaign_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update salesforce_campaign_members" ON "public"."salesforce_campaign_members" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: salesforce_campaigns Admins can update salesforce_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update salesforce_campaigns" ON "public"."salesforce_campaigns" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: scheduled_emails Admins can update scheduled_emails; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update scheduled_emails" ON "public"."scheduled_emails" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."contacts" "ct"
  WHERE (("ct"."id" = "scheduled_emails"."contact_id") AND "public"."can_access_client"("ct"."client_id")))));


--
-- Name: school_events Admins can update school_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update school_events" ON "public"."school_events" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: sequence_enrollments Admins can update sequence_enrollments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update sequence_enrollments" ON "public"."sequence_enrollments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_enrollments"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: sequence_steps Admins can update sequence_steps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update sequence_steps" ON "public"."sequence_steps" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."email_sequences" "es"
  WHERE (("es"."id" = "sequence_steps"."sequence_id") AND "public"."can_access_client"("es"."client_id")))));


--
-- Name: tags Admins can update tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update tags" ON "public"."tags" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: template_folders Admins can update template_folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update template_folders" ON "public"."template_folders" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: templates Admins can update templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update templates" ON "public"."templates" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: tours Admins can update tours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update tours" ON "public"."tours" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: woocommerce_orders Admins can update woo orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update woo orders" ON "public"."woocommerce_orders" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: cc_contacts Allow all operations on cc_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on cc_contacts" ON "public"."cc_contacts" USING (true);


--
-- Name: cc_list_memberships Allow all operations on cc_list_memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on cc_list_memberships" ON "public"."cc_list_memberships" USING (true);


--
-- Name: cc_lists Allow all operations on cc_lists; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on cc_lists" ON "public"."cc_lists" USING (true);


--
-- Name: sync_runs Allow all operations on cc_sync_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on cc_sync_runs" ON "public"."sync_runs" USING (true);


--
-- Name: contact_notes Allow all operations on contact_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on contact_notes" ON "public"."contact_notes" USING (true);


--
-- Name: contact_tasks Allow all operations on contact_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on contact_tasks" ON "public"."contact_tasks" USING (true);


--
-- Name: discovered_media_urls Allow all operations on discovered_media_urls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations on discovered_media_urls" ON "public"."discovered_media_urls" USING (true);


--
-- Name: clients Client admins can view their client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Client admins can view their client" ON "public"."clients" FOR SELECT USING (("id" = "public"."get_user_client_id"()));


--
-- Name: sr_findings Internal staff can delete sr_findings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can delete sr_findings" ON "public"."sr_findings" FOR DELETE USING ("public"."is_internal_staff"());


--
-- Name: sr_orgs Internal staff can delete sr_orgs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can delete sr_orgs" ON "public"."sr_orgs" FOR DELETE USING ("public"."is_internal_staff"());


--
-- Name: sr_outreach Internal staff can delete sr_outreach; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can delete sr_outreach" ON "public"."sr_outreach" FOR DELETE USING ("public"."is_internal_staff"());


--
-- Name: sr_people Internal staff can delete sr_people; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can delete sr_people" ON "public"."sr_people" FOR DELETE USING ("public"."is_internal_staff"());


--
-- Name: sr_sync_state Internal staff can delete sr_sync_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can delete sr_sync_state" ON "public"."sr_sync_state" FOR DELETE USING ("public"."is_internal_staff"());


--
-- Name: sr_findings Internal staff can insert sr_findings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can insert sr_findings" ON "public"."sr_findings" FOR INSERT WITH CHECK ("public"."is_internal_staff"());


--
-- Name: sr_orgs Internal staff can insert sr_orgs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can insert sr_orgs" ON "public"."sr_orgs" FOR INSERT WITH CHECK ("public"."is_internal_staff"());


--
-- Name: sr_outreach Internal staff can insert sr_outreach; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can insert sr_outreach" ON "public"."sr_outreach" FOR INSERT WITH CHECK ("public"."is_internal_staff"());


--
-- Name: sr_people Internal staff can insert sr_people; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can insert sr_people" ON "public"."sr_people" FOR INSERT WITH CHECK ("public"."is_internal_staff"());


--
-- Name: sr_sync_state Internal staff can insert sr_sync_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can insert sr_sync_state" ON "public"."sr_sync_state" FOR INSERT WITH CHECK ("public"."is_internal_staff"());


--
-- Name: sr_findings Internal staff can select sr_findings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can select sr_findings" ON "public"."sr_findings" FOR SELECT USING ("public"."is_internal_staff"());


--
-- Name: sr_orgs Internal staff can select sr_orgs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can select sr_orgs" ON "public"."sr_orgs" FOR SELECT USING ("public"."is_internal_staff"());


--
-- Name: sr_outreach Internal staff can select sr_outreach; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can select sr_outreach" ON "public"."sr_outreach" FOR SELECT USING ("public"."is_internal_staff"());


--
-- Name: sr_people Internal staff can select sr_people; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can select sr_people" ON "public"."sr_people" FOR SELECT USING ("public"."is_internal_staff"());


--
-- Name: sr_sync_state Internal staff can select sr_sync_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can select sr_sync_state" ON "public"."sr_sync_state" FOR SELECT USING ("public"."is_internal_staff"());


--
-- Name: sr_findings Internal staff can update sr_findings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can update sr_findings" ON "public"."sr_findings" FOR UPDATE USING ("public"."is_internal_staff"());


--
-- Name: sr_orgs Internal staff can update sr_orgs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can update sr_orgs" ON "public"."sr_orgs" FOR UPDATE USING ("public"."is_internal_staff"());


--
-- Name: sr_outreach Internal staff can update sr_outreach; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can update sr_outreach" ON "public"."sr_outreach" FOR UPDATE USING ("public"."is_internal_staff"());


--
-- Name: sr_people Internal staff can update sr_people; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can update sr_people" ON "public"."sr_people" FOR UPDATE USING ("public"."is_internal_staff"());


--
-- Name: sr_sync_state Internal staff can update sr_sync_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Internal staff can update sr_sync_state" ON "public"."sr_sync_state" FOR UPDATE USING ("public"."is_internal_staff"());


--
-- Name: email_conversations Service role full access on email_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on email_conversations" ON "public"."email_conversations" USING (true) WITH CHECK (true);


--
-- Name: knowledge_bases Service role full access on knowledge_bases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on knowledge_bases" ON "public"."knowledge_bases" USING (true) WITH CHECK (true);


--
-- Name: admin_users Super admins can manage admin records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can manage admin records" ON "public"."admin_users" USING ("public"."is_super_admin"());


--
-- Name: clients Super admins can manage all clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can manage all clients" ON "public"."clients" USING ("public"."is_super_admin"());


--
-- Name: invite_tokens Super admins can manage invite tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can manage invite tokens" ON "public"."invite_tokens" USING ("public"."is_super_admin"());


--
-- Name: admin_users Users can read own admin record; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own admin record" ON "public"."admin_users" FOR SELECT USING (("user_id" = "auth"."uid"()));


--
-- Name: admin_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_followup_analytics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_followup_analytics" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_followup_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_followup_config" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_followup_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_followup_contacts" ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_followup_drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ai_followup_drafts" ENABLE ROW LEVEL SECURITY;

--
-- Name: analytics_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."analytics_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_stages anyone can read pipeline_stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anyone can read pipeline_stages" ON "public"."pipeline_stages" FOR SELECT USING (true);


--
-- Name: applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."applications" ENABLE ROW LEVEL SECURITY;

--
-- Name: cairn_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cairn_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: calendly_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."calendly_integrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."campaign_folders" ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_campaigns" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_contacts" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_decline_list_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_decline_list_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_decline_sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_decline_sync_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_engagement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_engagement" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_integrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_list_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_list_memberships" ENABLE ROW LEVEL SECURITY;

--
-- Name: cc_lists; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cc_lists" ENABLE ROW LEVEL SECURITY;

--
-- Name: cfa_consolidated_people; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cfa_consolidated_people" ENABLE ROW LEVEL SECURITY;

--
-- Name: cfa_page_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cfa_page_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;

--
-- Name: sites clients can manage their own site; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "clients can manage their own site" ON "public"."sites" USING (("client_id" = ( SELECT "admin_users"."client_id"
   FROM "public"."admin_users"
  WHERE ("admin_users"."user_id" = "auth"."uid"()))));


--
-- Name: contact_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."contact_notes" ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."contact_tasks" ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;

--
-- Name: cvent_attendees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cvent_attendees" ENABLE ROW LEVEL SECURITY;

--
-- Name: cvent_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cvent_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: cvent_order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cvent_order_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: cvent_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cvent_orders" ENABLE ROW LEVEL SECURITY;

--
-- Name: dashboard_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dashboard_summaries" ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollments delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "delete_policy" ON "public"."enrollments" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: programs delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "delete_policy" ON "public"."programs" FOR DELETE USING ("public"."can_access_client"("client_id"));


--
-- Name: discovered_media_urls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."discovered_media_urls" ENABLE ROW LEVEL SECURITY;

--
-- Name: email_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."email_conversations" ENABLE ROW LEVEL SECURITY;

--
-- Name: email_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."email_sequences" ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."enrollments" ENABLE ROW LEVEL SECURITY;

--
-- Name: eval_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."eval_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: facts_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."facts_applications" ENABLE ROW LEVEL SECURITY;

--
-- Name: facts_inquiries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."facts_inquiries" ENABLE ROW LEVEL SECURITY;

--
-- Name: families; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."families" ENABLE ROW LEVEL SECURITY;

--
-- Name: form_intake_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."form_intake_configs" ENABLE ROW LEVEL SECURITY;

--
-- Name: form_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."form_submissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: ga4_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ga4_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: ga4_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ga4_integrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: ga4_key_events_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ga4_key_events_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: ga4_pages_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ga4_pages_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: gmail_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."gmail_integrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: gmail_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."gmail_messages" ENABLE ROW LEVEL SECURITY;

--
-- Name: gmail_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."gmail_threads" ENABLE ROW LEVEL SECURITY;

--
-- Name: google_ads_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."google_ads_campaigns" ENABLE ROW LEVEL SECURITY;

--
-- Name: google_ads_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."google_ads_integrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: industry_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."industry_links" ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollments insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "insert_policy" ON "public"."enrollments" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: programs insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "insert_policy" ON "public"."programs" FOR INSERT WITH CHECK ("public"."can_access_client"("client_id"));


--
-- Name: invite_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invite_tokens" ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_bases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."knowledge_bases" ENABLE ROW LEVEL SECURITY;

--
-- Name: legal_firms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."legal_firms" ENABLE ROW LEVEL SECURITY;

--
-- Name: meta_ads_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."meta_ads_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: meta_ig_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."meta_ig_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: meta_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."meta_integrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: meta_page_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."meta_page_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pipeline_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pipeline_stages" ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."portal_invites" ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."portal_questions" ENABLE ROW LEVEL SECURITY;

--
-- Name: posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;

--
-- Name: programs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."programs" ENABLE ROW LEVEL SECURITY;

--
-- Name: prospects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."prospects" ENABLE ROW LEVEL SECURITY;

--
-- Name: posts public can read published public posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public can read published public posts" ON "public"."posts" FOR SELECT USING ((("status" = 'published'::"text") AND ("is_public" = true)));


--
-- Name: reengagement_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."reengagement_config" ENABLE ROW LEVEL SECURITY;

--
-- Name: salesforce_campaign_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."salesforce_campaign_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: salesforce_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."salesforce_campaigns" ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduled_emails; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."scheduled_emails" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."school_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollments select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "select_policy" ON "public"."enrollments" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: programs select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "select_policy" ON "public"."programs" FOR SELECT USING ("public"."can_access_client"("client_id"));


--
-- Name: sequence_analytics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sequence_analytics" ENABLE ROW LEVEL SECURITY;

--
-- Name: sequence_enrollments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sequence_enrollments" ENABLE ROW LEVEL SECURITY;

--
-- Name: sequence_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sequence_steps" ENABLE ROW LEVEL SECURITY;

--
-- Name: service_health_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."service_health_checks" ENABLE ROW LEVEL SECURITY;

--
-- Name: posts site owners can manage posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "site owners can manage posts" ON "public"."posts" USING (("site_id" IN ( SELECT "s"."id"
   FROM ("public"."sites" "s"
     JOIN "public"."admin_users" "au" ON (("au"."client_id" = "s"."client_id")))
  WHERE ("au"."user_id" = "auth"."uid"()))));


--
-- Name: site_subscriptions site owners can view subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "site owners can view subscriptions" ON "public"."site_subscriptions" FOR SELECT USING (("site_id" IN ( SELECT "s"."id"
   FROM ("public"."sites" "s"
     JOIN "public"."admin_users" "au" ON (("au"."client_id" = "s"."client_id")))
  WHERE ("au"."user_id" = "auth"."uid"()))));


--
-- Name: site_404_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."site_404_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: site_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."site_subscriptions" ENABLE ROW LEVEL SECURITY;

--
-- Name: sites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sites" ENABLE ROW LEVEL SECURITY;

--
-- Name: sr_findings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sr_findings" ENABLE ROW LEVEL SECURITY;

--
-- Name: sr_orgs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sr_orgs" ENABLE ROW LEVEL SECURITY;

--
-- Name: sr_outreach; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sr_outreach" ENABLE ROW LEVEL SECURITY;

--
-- Name: sr_people; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sr_people" ENABLE ROW LEVEL SECURITY;

--
-- Name: sr_sync_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sr_sync_state" ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriber_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."subscriber_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sync_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;

--
-- Name: template_folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."template_folders" ENABLE ROW LEVEL SECURITY;

--
-- Name: templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: tours; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tours" ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollments update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "update_policy" ON "public"."enrollments" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: programs update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "update_policy" ON "public"."programs" FOR UPDATE USING ("public"."can_access_client"("client_id"));


--
-- Name: video_allowed_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."video_allowed_users" ENABLE ROW LEVEL SECURITY;

--
-- Name: video_allowed_users video_allowed_users readable by authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "video_allowed_users readable by authenticated" ON "public"."video_allowed_users" FOR SELECT TO "authenticated" USING (true);


--
-- Name: video_generations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."video_generations" ENABLE ROW LEVEL SECURITY;

--
-- Name: video_generations video_generations deletable by creator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "video_generations deletable by creator" ON "public"."video_generations" FOR DELETE TO "authenticated" USING (("created_by" = "auth"."uid"()));


--
-- Name: video_generations video_generations selectable by allowed users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "video_generations selectable by allowed users" ON "public"."video_generations" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."video_allowed_users" "au"
  WHERE ("au"."email" = ("auth"."jwt"() ->> 'email'::"text")))));


--
-- Name: visit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."visit_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: woocommerce_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."woocommerce_orders" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict 8XnNg6zO7Ka8IjlW9LixNTtFx6ua2MLDKSQSwuwFBuMlxpgcz6gcxh5DF4GMEmV


-- ===========================================================================
-- GRANTS
-- Generated from information_schema.role_table_grants, not from pg_dump.
-- Supabase's REST API is entirely dependent on these: without them a restored
-- database has every table and no working API.
-- ===========================================================================

GRANT DELETE ON TABLE public.admin_users TO anon;
GRANT INSERT ON TABLE public.admin_users TO anon;
GRANT REFERENCES ON TABLE public.admin_users TO anon;
GRANT SELECT ON TABLE public.admin_users TO anon;
GRANT TRIGGER ON TABLE public.admin_users TO anon;
GRANT TRUNCATE ON TABLE public.admin_users TO anon;
GRANT UPDATE ON TABLE public.admin_users TO anon;
GRANT DELETE ON TABLE public.ai_followup_analytics TO anon;
GRANT INSERT ON TABLE public.ai_followup_analytics TO anon;
GRANT REFERENCES ON TABLE public.ai_followup_analytics TO anon;
GRANT SELECT ON TABLE public.ai_followup_analytics TO anon;
GRANT TRIGGER ON TABLE public.ai_followup_analytics TO anon;
GRANT TRUNCATE ON TABLE public.ai_followup_analytics TO anon;
GRANT UPDATE ON TABLE public.ai_followup_analytics TO anon;
GRANT DELETE ON TABLE public.ai_followup_config TO anon;
GRANT INSERT ON TABLE public.ai_followup_config TO anon;
GRANT REFERENCES ON TABLE public.ai_followup_config TO anon;
GRANT SELECT ON TABLE public.ai_followup_config TO anon;
GRANT TRIGGER ON TABLE public.ai_followup_config TO anon;
GRANT TRUNCATE ON TABLE public.ai_followup_config TO anon;
GRANT UPDATE ON TABLE public.ai_followup_config TO anon;
GRANT DELETE ON TABLE public.ai_followup_contacts TO anon;
GRANT INSERT ON TABLE public.ai_followup_contacts TO anon;
GRANT REFERENCES ON TABLE public.ai_followup_contacts TO anon;
GRANT SELECT ON TABLE public.ai_followup_contacts TO anon;
GRANT TRIGGER ON TABLE public.ai_followup_contacts TO anon;
GRANT TRUNCATE ON TABLE public.ai_followup_contacts TO anon;
GRANT UPDATE ON TABLE public.ai_followup_contacts TO anon;
GRANT DELETE ON TABLE public.ai_followup_drafts TO anon;
GRANT INSERT ON TABLE public.ai_followup_drafts TO anon;
GRANT REFERENCES ON TABLE public.ai_followup_drafts TO anon;
GRANT SELECT ON TABLE public.ai_followup_drafts TO anon;
GRANT TRIGGER ON TABLE public.ai_followup_drafts TO anon;
GRANT TRUNCATE ON TABLE public.ai_followup_drafts TO anon;
GRANT UPDATE ON TABLE public.ai_followup_drafts TO anon;
GRANT DELETE ON TABLE public.analytics_events TO anon;
GRANT INSERT ON TABLE public.analytics_events TO anon;
GRANT REFERENCES ON TABLE public.analytics_events TO anon;
GRANT SELECT ON TABLE public.analytics_events TO anon;
GRANT TRIGGER ON TABLE public.analytics_events TO anon;
GRANT TRUNCATE ON TABLE public.analytics_events TO anon;
GRANT UPDATE ON TABLE public.analytics_events TO anon;
GRANT DELETE ON TABLE public.applications TO anon;
GRANT INSERT ON TABLE public.applications TO anon;
GRANT REFERENCES ON TABLE public.applications TO anon;
GRANT SELECT ON TABLE public.applications TO anon;
GRANT TRIGGER ON TABLE public.applications TO anon;
GRANT TRUNCATE ON TABLE public.applications TO anon;
GRANT UPDATE ON TABLE public.applications TO anon;
GRANT DELETE ON TABLE public.cairn_sessions TO anon;
GRANT INSERT ON TABLE public.cairn_sessions TO anon;
GRANT REFERENCES ON TABLE public.cairn_sessions TO anon;
GRANT SELECT ON TABLE public.cairn_sessions TO anon;
GRANT TRIGGER ON TABLE public.cairn_sessions TO anon;
GRANT TRUNCATE ON TABLE public.cairn_sessions TO anon;
GRANT UPDATE ON TABLE public.cairn_sessions TO anon;
GRANT DELETE ON TABLE public.calendly_integrations TO anon;
GRANT INSERT ON TABLE public.calendly_integrations TO anon;
GRANT REFERENCES ON TABLE public.calendly_integrations TO anon;
GRANT SELECT ON TABLE public.calendly_integrations TO anon;
GRANT TRIGGER ON TABLE public.calendly_integrations TO anon;
GRANT TRUNCATE ON TABLE public.calendly_integrations TO anon;
GRANT UPDATE ON TABLE public.calendly_integrations TO anon;
GRANT DELETE ON TABLE public.campaign_folders TO anon;
GRANT INSERT ON TABLE public.campaign_folders TO anon;
GRANT REFERENCES ON TABLE public.campaign_folders TO anon;
GRANT SELECT ON TABLE public.campaign_folders TO anon;
GRANT TRIGGER ON TABLE public.campaign_folders TO anon;
GRANT TRUNCATE ON TABLE public.campaign_folders TO anon;
GRANT UPDATE ON TABLE public.campaign_folders TO anon;
GRANT DELETE ON TABLE public.campaigns TO anon;
GRANT INSERT ON TABLE public.campaigns TO anon;
GRANT REFERENCES ON TABLE public.campaigns TO anon;
GRANT SELECT ON TABLE public.campaigns TO anon;
GRANT TRIGGER ON TABLE public.campaigns TO anon;
GRANT TRUNCATE ON TABLE public.campaigns TO anon;
GRANT UPDATE ON TABLE public.campaigns TO anon;
GRANT DELETE ON TABLE public.cc_campaigns TO anon;
GRANT INSERT ON TABLE public.cc_campaigns TO anon;
GRANT REFERENCES ON TABLE public.cc_campaigns TO anon;
GRANT SELECT ON TABLE public.cc_campaigns TO anon;
GRANT TRIGGER ON TABLE public.cc_campaigns TO anon;
GRANT TRUNCATE ON TABLE public.cc_campaigns TO anon;
GRANT UPDATE ON TABLE public.cc_campaigns TO anon;
GRANT DELETE ON TABLE public.cc_contacts TO anon;
GRANT INSERT ON TABLE public.cc_contacts TO anon;
GRANT REFERENCES ON TABLE public.cc_contacts TO anon;
GRANT SELECT ON TABLE public.cc_contacts TO anon;
GRANT TRIGGER ON TABLE public.cc_contacts TO anon;
GRANT TRUNCATE ON TABLE public.cc_contacts TO anon;
GRANT UPDATE ON TABLE public.cc_contacts TO anon;
GRANT DELETE ON TABLE public.cc_decline_list_members TO anon;
GRANT INSERT ON TABLE public.cc_decline_list_members TO anon;
GRANT REFERENCES ON TABLE public.cc_decline_list_members TO anon;
GRANT SELECT ON TABLE public.cc_decline_list_members TO anon;
GRANT TRIGGER ON TABLE public.cc_decline_list_members TO anon;
GRANT TRUNCATE ON TABLE public.cc_decline_list_members TO anon;
GRANT UPDATE ON TABLE public.cc_decline_list_members TO anon;
GRANT DELETE ON TABLE public.cc_decline_sync_runs TO anon;
GRANT INSERT ON TABLE public.cc_decline_sync_runs TO anon;
GRANT REFERENCES ON TABLE public.cc_decline_sync_runs TO anon;
GRANT SELECT ON TABLE public.cc_decline_sync_runs TO anon;
GRANT TRIGGER ON TABLE public.cc_decline_sync_runs TO anon;
GRANT TRUNCATE ON TABLE public.cc_decline_sync_runs TO anon;
GRANT UPDATE ON TABLE public.cc_decline_sync_runs TO anon;
GRANT DELETE ON TABLE public.cc_engagement TO anon;
GRANT INSERT ON TABLE public.cc_engagement TO anon;
GRANT REFERENCES ON TABLE public.cc_engagement TO anon;
GRANT SELECT ON TABLE public.cc_engagement TO anon;
GRANT TRIGGER ON TABLE public.cc_engagement TO anon;
GRANT TRUNCATE ON TABLE public.cc_engagement TO anon;
GRANT UPDATE ON TABLE public.cc_engagement TO anon;
GRANT DELETE ON TABLE public.cc_integrations TO anon;
GRANT INSERT ON TABLE public.cc_integrations TO anon;
GRANT REFERENCES ON TABLE public.cc_integrations TO anon;
GRANT SELECT ON TABLE public.cc_integrations TO anon;
GRANT TRIGGER ON TABLE public.cc_integrations TO anon;
GRANT TRUNCATE ON TABLE public.cc_integrations TO anon;
GRANT UPDATE ON TABLE public.cc_integrations TO anon;
GRANT DELETE ON TABLE public.cc_list_memberships TO anon;
GRANT INSERT ON TABLE public.cc_list_memberships TO anon;
GRANT REFERENCES ON TABLE public.cc_list_memberships TO anon;
GRANT SELECT ON TABLE public.cc_list_memberships TO anon;
GRANT TRIGGER ON TABLE public.cc_list_memberships TO anon;
GRANT TRUNCATE ON TABLE public.cc_list_memberships TO anon;
GRANT UPDATE ON TABLE public.cc_list_memberships TO anon;
GRANT DELETE ON TABLE public.cc_lists TO anon;
GRANT INSERT ON TABLE public.cc_lists TO anon;
GRANT REFERENCES ON TABLE public.cc_lists TO anon;
GRANT SELECT ON TABLE public.cc_lists TO anon;
GRANT TRIGGER ON TABLE public.cc_lists TO anon;
GRANT TRUNCATE ON TABLE public.cc_lists TO anon;
GRANT UPDATE ON TABLE public.cc_lists TO anon;
GRANT DELETE ON TABLE public.cfa_consolidated_people TO anon;
GRANT INSERT ON TABLE public.cfa_consolidated_people TO anon;
GRANT REFERENCES ON TABLE public.cfa_consolidated_people TO anon;
GRANT SELECT ON TABLE public.cfa_consolidated_people TO anon;
GRANT TRIGGER ON TABLE public.cfa_consolidated_people TO anon;
GRANT TRUNCATE ON TABLE public.cfa_consolidated_people TO anon;
GRANT UPDATE ON TABLE public.cfa_consolidated_people TO anon;
GRANT DELETE ON TABLE public.cfa_page_events TO anon;
GRANT INSERT ON TABLE public.cfa_page_events TO anon;
GRANT REFERENCES ON TABLE public.cfa_page_events TO anon;
GRANT SELECT ON TABLE public.cfa_page_events TO anon;
GRANT TRIGGER ON TABLE public.cfa_page_events TO anon;
GRANT TRUNCATE ON TABLE public.cfa_page_events TO anon;
GRANT UPDATE ON TABLE public.cfa_page_events TO anon;
GRANT DELETE ON TABLE public.clients TO anon;
GRANT INSERT ON TABLE public.clients TO anon;
GRANT REFERENCES ON TABLE public.clients TO anon;
GRANT SELECT ON TABLE public.clients TO anon;
GRANT TRIGGER ON TABLE public.clients TO anon;
GRANT TRUNCATE ON TABLE public.clients TO anon;
GRANT UPDATE ON TABLE public.clients TO anon;
GRANT DELETE ON TABLE public.contact_notes TO anon;
GRANT INSERT ON TABLE public.contact_notes TO anon;
GRANT REFERENCES ON TABLE public.contact_notes TO anon;
GRANT SELECT ON TABLE public.contact_notes TO anon;
GRANT TRIGGER ON TABLE public.contact_notes TO anon;
GRANT TRUNCATE ON TABLE public.contact_notes TO anon;
GRANT UPDATE ON TABLE public.contact_notes TO anon;
GRANT DELETE ON TABLE public.contact_tasks TO anon;
GRANT INSERT ON TABLE public.contact_tasks TO anon;
GRANT REFERENCES ON TABLE public.contact_tasks TO anon;
GRANT SELECT ON TABLE public.contact_tasks TO anon;
GRANT TRIGGER ON TABLE public.contact_tasks TO anon;
GRANT TRUNCATE ON TABLE public.contact_tasks TO anon;
GRANT UPDATE ON TABLE public.contact_tasks TO anon;
GRANT DELETE ON TABLE public.contacts TO anon;
GRANT INSERT ON TABLE public.contacts TO anon;
GRANT REFERENCES ON TABLE public.contacts TO anon;
GRANT SELECT ON TABLE public.contacts TO anon;
GRANT TRIGGER ON TABLE public.contacts TO anon;
GRANT TRUNCATE ON TABLE public.contacts TO anon;
GRANT UPDATE ON TABLE public.contacts TO anon;
GRANT DELETE ON TABLE public.cvent_attendees TO anon;
GRANT INSERT ON TABLE public.cvent_attendees TO anon;
GRANT REFERENCES ON TABLE public.cvent_attendees TO anon;
GRANT SELECT ON TABLE public.cvent_attendees TO anon;
GRANT TRIGGER ON TABLE public.cvent_attendees TO anon;
GRANT TRUNCATE ON TABLE public.cvent_attendees TO anon;
GRANT UPDATE ON TABLE public.cvent_attendees TO anon;
GRANT DELETE ON TABLE public.cvent_events TO anon;
GRANT INSERT ON TABLE public.cvent_events TO anon;
GRANT REFERENCES ON TABLE public.cvent_events TO anon;
GRANT SELECT ON TABLE public.cvent_events TO anon;
GRANT TRIGGER ON TABLE public.cvent_events TO anon;
GRANT TRUNCATE ON TABLE public.cvent_events TO anon;
GRANT UPDATE ON TABLE public.cvent_events TO anon;
GRANT DELETE ON TABLE public.cvent_order_items TO anon;
GRANT INSERT ON TABLE public.cvent_order_items TO anon;
GRANT REFERENCES ON TABLE public.cvent_order_items TO anon;
GRANT SELECT ON TABLE public.cvent_order_items TO anon;
GRANT TRIGGER ON TABLE public.cvent_order_items TO anon;
GRANT TRUNCATE ON TABLE public.cvent_order_items TO anon;
GRANT UPDATE ON TABLE public.cvent_order_items TO anon;
GRANT DELETE ON TABLE public.cvent_orders TO anon;
GRANT INSERT ON TABLE public.cvent_orders TO anon;
GRANT REFERENCES ON TABLE public.cvent_orders TO anon;
GRANT SELECT ON TABLE public.cvent_orders TO anon;
GRANT TRIGGER ON TABLE public.cvent_orders TO anon;
GRANT TRUNCATE ON TABLE public.cvent_orders TO anon;
GRANT UPDATE ON TABLE public.cvent_orders TO anon;
GRANT DELETE ON TABLE public.dashboard_summaries TO anon;
GRANT INSERT ON TABLE public.dashboard_summaries TO anon;
GRANT REFERENCES ON TABLE public.dashboard_summaries TO anon;
GRANT SELECT ON TABLE public.dashboard_summaries TO anon;
GRANT TRIGGER ON TABLE public.dashboard_summaries TO anon;
GRANT TRUNCATE ON TABLE public.dashboard_summaries TO anon;
GRANT UPDATE ON TABLE public.dashboard_summaries TO anon;
GRANT DELETE ON TABLE public.discovered_media_urls TO anon;
GRANT INSERT ON TABLE public.discovered_media_urls TO anon;
GRANT REFERENCES ON TABLE public.discovered_media_urls TO anon;
GRANT SELECT ON TABLE public.discovered_media_urls TO anon;
GRANT TRIGGER ON TABLE public.discovered_media_urls TO anon;
GRANT TRUNCATE ON TABLE public.discovered_media_urls TO anon;
GRANT UPDATE ON TABLE public.discovered_media_urls TO anon;
GRANT DELETE ON TABLE public.email_conversations TO anon;
GRANT INSERT ON TABLE public.email_conversations TO anon;
GRANT REFERENCES ON TABLE public.email_conversations TO anon;
GRANT SELECT ON TABLE public.email_conversations TO anon;
GRANT TRIGGER ON TABLE public.email_conversations TO anon;
GRANT TRUNCATE ON TABLE public.email_conversations TO anon;
GRANT UPDATE ON TABLE public.email_conversations TO anon;
GRANT DELETE ON TABLE public.email_sequences TO anon;
GRANT INSERT ON TABLE public.email_sequences TO anon;
GRANT REFERENCES ON TABLE public.email_sequences TO anon;
GRANT SELECT ON TABLE public.email_sequences TO anon;
GRANT TRIGGER ON TABLE public.email_sequences TO anon;
GRANT TRUNCATE ON TABLE public.email_sequences TO anon;
GRANT UPDATE ON TABLE public.email_sequences TO anon;
GRANT DELETE ON TABLE public.enrollments TO anon;
GRANT INSERT ON TABLE public.enrollments TO anon;
GRANT REFERENCES ON TABLE public.enrollments TO anon;
GRANT SELECT ON TABLE public.enrollments TO anon;
GRANT TRIGGER ON TABLE public.enrollments TO anon;
GRANT TRUNCATE ON TABLE public.enrollments TO anon;
GRANT UPDATE ON TABLE public.enrollments TO anon;
GRANT DELETE ON TABLE public.eval_runs TO anon;
GRANT INSERT ON TABLE public.eval_runs TO anon;
GRANT REFERENCES ON TABLE public.eval_runs TO anon;
GRANT SELECT ON TABLE public.eval_runs TO anon;
GRANT TRIGGER ON TABLE public.eval_runs TO anon;
GRANT TRUNCATE ON TABLE public.eval_runs TO anon;
GRANT UPDATE ON TABLE public.eval_runs TO anon;
GRANT DELETE ON TABLE public.facts_applications TO anon;
GRANT INSERT ON TABLE public.facts_applications TO anon;
GRANT REFERENCES ON TABLE public.facts_applications TO anon;
GRANT SELECT ON TABLE public.facts_applications TO anon;
GRANT TRIGGER ON TABLE public.facts_applications TO anon;
GRANT TRUNCATE ON TABLE public.facts_applications TO anon;
GRANT UPDATE ON TABLE public.facts_applications TO anon;
GRANT DELETE ON TABLE public.facts_inquiries TO anon;
GRANT INSERT ON TABLE public.facts_inquiries TO anon;
GRANT REFERENCES ON TABLE public.facts_inquiries TO anon;
GRANT SELECT ON TABLE public.facts_inquiries TO anon;
GRANT TRIGGER ON TABLE public.facts_inquiries TO anon;
GRANT TRUNCATE ON TABLE public.facts_inquiries TO anon;
GRANT UPDATE ON TABLE public.facts_inquiries TO anon;
GRANT DELETE ON TABLE public.families TO anon;
GRANT INSERT ON TABLE public.families TO anon;
GRANT REFERENCES ON TABLE public.families TO anon;
GRANT SELECT ON TABLE public.families TO anon;
GRANT TRIGGER ON TABLE public.families TO anon;
GRANT TRUNCATE ON TABLE public.families TO anon;
GRANT UPDATE ON TABLE public.families TO anon;
GRANT DELETE ON TABLE public.form_intake_configs TO anon;
GRANT INSERT ON TABLE public.form_intake_configs TO anon;
GRANT REFERENCES ON TABLE public.form_intake_configs TO anon;
GRANT SELECT ON TABLE public.form_intake_configs TO anon;
GRANT TRIGGER ON TABLE public.form_intake_configs TO anon;
GRANT TRUNCATE ON TABLE public.form_intake_configs TO anon;
GRANT UPDATE ON TABLE public.form_intake_configs TO anon;
GRANT DELETE ON TABLE public.form_submissions TO anon;
GRANT INSERT ON TABLE public.form_submissions TO anon;
GRANT REFERENCES ON TABLE public.form_submissions TO anon;
GRANT SELECT ON TABLE public.form_submissions TO anon;
GRANT TRIGGER ON TABLE public.form_submissions TO anon;
GRANT TRUNCATE ON TABLE public.form_submissions TO anon;
GRANT UPDATE ON TABLE public.form_submissions TO anon;
GRANT DELETE ON TABLE public.ga4_daily TO anon;
GRANT INSERT ON TABLE public.ga4_daily TO anon;
GRANT REFERENCES ON TABLE public.ga4_daily TO anon;
GRANT SELECT ON TABLE public.ga4_daily TO anon;
GRANT TRIGGER ON TABLE public.ga4_daily TO anon;
GRANT TRUNCATE ON TABLE public.ga4_daily TO anon;
GRANT UPDATE ON TABLE public.ga4_daily TO anon;
GRANT DELETE ON TABLE public.ga4_integrations TO anon;
GRANT INSERT ON TABLE public.ga4_integrations TO anon;
GRANT REFERENCES ON TABLE public.ga4_integrations TO anon;
GRANT SELECT ON TABLE public.ga4_integrations TO anon;
GRANT TRIGGER ON TABLE public.ga4_integrations TO anon;
GRANT TRUNCATE ON TABLE public.ga4_integrations TO anon;
GRANT UPDATE ON TABLE public.ga4_integrations TO anon;
GRANT DELETE ON TABLE public.ga4_key_events_daily TO anon;
GRANT INSERT ON TABLE public.ga4_key_events_daily TO anon;
GRANT REFERENCES ON TABLE public.ga4_key_events_daily TO anon;
GRANT SELECT ON TABLE public.ga4_key_events_daily TO anon;
GRANT TRIGGER ON TABLE public.ga4_key_events_daily TO anon;
GRANT TRUNCATE ON TABLE public.ga4_key_events_daily TO anon;
GRANT UPDATE ON TABLE public.ga4_key_events_daily TO anon;
GRANT DELETE ON TABLE public.ga4_pages_daily TO anon;
GRANT INSERT ON TABLE public.ga4_pages_daily TO anon;
GRANT REFERENCES ON TABLE public.ga4_pages_daily TO anon;
GRANT SELECT ON TABLE public.ga4_pages_daily TO anon;
GRANT TRIGGER ON TABLE public.ga4_pages_daily TO anon;
GRANT TRUNCATE ON TABLE public.ga4_pages_daily TO anon;
GRANT UPDATE ON TABLE public.ga4_pages_daily TO anon;
GRANT DELETE ON TABLE public.gmail_integrations TO anon;
GRANT INSERT ON TABLE public.gmail_integrations TO anon;
GRANT REFERENCES ON TABLE public.gmail_integrations TO anon;
GRANT SELECT ON TABLE public.gmail_integrations TO anon;
GRANT TRIGGER ON TABLE public.gmail_integrations TO anon;
GRANT TRUNCATE ON TABLE public.gmail_integrations TO anon;
GRANT UPDATE ON TABLE public.gmail_integrations TO anon;
GRANT DELETE ON TABLE public.gmail_messages TO anon;
GRANT INSERT ON TABLE public.gmail_messages TO anon;
GRANT REFERENCES ON TABLE public.gmail_messages TO anon;
GRANT SELECT ON TABLE public.gmail_messages TO anon;
GRANT TRIGGER ON TABLE public.gmail_messages TO anon;
GRANT TRUNCATE ON TABLE public.gmail_messages TO anon;
GRANT UPDATE ON TABLE public.gmail_messages TO anon;
GRANT DELETE ON TABLE public.gmail_threads TO anon;
GRANT INSERT ON TABLE public.gmail_threads TO anon;
GRANT REFERENCES ON TABLE public.gmail_threads TO anon;
GRANT SELECT ON TABLE public.gmail_threads TO anon;
GRANT TRIGGER ON TABLE public.gmail_threads TO anon;
GRANT TRUNCATE ON TABLE public.gmail_threads TO anon;
GRANT UPDATE ON TABLE public.gmail_threads TO anon;
GRANT DELETE ON TABLE public.google_ads_campaigns TO anon;
GRANT INSERT ON TABLE public.google_ads_campaigns TO anon;
GRANT REFERENCES ON TABLE public.google_ads_campaigns TO anon;
GRANT SELECT ON TABLE public.google_ads_campaigns TO anon;
GRANT TRIGGER ON TABLE public.google_ads_campaigns TO anon;
GRANT TRUNCATE ON TABLE public.google_ads_campaigns TO anon;
GRANT UPDATE ON TABLE public.google_ads_campaigns TO anon;
GRANT DELETE ON TABLE public.google_ads_integrations TO anon;
GRANT INSERT ON TABLE public.google_ads_integrations TO anon;
GRANT REFERENCES ON TABLE public.google_ads_integrations TO anon;
GRANT SELECT ON TABLE public.google_ads_integrations TO anon;
GRANT TRIGGER ON TABLE public.google_ads_integrations TO anon;
GRANT TRUNCATE ON TABLE public.google_ads_integrations TO anon;
GRANT UPDATE ON TABLE public.google_ads_integrations TO anon;
GRANT DELETE ON TABLE public.industry_links TO anon;
GRANT INSERT ON TABLE public.industry_links TO anon;
GRANT REFERENCES ON TABLE public.industry_links TO anon;
GRANT SELECT ON TABLE public.industry_links TO anon;
GRANT TRIGGER ON TABLE public.industry_links TO anon;
GRANT TRUNCATE ON TABLE public.industry_links TO anon;
GRANT UPDATE ON TABLE public.industry_links TO anon;
GRANT DELETE ON TABLE public.invite_tokens TO anon;
GRANT INSERT ON TABLE public.invite_tokens TO anon;
GRANT REFERENCES ON TABLE public.invite_tokens TO anon;
GRANT SELECT ON TABLE public.invite_tokens TO anon;
GRANT TRIGGER ON TABLE public.invite_tokens TO anon;
GRANT TRUNCATE ON TABLE public.invite_tokens TO anon;
GRANT UPDATE ON TABLE public.invite_tokens TO anon;
GRANT DELETE ON TABLE public.knowledge_bases TO anon;
GRANT INSERT ON TABLE public.knowledge_bases TO anon;
GRANT REFERENCES ON TABLE public.knowledge_bases TO anon;
GRANT SELECT ON TABLE public.knowledge_bases TO anon;
GRANT TRIGGER ON TABLE public.knowledge_bases TO anon;
GRANT TRUNCATE ON TABLE public.knowledge_bases TO anon;
GRANT UPDATE ON TABLE public.knowledge_bases TO anon;
GRANT DELETE ON TABLE public.legal_firms TO anon;
GRANT INSERT ON TABLE public.legal_firms TO anon;
GRANT REFERENCES ON TABLE public.legal_firms TO anon;
GRANT SELECT ON TABLE public.legal_firms TO anon;
GRANT TRIGGER ON TABLE public.legal_firms TO anon;
GRANT TRUNCATE ON TABLE public.legal_firms TO anon;
GRANT UPDATE ON TABLE public.legal_firms TO anon;
GRANT DELETE ON TABLE public.meta_ads_daily TO anon;
GRANT INSERT ON TABLE public.meta_ads_daily TO anon;
GRANT REFERENCES ON TABLE public.meta_ads_daily TO anon;
GRANT SELECT ON TABLE public.meta_ads_daily TO anon;
GRANT TRIGGER ON TABLE public.meta_ads_daily TO anon;
GRANT TRUNCATE ON TABLE public.meta_ads_daily TO anon;
GRANT UPDATE ON TABLE public.meta_ads_daily TO anon;
GRANT DELETE ON TABLE public.meta_ig_daily TO anon;
GRANT INSERT ON TABLE public.meta_ig_daily TO anon;
GRANT REFERENCES ON TABLE public.meta_ig_daily TO anon;
GRANT SELECT ON TABLE public.meta_ig_daily TO anon;
GRANT TRIGGER ON TABLE public.meta_ig_daily TO anon;
GRANT TRUNCATE ON TABLE public.meta_ig_daily TO anon;
GRANT UPDATE ON TABLE public.meta_ig_daily TO anon;
GRANT DELETE ON TABLE public.meta_integrations TO anon;
GRANT INSERT ON TABLE public.meta_integrations TO anon;
GRANT REFERENCES ON TABLE public.meta_integrations TO anon;
GRANT SELECT ON TABLE public.meta_integrations TO anon;
GRANT TRIGGER ON TABLE public.meta_integrations TO anon;
GRANT TRUNCATE ON TABLE public.meta_integrations TO anon;
GRANT UPDATE ON TABLE public.meta_integrations TO anon;
GRANT DELETE ON TABLE public.meta_page_daily TO anon;
GRANT INSERT ON TABLE public.meta_page_daily TO anon;
GRANT REFERENCES ON TABLE public.meta_page_daily TO anon;
GRANT SELECT ON TABLE public.meta_page_daily TO anon;
GRANT TRIGGER ON TABLE public.meta_page_daily TO anon;
GRANT TRUNCATE ON TABLE public.meta_page_daily TO anon;
GRANT UPDATE ON TABLE public.meta_page_daily TO anon;
GRANT DELETE ON TABLE public.pipeline_history TO anon;
GRANT INSERT ON TABLE public.pipeline_history TO anon;
GRANT REFERENCES ON TABLE public.pipeline_history TO anon;
GRANT SELECT ON TABLE public.pipeline_history TO anon;
GRANT TRIGGER ON TABLE public.pipeline_history TO anon;
GRANT TRUNCATE ON TABLE public.pipeline_history TO anon;
GRANT UPDATE ON TABLE public.pipeline_history TO anon;
GRANT DELETE ON TABLE public.pipeline_stages TO anon;
GRANT INSERT ON TABLE public.pipeline_stages TO anon;
GRANT REFERENCES ON TABLE public.pipeline_stages TO anon;
GRANT SELECT ON TABLE public.pipeline_stages TO anon;
GRANT TRIGGER ON TABLE public.pipeline_stages TO anon;
GRANT TRUNCATE ON TABLE public.pipeline_stages TO anon;
GRANT UPDATE ON TABLE public.pipeline_stages TO anon;
GRANT DELETE ON TABLE public.portal_invites TO anon;
GRANT INSERT ON TABLE public.portal_invites TO anon;
GRANT REFERENCES ON TABLE public.portal_invites TO anon;
GRANT SELECT ON TABLE public.portal_invites TO anon;
GRANT TRIGGER ON TABLE public.portal_invites TO anon;
GRANT TRUNCATE ON TABLE public.portal_invites TO anon;
GRANT UPDATE ON TABLE public.portal_invites TO anon;
GRANT DELETE ON TABLE public.portal_questions TO anon;
GRANT INSERT ON TABLE public.portal_questions TO anon;
GRANT REFERENCES ON TABLE public.portal_questions TO anon;
GRANT SELECT ON TABLE public.portal_questions TO anon;
GRANT TRIGGER ON TABLE public.portal_questions TO anon;
GRANT TRUNCATE ON TABLE public.portal_questions TO anon;
GRANT UPDATE ON TABLE public.portal_questions TO anon;
GRANT DELETE ON TABLE public.posts TO anon;
GRANT INSERT ON TABLE public.posts TO anon;
GRANT REFERENCES ON TABLE public.posts TO anon;
GRANT SELECT ON TABLE public.posts TO anon;
GRANT TRIGGER ON TABLE public.posts TO anon;
GRANT TRUNCATE ON TABLE public.posts TO anon;
GRANT UPDATE ON TABLE public.posts TO anon;
GRANT DELETE ON TABLE public.programs TO anon;
GRANT INSERT ON TABLE public.programs TO anon;
GRANT REFERENCES ON TABLE public.programs TO anon;
GRANT SELECT ON TABLE public.programs TO anon;
GRANT TRIGGER ON TABLE public.programs TO anon;
GRANT TRUNCATE ON TABLE public.programs TO anon;
GRANT UPDATE ON TABLE public.programs TO anon;
GRANT DELETE ON TABLE public.prospects TO anon;
GRANT INSERT ON TABLE public.prospects TO anon;
GRANT REFERENCES ON TABLE public.prospects TO anon;
GRANT SELECT ON TABLE public.prospects TO anon;
GRANT TRIGGER ON TABLE public.prospects TO anon;
GRANT TRUNCATE ON TABLE public.prospects TO anon;
GRANT UPDATE ON TABLE public.prospects TO anon;
GRANT DELETE ON TABLE public.salesforce_campaign_members TO anon;
GRANT INSERT ON TABLE public.salesforce_campaign_members TO anon;
GRANT REFERENCES ON TABLE public.salesforce_campaign_members TO anon;
GRANT SELECT ON TABLE public.salesforce_campaign_members TO anon;
GRANT TRIGGER ON TABLE public.salesforce_campaign_members TO anon;
GRANT TRUNCATE ON TABLE public.salesforce_campaign_members TO anon;
GRANT UPDATE ON TABLE public.salesforce_campaign_members TO anon;
GRANT DELETE ON TABLE public.salesforce_campaigns TO anon;
GRANT INSERT ON TABLE public.salesforce_campaigns TO anon;
GRANT REFERENCES ON TABLE public.salesforce_campaigns TO anon;
GRANT SELECT ON TABLE public.salesforce_campaigns TO anon;
GRANT TRIGGER ON TABLE public.salesforce_campaigns TO anon;
GRANT TRUNCATE ON TABLE public.salesforce_campaigns TO anon;
GRANT UPDATE ON TABLE public.salesforce_campaigns TO anon;
GRANT DELETE ON TABLE public.scheduled_emails TO anon;
GRANT INSERT ON TABLE public.scheduled_emails TO anon;
GRANT REFERENCES ON TABLE public.scheduled_emails TO anon;
GRANT SELECT ON TABLE public.scheduled_emails TO anon;
GRANT TRIGGER ON TABLE public.scheduled_emails TO anon;
GRANT TRUNCATE ON TABLE public.scheduled_emails TO anon;
GRANT UPDATE ON TABLE public.scheduled_emails TO anon;
GRANT DELETE ON TABLE public.school_events TO anon;
GRANT INSERT ON TABLE public.school_events TO anon;
GRANT REFERENCES ON TABLE public.school_events TO anon;
GRANT SELECT ON TABLE public.school_events TO anon;
GRANT TRIGGER ON TABLE public.school_events TO anon;
GRANT TRUNCATE ON TABLE public.school_events TO anon;
GRANT UPDATE ON TABLE public.school_events TO anon;
GRANT DELETE ON TABLE public.sequence_analytics TO anon;
GRANT INSERT ON TABLE public.sequence_analytics TO anon;
GRANT REFERENCES ON TABLE public.sequence_analytics TO anon;
GRANT SELECT ON TABLE public.sequence_analytics TO anon;
GRANT TRIGGER ON TABLE public.sequence_analytics TO anon;
GRANT TRUNCATE ON TABLE public.sequence_analytics TO anon;
GRANT UPDATE ON TABLE public.sequence_analytics TO anon;
GRANT DELETE ON TABLE public.sequence_enrollments TO anon;
GRANT INSERT ON TABLE public.sequence_enrollments TO anon;
GRANT REFERENCES ON TABLE public.sequence_enrollments TO anon;
GRANT SELECT ON TABLE public.sequence_enrollments TO anon;
GRANT TRIGGER ON TABLE public.sequence_enrollments TO anon;
GRANT TRUNCATE ON TABLE public.sequence_enrollments TO anon;
GRANT UPDATE ON TABLE public.sequence_enrollments TO anon;
GRANT DELETE ON TABLE public.sequence_steps TO anon;
GRANT INSERT ON TABLE public.sequence_steps TO anon;
GRANT REFERENCES ON TABLE public.sequence_steps TO anon;
GRANT SELECT ON TABLE public.sequence_steps TO anon;
GRANT TRIGGER ON TABLE public.sequence_steps TO anon;
GRANT TRUNCATE ON TABLE public.sequence_steps TO anon;
GRANT UPDATE ON TABLE public.sequence_steps TO anon;
GRANT DELETE ON TABLE public.service_health_checks TO anon;
GRANT INSERT ON TABLE public.service_health_checks TO anon;
GRANT REFERENCES ON TABLE public.service_health_checks TO anon;
GRANT SELECT ON TABLE public.service_health_checks TO anon;
GRANT TRIGGER ON TABLE public.service_health_checks TO anon;
GRANT TRUNCATE ON TABLE public.service_health_checks TO anon;
GRANT UPDATE ON TABLE public.service_health_checks TO anon;
GRANT DELETE ON TABLE public.site_404_log TO anon;
GRANT INSERT ON TABLE public.site_404_log TO anon;
GRANT REFERENCES ON TABLE public.site_404_log TO anon;
GRANT SELECT ON TABLE public.site_404_log TO anon;
GRANT TRIGGER ON TABLE public.site_404_log TO anon;
GRANT TRUNCATE ON TABLE public.site_404_log TO anon;
GRANT UPDATE ON TABLE public.site_404_log TO anon;
GRANT DELETE ON TABLE public.site_subscriptions TO anon;
GRANT INSERT ON TABLE public.site_subscriptions TO anon;
GRANT REFERENCES ON TABLE public.site_subscriptions TO anon;
GRANT SELECT ON TABLE public.site_subscriptions TO anon;
GRANT TRIGGER ON TABLE public.site_subscriptions TO anon;
GRANT TRUNCATE ON TABLE public.site_subscriptions TO anon;
GRANT UPDATE ON TABLE public.site_subscriptions TO anon;
GRANT DELETE ON TABLE public.sites TO anon;
GRANT INSERT ON TABLE public.sites TO anon;
GRANT REFERENCES ON TABLE public.sites TO anon;
GRANT SELECT ON TABLE public.sites TO anon;
GRANT TRIGGER ON TABLE public.sites TO anon;
GRANT TRUNCATE ON TABLE public.sites TO anon;
GRANT UPDATE ON TABLE public.sites TO anon;
GRANT DELETE ON TABLE public.sr_findings TO anon;
GRANT INSERT ON TABLE public.sr_findings TO anon;
GRANT REFERENCES ON TABLE public.sr_findings TO anon;
GRANT SELECT ON TABLE public.sr_findings TO anon;
GRANT TRIGGER ON TABLE public.sr_findings TO anon;
GRANT TRUNCATE ON TABLE public.sr_findings TO anon;
GRANT UPDATE ON TABLE public.sr_findings TO anon;
GRANT DELETE ON TABLE public.sr_orgs TO anon;
GRANT INSERT ON TABLE public.sr_orgs TO anon;
GRANT REFERENCES ON TABLE public.sr_orgs TO anon;
GRANT SELECT ON TABLE public.sr_orgs TO anon;
GRANT TRIGGER ON TABLE public.sr_orgs TO anon;
GRANT TRUNCATE ON TABLE public.sr_orgs TO anon;
GRANT UPDATE ON TABLE public.sr_orgs TO anon;
GRANT DELETE ON TABLE public.sr_outreach TO anon;
GRANT INSERT ON TABLE public.sr_outreach TO anon;
GRANT REFERENCES ON TABLE public.sr_outreach TO anon;
GRANT SELECT ON TABLE public.sr_outreach TO anon;
GRANT TRIGGER ON TABLE public.sr_outreach TO anon;
GRANT TRUNCATE ON TABLE public.sr_outreach TO anon;
GRANT UPDATE ON TABLE public.sr_outreach TO anon;
GRANT DELETE ON TABLE public.sr_people TO anon;
GRANT INSERT ON TABLE public.sr_people TO anon;
GRANT REFERENCES ON TABLE public.sr_people TO anon;
GRANT SELECT ON TABLE public.sr_people TO anon;
GRANT TRIGGER ON TABLE public.sr_people TO anon;
GRANT TRUNCATE ON TABLE public.sr_people TO anon;
GRANT UPDATE ON TABLE public.sr_people TO anon;
GRANT DELETE ON TABLE public.sr_sync_state TO anon;
GRANT INSERT ON TABLE public.sr_sync_state TO anon;
GRANT REFERENCES ON TABLE public.sr_sync_state TO anon;
GRANT SELECT ON TABLE public.sr_sync_state TO anon;
GRANT TRIGGER ON TABLE public.sr_sync_state TO anon;
GRANT TRUNCATE ON TABLE public.sr_sync_state TO anon;
GRANT UPDATE ON TABLE public.sr_sync_state TO anon;
GRANT DELETE ON TABLE public.sr_worklist TO anon;
GRANT INSERT ON TABLE public.sr_worklist TO anon;
GRANT REFERENCES ON TABLE public.sr_worklist TO anon;
GRANT SELECT ON TABLE public.sr_worklist TO anon;
GRANT TRIGGER ON TABLE public.sr_worklist TO anon;
GRANT TRUNCATE ON TABLE public.sr_worklist TO anon;
GRANT UPDATE ON TABLE public.sr_worklist TO anon;
GRANT DELETE ON TABLE public.subscriber_sessions TO anon;
GRANT INSERT ON TABLE public.subscriber_sessions TO anon;
GRANT REFERENCES ON TABLE public.subscriber_sessions TO anon;
GRANT SELECT ON TABLE public.subscriber_sessions TO anon;
GRANT TRIGGER ON TABLE public.subscriber_sessions TO anon;
GRANT TRUNCATE ON TABLE public.subscriber_sessions TO anon;
GRANT UPDATE ON TABLE public.subscriber_sessions TO anon;
GRANT DELETE ON TABLE public.sync_health TO anon;
GRANT INSERT ON TABLE public.sync_health TO anon;
GRANT REFERENCES ON TABLE public.sync_health TO anon;
GRANT SELECT ON TABLE public.sync_health TO anon;
GRANT TRIGGER ON TABLE public.sync_health TO anon;
GRANT TRUNCATE ON TABLE public.sync_health TO anon;
GRANT UPDATE ON TABLE public.sync_health TO anon;
GRANT DELETE ON TABLE public.sync_runs TO anon;
GRANT INSERT ON TABLE public.sync_runs TO anon;
GRANT REFERENCES ON TABLE public.sync_runs TO anon;
GRANT SELECT ON TABLE public.sync_runs TO anon;
GRANT TRIGGER ON TABLE public.sync_runs TO anon;
GRANT TRUNCATE ON TABLE public.sync_runs TO anon;
GRANT UPDATE ON TABLE public.sync_runs TO anon;
GRANT DELETE ON TABLE public.tags TO anon;
GRANT INSERT ON TABLE public.tags TO anon;
GRANT REFERENCES ON TABLE public.tags TO anon;
GRANT SELECT ON TABLE public.tags TO anon;
GRANT TRIGGER ON TABLE public.tags TO anon;
GRANT TRUNCATE ON TABLE public.tags TO anon;
GRANT UPDATE ON TABLE public.tags TO anon;
GRANT DELETE ON TABLE public.template_folders TO anon;
GRANT INSERT ON TABLE public.template_folders TO anon;
GRANT REFERENCES ON TABLE public.template_folders TO anon;
GRANT SELECT ON TABLE public.template_folders TO anon;
GRANT TRIGGER ON TABLE public.template_folders TO anon;
GRANT TRUNCATE ON TABLE public.template_folders TO anon;
GRANT UPDATE ON TABLE public.template_folders TO anon;
GRANT DELETE ON TABLE public.templates TO anon;
GRANT INSERT ON TABLE public.templates TO anon;
GRANT REFERENCES ON TABLE public.templates TO anon;
GRANT SELECT ON TABLE public.templates TO anon;
GRANT TRIGGER ON TABLE public.templates TO anon;
GRANT TRUNCATE ON TABLE public.templates TO anon;
GRANT UPDATE ON TABLE public.templates TO anon;
GRANT DELETE ON TABLE public.tours TO anon;
GRANT INSERT ON TABLE public.tours TO anon;
GRANT REFERENCES ON TABLE public.tours TO anon;
GRANT SELECT ON TABLE public.tours TO anon;
GRANT TRIGGER ON TABLE public.tours TO anon;
GRANT TRUNCATE ON TABLE public.tours TO anon;
GRANT UPDATE ON TABLE public.tours TO anon;
GRANT DELETE ON TABLE public.video_allowed_users TO anon;
GRANT INSERT ON TABLE public.video_allowed_users TO anon;
GRANT REFERENCES ON TABLE public.video_allowed_users TO anon;
GRANT SELECT ON TABLE public.video_allowed_users TO anon;
GRANT TRIGGER ON TABLE public.video_allowed_users TO anon;
GRANT TRUNCATE ON TABLE public.video_allowed_users TO anon;
GRANT UPDATE ON TABLE public.video_allowed_users TO anon;
GRANT DELETE ON TABLE public.video_generations TO anon;
GRANT INSERT ON TABLE public.video_generations TO anon;
GRANT REFERENCES ON TABLE public.video_generations TO anon;
GRANT SELECT ON TABLE public.video_generations TO anon;
GRANT TRIGGER ON TABLE public.video_generations TO anon;
GRANT TRUNCATE ON TABLE public.video_generations TO anon;
GRANT UPDATE ON TABLE public.video_generations TO anon;
GRANT DELETE ON TABLE public.visit_events TO anon;
GRANT INSERT ON TABLE public.visit_events TO anon;
GRANT REFERENCES ON TABLE public.visit_events TO anon;
GRANT SELECT ON TABLE public.visit_events TO anon;
GRANT TRIGGER ON TABLE public.visit_events TO anon;
GRANT TRUNCATE ON TABLE public.visit_events TO anon;
GRANT UPDATE ON TABLE public.visit_events TO anon;
GRANT DELETE ON TABLE public.woocommerce_orders TO anon;
GRANT INSERT ON TABLE public.woocommerce_orders TO anon;
GRANT REFERENCES ON TABLE public.woocommerce_orders TO anon;
GRANT SELECT ON TABLE public.woocommerce_orders TO anon;
GRANT TRIGGER ON TABLE public.woocommerce_orders TO anon;
GRANT TRUNCATE ON TABLE public.woocommerce_orders TO anon;
GRANT UPDATE ON TABLE public.woocommerce_orders TO anon;
GRANT DELETE ON TABLE public.admin_users TO authenticated;
GRANT INSERT ON TABLE public.admin_users TO authenticated;
GRANT REFERENCES ON TABLE public.admin_users TO authenticated;
GRANT SELECT ON TABLE public.admin_users TO authenticated;
GRANT TRIGGER ON TABLE public.admin_users TO authenticated;
GRANT TRUNCATE ON TABLE public.admin_users TO authenticated;
GRANT UPDATE ON TABLE public.admin_users TO authenticated;
GRANT DELETE ON TABLE public.ai_followup_analytics TO authenticated;
GRANT INSERT ON TABLE public.ai_followup_analytics TO authenticated;
GRANT REFERENCES ON TABLE public.ai_followup_analytics TO authenticated;
GRANT SELECT ON TABLE public.ai_followup_analytics TO authenticated;
GRANT TRIGGER ON TABLE public.ai_followup_analytics TO authenticated;
GRANT TRUNCATE ON TABLE public.ai_followup_analytics TO authenticated;
GRANT UPDATE ON TABLE public.ai_followup_analytics TO authenticated;
GRANT DELETE ON TABLE public.ai_followup_config TO authenticated;
GRANT INSERT ON TABLE public.ai_followup_config TO authenticated;
GRANT REFERENCES ON TABLE public.ai_followup_config TO authenticated;
GRANT SELECT ON TABLE public.ai_followup_config TO authenticated;
GRANT TRIGGER ON TABLE public.ai_followup_config TO authenticated;
GRANT TRUNCATE ON TABLE public.ai_followup_config TO authenticated;
GRANT UPDATE ON TABLE public.ai_followup_config TO authenticated;
GRANT DELETE ON TABLE public.ai_followup_contacts TO authenticated;
GRANT INSERT ON TABLE public.ai_followup_contacts TO authenticated;
GRANT REFERENCES ON TABLE public.ai_followup_contacts TO authenticated;
GRANT SELECT ON TABLE public.ai_followup_contacts TO authenticated;
GRANT TRIGGER ON TABLE public.ai_followup_contacts TO authenticated;
GRANT TRUNCATE ON TABLE public.ai_followup_contacts TO authenticated;
GRANT UPDATE ON TABLE public.ai_followup_contacts TO authenticated;
GRANT DELETE ON TABLE public.ai_followup_drafts TO authenticated;
GRANT INSERT ON TABLE public.ai_followup_drafts TO authenticated;
GRANT REFERENCES ON TABLE public.ai_followup_drafts TO authenticated;
GRANT SELECT ON TABLE public.ai_followup_drafts TO authenticated;
GRANT TRIGGER ON TABLE public.ai_followup_drafts TO authenticated;
GRANT TRUNCATE ON TABLE public.ai_followup_drafts TO authenticated;
GRANT UPDATE ON TABLE public.ai_followup_drafts TO authenticated;
GRANT DELETE ON TABLE public.analytics_events TO authenticated;
GRANT INSERT ON TABLE public.analytics_events TO authenticated;
GRANT REFERENCES ON TABLE public.analytics_events TO authenticated;
GRANT SELECT ON TABLE public.analytics_events TO authenticated;
GRANT TRIGGER ON TABLE public.analytics_events TO authenticated;
GRANT TRUNCATE ON TABLE public.analytics_events TO authenticated;
GRANT UPDATE ON TABLE public.analytics_events TO authenticated;
GRANT DELETE ON TABLE public.applications TO authenticated;
GRANT INSERT ON TABLE public.applications TO authenticated;
GRANT REFERENCES ON TABLE public.applications TO authenticated;
GRANT SELECT ON TABLE public.applications TO authenticated;
GRANT TRIGGER ON TABLE public.applications TO authenticated;
GRANT TRUNCATE ON TABLE public.applications TO authenticated;
GRANT UPDATE ON TABLE public.applications TO authenticated;
GRANT DELETE ON TABLE public.cairn_sessions TO authenticated;
GRANT INSERT ON TABLE public.cairn_sessions TO authenticated;
GRANT REFERENCES ON TABLE public.cairn_sessions TO authenticated;
GRANT SELECT ON TABLE public.cairn_sessions TO authenticated;
GRANT TRIGGER ON TABLE public.cairn_sessions TO authenticated;
GRANT TRUNCATE ON TABLE public.cairn_sessions TO authenticated;
GRANT UPDATE ON TABLE public.cairn_sessions TO authenticated;
GRANT DELETE ON TABLE public.calendly_integrations TO authenticated;
GRANT INSERT ON TABLE public.calendly_integrations TO authenticated;
GRANT REFERENCES ON TABLE public.calendly_integrations TO authenticated;
GRANT SELECT ON TABLE public.calendly_integrations TO authenticated;
GRANT TRIGGER ON TABLE public.calendly_integrations TO authenticated;
GRANT TRUNCATE ON TABLE public.calendly_integrations TO authenticated;
GRANT UPDATE ON TABLE public.calendly_integrations TO authenticated;
GRANT DELETE ON TABLE public.campaign_folders TO authenticated;
GRANT INSERT ON TABLE public.campaign_folders TO authenticated;
GRANT REFERENCES ON TABLE public.campaign_folders TO authenticated;
GRANT SELECT ON TABLE public.campaign_folders TO authenticated;
GRANT TRIGGER ON TABLE public.campaign_folders TO authenticated;
GRANT TRUNCATE ON TABLE public.campaign_folders TO authenticated;
GRANT UPDATE ON TABLE public.campaign_folders TO authenticated;
GRANT DELETE ON TABLE public.campaigns TO authenticated;
GRANT INSERT ON TABLE public.campaigns TO authenticated;
GRANT REFERENCES ON TABLE public.campaigns TO authenticated;
GRANT SELECT ON TABLE public.campaigns TO authenticated;
GRANT TRIGGER ON TABLE public.campaigns TO authenticated;
GRANT TRUNCATE ON TABLE public.campaigns TO authenticated;
GRANT UPDATE ON TABLE public.campaigns TO authenticated;
GRANT DELETE ON TABLE public.cc_campaigns TO authenticated;
GRANT INSERT ON TABLE public.cc_campaigns TO authenticated;
GRANT REFERENCES ON TABLE public.cc_campaigns TO authenticated;
GRANT SELECT ON TABLE public.cc_campaigns TO authenticated;
GRANT TRIGGER ON TABLE public.cc_campaigns TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_campaigns TO authenticated;
GRANT UPDATE ON TABLE public.cc_campaigns TO authenticated;
GRANT DELETE ON TABLE public.cc_contacts TO authenticated;
GRANT INSERT ON TABLE public.cc_contacts TO authenticated;
GRANT REFERENCES ON TABLE public.cc_contacts TO authenticated;
GRANT SELECT ON TABLE public.cc_contacts TO authenticated;
GRANT TRIGGER ON TABLE public.cc_contacts TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_contacts TO authenticated;
GRANT UPDATE ON TABLE public.cc_contacts TO authenticated;
GRANT DELETE ON TABLE public.cc_decline_list_members TO authenticated;
GRANT INSERT ON TABLE public.cc_decline_list_members TO authenticated;
GRANT REFERENCES ON TABLE public.cc_decline_list_members TO authenticated;
GRANT SELECT ON TABLE public.cc_decline_list_members TO authenticated;
GRANT TRIGGER ON TABLE public.cc_decline_list_members TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_decline_list_members TO authenticated;
GRANT UPDATE ON TABLE public.cc_decline_list_members TO authenticated;
GRANT DELETE ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT INSERT ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT REFERENCES ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT SELECT ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT TRIGGER ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT UPDATE ON TABLE public.cc_decline_sync_runs TO authenticated;
GRANT DELETE ON TABLE public.cc_engagement TO authenticated;
GRANT INSERT ON TABLE public.cc_engagement TO authenticated;
GRANT REFERENCES ON TABLE public.cc_engagement TO authenticated;
GRANT SELECT ON TABLE public.cc_engagement TO authenticated;
GRANT TRIGGER ON TABLE public.cc_engagement TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_engagement TO authenticated;
GRANT UPDATE ON TABLE public.cc_engagement TO authenticated;
GRANT DELETE ON TABLE public.cc_integrations TO authenticated;
GRANT INSERT ON TABLE public.cc_integrations TO authenticated;
GRANT REFERENCES ON TABLE public.cc_integrations TO authenticated;
GRANT SELECT ON TABLE public.cc_integrations TO authenticated;
GRANT TRIGGER ON TABLE public.cc_integrations TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_integrations TO authenticated;
GRANT UPDATE ON TABLE public.cc_integrations TO authenticated;
GRANT DELETE ON TABLE public.cc_list_memberships TO authenticated;
GRANT INSERT ON TABLE public.cc_list_memberships TO authenticated;
GRANT REFERENCES ON TABLE public.cc_list_memberships TO authenticated;
GRANT SELECT ON TABLE public.cc_list_memberships TO authenticated;
GRANT TRIGGER ON TABLE public.cc_list_memberships TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_list_memberships TO authenticated;
GRANT UPDATE ON TABLE public.cc_list_memberships TO authenticated;
GRANT DELETE ON TABLE public.cc_lists TO authenticated;
GRANT INSERT ON TABLE public.cc_lists TO authenticated;
GRANT REFERENCES ON TABLE public.cc_lists TO authenticated;
GRANT SELECT ON TABLE public.cc_lists TO authenticated;
GRANT TRIGGER ON TABLE public.cc_lists TO authenticated;
GRANT TRUNCATE ON TABLE public.cc_lists TO authenticated;
GRANT UPDATE ON TABLE public.cc_lists TO authenticated;
GRANT DELETE ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT INSERT ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT REFERENCES ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT SELECT ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT TRIGGER ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT TRUNCATE ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT UPDATE ON TABLE public.cfa_consolidated_people TO authenticated;
GRANT DELETE ON TABLE public.cfa_page_events TO authenticated;
GRANT INSERT ON TABLE public.cfa_page_events TO authenticated;
GRANT REFERENCES ON TABLE public.cfa_page_events TO authenticated;
GRANT SELECT ON TABLE public.cfa_page_events TO authenticated;
GRANT TRIGGER ON TABLE public.cfa_page_events TO authenticated;
GRANT TRUNCATE ON TABLE public.cfa_page_events TO authenticated;
GRANT UPDATE ON TABLE public.cfa_page_events TO authenticated;
GRANT DELETE ON TABLE public.clients TO authenticated;
GRANT INSERT ON TABLE public.clients TO authenticated;
GRANT REFERENCES ON TABLE public.clients TO authenticated;
GRANT SELECT ON TABLE public.clients TO authenticated;
GRANT TRIGGER ON TABLE public.clients TO authenticated;
GRANT TRUNCATE ON TABLE public.clients TO authenticated;
GRANT UPDATE ON TABLE public.clients TO authenticated;
GRANT DELETE ON TABLE public.contact_notes TO authenticated;
GRANT INSERT ON TABLE public.contact_notes TO authenticated;
GRANT REFERENCES ON TABLE public.contact_notes TO authenticated;
GRANT SELECT ON TABLE public.contact_notes TO authenticated;
GRANT TRIGGER ON TABLE public.contact_notes TO authenticated;
GRANT TRUNCATE ON TABLE public.contact_notes TO authenticated;
GRANT UPDATE ON TABLE public.contact_notes TO authenticated;
GRANT DELETE ON TABLE public.contact_tasks TO authenticated;
GRANT INSERT ON TABLE public.contact_tasks TO authenticated;
GRANT REFERENCES ON TABLE public.contact_tasks TO authenticated;
GRANT SELECT ON TABLE public.contact_tasks TO authenticated;
GRANT TRIGGER ON TABLE public.contact_tasks TO authenticated;
GRANT TRUNCATE ON TABLE public.contact_tasks TO authenticated;
GRANT UPDATE ON TABLE public.contact_tasks TO authenticated;
GRANT DELETE ON TABLE public.contacts TO authenticated;
GRANT INSERT ON TABLE public.contacts TO authenticated;
GRANT REFERENCES ON TABLE public.contacts TO authenticated;
GRANT SELECT ON TABLE public.contacts TO authenticated;
GRANT TRIGGER ON TABLE public.contacts TO authenticated;
GRANT TRUNCATE ON TABLE public.contacts TO authenticated;
GRANT UPDATE ON TABLE public.contacts TO authenticated;
GRANT DELETE ON TABLE public.cvent_attendees TO authenticated;
GRANT INSERT ON TABLE public.cvent_attendees TO authenticated;
GRANT REFERENCES ON TABLE public.cvent_attendees TO authenticated;
GRANT SELECT ON TABLE public.cvent_attendees TO authenticated;
GRANT TRIGGER ON TABLE public.cvent_attendees TO authenticated;
GRANT TRUNCATE ON TABLE public.cvent_attendees TO authenticated;
GRANT UPDATE ON TABLE public.cvent_attendees TO authenticated;
GRANT DELETE ON TABLE public.cvent_events TO authenticated;
GRANT INSERT ON TABLE public.cvent_events TO authenticated;
GRANT REFERENCES ON TABLE public.cvent_events TO authenticated;
GRANT SELECT ON TABLE public.cvent_events TO authenticated;
GRANT TRIGGER ON TABLE public.cvent_events TO authenticated;
GRANT TRUNCATE ON TABLE public.cvent_events TO authenticated;
GRANT UPDATE ON TABLE public.cvent_events TO authenticated;
GRANT DELETE ON TABLE public.cvent_order_items TO authenticated;
GRANT INSERT ON TABLE public.cvent_order_items TO authenticated;
GRANT REFERENCES ON TABLE public.cvent_order_items TO authenticated;
GRANT SELECT ON TABLE public.cvent_order_items TO authenticated;
GRANT TRIGGER ON TABLE public.cvent_order_items TO authenticated;
GRANT TRUNCATE ON TABLE public.cvent_order_items TO authenticated;
GRANT UPDATE ON TABLE public.cvent_order_items TO authenticated;
GRANT DELETE ON TABLE public.cvent_orders TO authenticated;
GRANT INSERT ON TABLE public.cvent_orders TO authenticated;
GRANT REFERENCES ON TABLE public.cvent_orders TO authenticated;
GRANT SELECT ON TABLE public.cvent_orders TO authenticated;
GRANT TRIGGER ON TABLE public.cvent_orders TO authenticated;
GRANT TRUNCATE ON TABLE public.cvent_orders TO authenticated;
GRANT UPDATE ON TABLE public.cvent_orders TO authenticated;
GRANT DELETE ON TABLE public.dashboard_summaries TO authenticated;
GRANT INSERT ON TABLE public.dashboard_summaries TO authenticated;
GRANT REFERENCES ON TABLE public.dashboard_summaries TO authenticated;
GRANT SELECT ON TABLE public.dashboard_summaries TO authenticated;
GRANT TRIGGER ON TABLE public.dashboard_summaries TO authenticated;
GRANT TRUNCATE ON TABLE public.dashboard_summaries TO authenticated;
GRANT UPDATE ON TABLE public.dashboard_summaries TO authenticated;
GRANT DELETE ON TABLE public.discovered_media_urls TO authenticated;
GRANT INSERT ON TABLE public.discovered_media_urls TO authenticated;
GRANT REFERENCES ON TABLE public.discovered_media_urls TO authenticated;
GRANT SELECT ON TABLE public.discovered_media_urls TO authenticated;
GRANT TRIGGER ON TABLE public.discovered_media_urls TO authenticated;
GRANT TRUNCATE ON TABLE public.discovered_media_urls TO authenticated;
GRANT UPDATE ON TABLE public.discovered_media_urls TO authenticated;
GRANT DELETE ON TABLE public.email_conversations TO authenticated;
GRANT INSERT ON TABLE public.email_conversations TO authenticated;
GRANT REFERENCES ON TABLE public.email_conversations TO authenticated;
GRANT SELECT ON TABLE public.email_conversations TO authenticated;
GRANT TRIGGER ON TABLE public.email_conversations TO authenticated;
GRANT TRUNCATE ON TABLE public.email_conversations TO authenticated;
GRANT UPDATE ON TABLE public.email_conversations TO authenticated;
GRANT DELETE ON TABLE public.email_sequences TO authenticated;
GRANT INSERT ON TABLE public.email_sequences TO authenticated;
GRANT REFERENCES ON TABLE public.email_sequences TO authenticated;
GRANT SELECT ON TABLE public.email_sequences TO authenticated;
GRANT TRIGGER ON TABLE public.email_sequences TO authenticated;
GRANT TRUNCATE ON TABLE public.email_sequences TO authenticated;
GRANT UPDATE ON TABLE public.email_sequences TO authenticated;
GRANT DELETE ON TABLE public.enrollments TO authenticated;
GRANT INSERT ON TABLE public.enrollments TO authenticated;
GRANT REFERENCES ON TABLE public.enrollments TO authenticated;
GRANT SELECT ON TABLE public.enrollments TO authenticated;
GRANT TRIGGER ON TABLE public.enrollments TO authenticated;
GRANT TRUNCATE ON TABLE public.enrollments TO authenticated;
GRANT UPDATE ON TABLE public.enrollments TO authenticated;
GRANT DELETE ON TABLE public.eval_runs TO authenticated;
GRANT INSERT ON TABLE public.eval_runs TO authenticated;
GRANT REFERENCES ON TABLE public.eval_runs TO authenticated;
GRANT SELECT ON TABLE public.eval_runs TO authenticated;
GRANT TRIGGER ON TABLE public.eval_runs TO authenticated;
GRANT TRUNCATE ON TABLE public.eval_runs TO authenticated;
GRANT UPDATE ON TABLE public.eval_runs TO authenticated;
GRANT DELETE ON TABLE public.facts_applications TO authenticated;
GRANT INSERT ON TABLE public.facts_applications TO authenticated;
GRANT REFERENCES ON TABLE public.facts_applications TO authenticated;
GRANT SELECT ON TABLE public.facts_applications TO authenticated;
GRANT TRIGGER ON TABLE public.facts_applications TO authenticated;
GRANT TRUNCATE ON TABLE public.facts_applications TO authenticated;
GRANT UPDATE ON TABLE public.facts_applications TO authenticated;
GRANT DELETE ON TABLE public.facts_inquiries TO authenticated;
GRANT INSERT ON TABLE public.facts_inquiries TO authenticated;
GRANT REFERENCES ON TABLE public.facts_inquiries TO authenticated;
GRANT SELECT ON TABLE public.facts_inquiries TO authenticated;
GRANT TRIGGER ON TABLE public.facts_inquiries TO authenticated;
GRANT TRUNCATE ON TABLE public.facts_inquiries TO authenticated;
GRANT UPDATE ON TABLE public.facts_inquiries TO authenticated;
GRANT DELETE ON TABLE public.families TO authenticated;
GRANT INSERT ON TABLE public.families TO authenticated;
GRANT REFERENCES ON TABLE public.families TO authenticated;
GRANT SELECT ON TABLE public.families TO authenticated;
GRANT TRIGGER ON TABLE public.families TO authenticated;
GRANT TRUNCATE ON TABLE public.families TO authenticated;
GRANT UPDATE ON TABLE public.families TO authenticated;
GRANT DELETE ON TABLE public.form_intake_configs TO authenticated;
GRANT INSERT ON TABLE public.form_intake_configs TO authenticated;
GRANT REFERENCES ON TABLE public.form_intake_configs TO authenticated;
GRANT SELECT ON TABLE public.form_intake_configs TO authenticated;
GRANT TRIGGER ON TABLE public.form_intake_configs TO authenticated;
GRANT TRUNCATE ON TABLE public.form_intake_configs TO authenticated;
GRANT UPDATE ON TABLE public.form_intake_configs TO authenticated;
GRANT DELETE ON TABLE public.form_submissions TO authenticated;
GRANT INSERT ON TABLE public.form_submissions TO authenticated;
GRANT REFERENCES ON TABLE public.form_submissions TO authenticated;
GRANT SELECT ON TABLE public.form_submissions TO authenticated;
GRANT TRIGGER ON TABLE public.form_submissions TO authenticated;
GRANT TRUNCATE ON TABLE public.form_submissions TO authenticated;
GRANT UPDATE ON TABLE public.form_submissions TO authenticated;
GRANT DELETE ON TABLE public.ga4_daily TO authenticated;
GRANT INSERT ON TABLE public.ga4_daily TO authenticated;
GRANT REFERENCES ON TABLE public.ga4_daily TO authenticated;
GRANT SELECT ON TABLE public.ga4_daily TO authenticated;
GRANT TRIGGER ON TABLE public.ga4_daily TO authenticated;
GRANT TRUNCATE ON TABLE public.ga4_daily TO authenticated;
GRANT UPDATE ON TABLE public.ga4_daily TO authenticated;
GRANT DELETE ON TABLE public.ga4_integrations TO authenticated;
GRANT INSERT ON TABLE public.ga4_integrations TO authenticated;
GRANT REFERENCES ON TABLE public.ga4_integrations TO authenticated;
GRANT SELECT ON TABLE public.ga4_integrations TO authenticated;
GRANT TRIGGER ON TABLE public.ga4_integrations TO authenticated;
GRANT TRUNCATE ON TABLE public.ga4_integrations TO authenticated;
GRANT UPDATE ON TABLE public.ga4_integrations TO authenticated;
GRANT DELETE ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT INSERT ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT REFERENCES ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT SELECT ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT TRIGGER ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT TRUNCATE ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT UPDATE ON TABLE public.ga4_key_events_daily TO authenticated;
GRANT DELETE ON TABLE public.ga4_pages_daily TO authenticated;
GRANT INSERT ON TABLE public.ga4_pages_daily TO authenticated;
GRANT REFERENCES ON TABLE public.ga4_pages_daily TO authenticated;
GRANT SELECT ON TABLE public.ga4_pages_daily TO authenticated;
GRANT TRIGGER ON TABLE public.ga4_pages_daily TO authenticated;
GRANT TRUNCATE ON TABLE public.ga4_pages_daily TO authenticated;
GRANT UPDATE ON TABLE public.ga4_pages_daily TO authenticated;
GRANT DELETE ON TABLE public.gmail_integrations TO authenticated;
GRANT INSERT ON TABLE public.gmail_integrations TO authenticated;
GRANT REFERENCES ON TABLE public.gmail_integrations TO authenticated;
GRANT SELECT ON TABLE public.gmail_integrations TO authenticated;
GRANT TRIGGER ON TABLE public.gmail_integrations TO authenticated;
GRANT TRUNCATE ON TABLE public.gmail_integrations TO authenticated;
GRANT UPDATE ON TABLE public.gmail_integrations TO authenticated;
GRANT DELETE ON TABLE public.gmail_messages TO authenticated;
GRANT INSERT ON TABLE public.gmail_messages TO authenticated;
GRANT REFERENCES ON TABLE public.gmail_messages TO authenticated;
GRANT SELECT ON TABLE public.gmail_messages TO authenticated;
GRANT TRIGGER ON TABLE public.gmail_messages TO authenticated;
GRANT TRUNCATE ON TABLE public.gmail_messages TO authenticated;
GRANT UPDATE ON TABLE public.gmail_messages TO authenticated;
GRANT DELETE ON TABLE public.gmail_threads TO authenticated;
GRANT INSERT ON TABLE public.gmail_threads TO authenticated;
GRANT REFERENCES ON TABLE public.gmail_threads TO authenticated;
GRANT SELECT ON TABLE public.gmail_threads TO authenticated;
GRANT TRIGGER ON TABLE public.gmail_threads TO authenticated;
GRANT TRUNCATE ON TABLE public.gmail_threads TO authenticated;
GRANT UPDATE ON TABLE public.gmail_threads TO authenticated;
GRANT DELETE ON TABLE public.google_ads_campaigns TO authenticated;
GRANT INSERT ON TABLE public.google_ads_campaigns TO authenticated;
GRANT REFERENCES ON TABLE public.google_ads_campaigns TO authenticated;
GRANT SELECT ON TABLE public.google_ads_campaigns TO authenticated;
GRANT TRIGGER ON TABLE public.google_ads_campaigns TO authenticated;
GRANT TRUNCATE ON TABLE public.google_ads_campaigns TO authenticated;
GRANT UPDATE ON TABLE public.google_ads_campaigns TO authenticated;
GRANT DELETE ON TABLE public.google_ads_integrations TO authenticated;
GRANT INSERT ON TABLE public.google_ads_integrations TO authenticated;
GRANT REFERENCES ON TABLE public.google_ads_integrations TO authenticated;
GRANT SELECT ON TABLE public.google_ads_integrations TO authenticated;
GRANT TRIGGER ON TABLE public.google_ads_integrations TO authenticated;
GRANT TRUNCATE ON TABLE public.google_ads_integrations TO authenticated;
GRANT UPDATE ON TABLE public.google_ads_integrations TO authenticated;
GRANT DELETE ON TABLE public.industry_links TO authenticated;
GRANT INSERT ON TABLE public.industry_links TO authenticated;
GRANT REFERENCES ON TABLE public.industry_links TO authenticated;
GRANT SELECT ON TABLE public.industry_links TO authenticated;
GRANT TRIGGER ON TABLE public.industry_links TO authenticated;
GRANT TRUNCATE ON TABLE public.industry_links TO authenticated;
GRANT UPDATE ON TABLE public.industry_links TO authenticated;
GRANT DELETE ON TABLE public.invite_tokens TO authenticated;
GRANT INSERT ON TABLE public.invite_tokens TO authenticated;
GRANT REFERENCES ON TABLE public.invite_tokens TO authenticated;
GRANT SELECT ON TABLE public.invite_tokens TO authenticated;
GRANT TRIGGER ON TABLE public.invite_tokens TO authenticated;
GRANT TRUNCATE ON TABLE public.invite_tokens TO authenticated;
GRANT UPDATE ON TABLE public.invite_tokens TO authenticated;
GRANT DELETE ON TABLE public.knowledge_bases TO authenticated;
GRANT INSERT ON TABLE public.knowledge_bases TO authenticated;
GRANT REFERENCES ON TABLE public.knowledge_bases TO authenticated;
GRANT SELECT ON TABLE public.knowledge_bases TO authenticated;
GRANT TRIGGER ON TABLE public.knowledge_bases TO authenticated;
GRANT TRUNCATE ON TABLE public.knowledge_bases TO authenticated;
GRANT UPDATE ON TABLE public.knowledge_bases TO authenticated;
GRANT DELETE ON TABLE public.legal_firms TO authenticated;
GRANT INSERT ON TABLE public.legal_firms TO authenticated;
GRANT REFERENCES ON TABLE public.legal_firms TO authenticated;
GRANT SELECT ON TABLE public.legal_firms TO authenticated;
GRANT TRIGGER ON TABLE public.legal_firms TO authenticated;
GRANT TRUNCATE ON TABLE public.legal_firms TO authenticated;
GRANT UPDATE ON TABLE public.legal_firms TO authenticated;
GRANT DELETE ON TABLE public.meta_ads_daily TO authenticated;
GRANT INSERT ON TABLE public.meta_ads_daily TO authenticated;
GRANT REFERENCES ON TABLE public.meta_ads_daily TO authenticated;
GRANT SELECT ON TABLE public.meta_ads_daily TO authenticated;
GRANT TRIGGER ON TABLE public.meta_ads_daily TO authenticated;
GRANT TRUNCATE ON TABLE public.meta_ads_daily TO authenticated;
GRANT UPDATE ON TABLE public.meta_ads_daily TO authenticated;
GRANT DELETE ON TABLE public.meta_ig_daily TO authenticated;
GRANT INSERT ON TABLE public.meta_ig_daily TO authenticated;
GRANT REFERENCES ON TABLE public.meta_ig_daily TO authenticated;
GRANT SELECT ON TABLE public.meta_ig_daily TO authenticated;
GRANT TRIGGER ON TABLE public.meta_ig_daily TO authenticated;
GRANT TRUNCATE ON TABLE public.meta_ig_daily TO authenticated;
GRANT UPDATE ON TABLE public.meta_ig_daily TO authenticated;
GRANT DELETE ON TABLE public.meta_integrations TO authenticated;
GRANT INSERT ON TABLE public.meta_integrations TO authenticated;
GRANT REFERENCES ON TABLE public.meta_integrations TO authenticated;
GRANT SELECT ON TABLE public.meta_integrations TO authenticated;
GRANT TRIGGER ON TABLE public.meta_integrations TO authenticated;
GRANT TRUNCATE ON TABLE public.meta_integrations TO authenticated;
GRANT UPDATE ON TABLE public.meta_integrations TO authenticated;
GRANT DELETE ON TABLE public.meta_page_daily TO authenticated;
GRANT INSERT ON TABLE public.meta_page_daily TO authenticated;
GRANT REFERENCES ON TABLE public.meta_page_daily TO authenticated;
GRANT SELECT ON TABLE public.meta_page_daily TO authenticated;
GRANT TRIGGER ON TABLE public.meta_page_daily TO authenticated;
GRANT TRUNCATE ON TABLE public.meta_page_daily TO authenticated;
GRANT UPDATE ON TABLE public.meta_page_daily TO authenticated;
GRANT DELETE ON TABLE public.pipeline_history TO authenticated;
GRANT INSERT ON TABLE public.pipeline_history TO authenticated;
GRANT REFERENCES ON TABLE public.pipeline_history TO authenticated;
GRANT SELECT ON TABLE public.pipeline_history TO authenticated;
GRANT TRIGGER ON TABLE public.pipeline_history TO authenticated;
GRANT TRUNCATE ON TABLE public.pipeline_history TO authenticated;
GRANT UPDATE ON TABLE public.pipeline_history TO authenticated;
GRANT DELETE ON TABLE public.pipeline_stages TO authenticated;
GRANT INSERT ON TABLE public.pipeline_stages TO authenticated;
GRANT REFERENCES ON TABLE public.pipeline_stages TO authenticated;
GRANT SELECT ON TABLE public.pipeline_stages TO authenticated;
GRANT TRIGGER ON TABLE public.pipeline_stages TO authenticated;
GRANT TRUNCATE ON TABLE public.pipeline_stages TO authenticated;
GRANT UPDATE ON TABLE public.pipeline_stages TO authenticated;
GRANT DELETE ON TABLE public.portal_invites TO authenticated;
GRANT INSERT ON TABLE public.portal_invites TO authenticated;
GRANT REFERENCES ON TABLE public.portal_invites TO authenticated;
GRANT SELECT ON TABLE public.portal_invites TO authenticated;
GRANT TRIGGER ON TABLE public.portal_invites TO authenticated;
GRANT TRUNCATE ON TABLE public.portal_invites TO authenticated;
GRANT UPDATE ON TABLE public.portal_invites TO authenticated;
GRANT DELETE ON TABLE public.portal_questions TO authenticated;
GRANT INSERT ON TABLE public.portal_questions TO authenticated;
GRANT REFERENCES ON TABLE public.portal_questions TO authenticated;
GRANT SELECT ON TABLE public.portal_questions TO authenticated;
GRANT TRIGGER ON TABLE public.portal_questions TO authenticated;
GRANT TRUNCATE ON TABLE public.portal_questions TO authenticated;
GRANT UPDATE ON TABLE public.portal_questions TO authenticated;
GRANT DELETE ON TABLE public.posts TO authenticated;
GRANT INSERT ON TABLE public.posts TO authenticated;
GRANT REFERENCES ON TABLE public.posts TO authenticated;
GRANT SELECT ON TABLE public.posts TO authenticated;
GRANT TRIGGER ON TABLE public.posts TO authenticated;
GRANT TRUNCATE ON TABLE public.posts TO authenticated;
GRANT UPDATE ON TABLE public.posts TO authenticated;
GRANT DELETE ON TABLE public.programs TO authenticated;
GRANT INSERT ON TABLE public.programs TO authenticated;
GRANT REFERENCES ON TABLE public.programs TO authenticated;
GRANT SELECT ON TABLE public.programs TO authenticated;
GRANT TRIGGER ON TABLE public.programs TO authenticated;
GRANT TRUNCATE ON TABLE public.programs TO authenticated;
GRANT UPDATE ON TABLE public.programs TO authenticated;
GRANT DELETE ON TABLE public.prospects TO authenticated;
GRANT INSERT ON TABLE public.prospects TO authenticated;
GRANT REFERENCES ON TABLE public.prospects TO authenticated;
GRANT SELECT ON TABLE public.prospects TO authenticated;
GRANT TRIGGER ON TABLE public.prospects TO authenticated;
GRANT TRUNCATE ON TABLE public.prospects TO authenticated;
GRANT UPDATE ON TABLE public.prospects TO authenticated;
GRANT DELETE ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT INSERT ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT REFERENCES ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT SELECT ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT TRIGGER ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT TRUNCATE ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT UPDATE ON TABLE public.salesforce_campaign_members TO authenticated;
GRANT DELETE ON TABLE public.salesforce_campaigns TO authenticated;
GRANT INSERT ON TABLE public.salesforce_campaigns TO authenticated;
GRANT REFERENCES ON TABLE public.salesforce_campaigns TO authenticated;
GRANT SELECT ON TABLE public.salesforce_campaigns TO authenticated;
GRANT TRIGGER ON TABLE public.salesforce_campaigns TO authenticated;
GRANT TRUNCATE ON TABLE public.salesforce_campaigns TO authenticated;
GRANT UPDATE ON TABLE public.salesforce_campaigns TO authenticated;
GRANT DELETE ON TABLE public.scheduled_emails TO authenticated;
GRANT INSERT ON TABLE public.scheduled_emails TO authenticated;
GRANT REFERENCES ON TABLE public.scheduled_emails TO authenticated;
GRANT SELECT ON TABLE public.scheduled_emails TO authenticated;
GRANT TRIGGER ON TABLE public.scheduled_emails TO authenticated;
GRANT TRUNCATE ON TABLE public.scheduled_emails TO authenticated;
GRANT UPDATE ON TABLE public.scheduled_emails TO authenticated;
GRANT DELETE ON TABLE public.school_events TO authenticated;
GRANT INSERT ON TABLE public.school_events TO authenticated;
GRANT REFERENCES ON TABLE public.school_events TO authenticated;
GRANT SELECT ON TABLE public.school_events TO authenticated;
GRANT TRIGGER ON TABLE public.school_events TO authenticated;
GRANT TRUNCATE ON TABLE public.school_events TO authenticated;
GRANT UPDATE ON TABLE public.school_events TO authenticated;
GRANT DELETE ON TABLE public.sequence_analytics TO authenticated;
GRANT INSERT ON TABLE public.sequence_analytics TO authenticated;
GRANT REFERENCES ON TABLE public.sequence_analytics TO authenticated;
GRANT SELECT ON TABLE public.sequence_analytics TO authenticated;
GRANT TRIGGER ON TABLE public.sequence_analytics TO authenticated;
GRANT TRUNCATE ON TABLE public.sequence_analytics TO authenticated;
GRANT UPDATE ON TABLE public.sequence_analytics TO authenticated;
GRANT DELETE ON TABLE public.sequence_enrollments TO authenticated;
GRANT INSERT ON TABLE public.sequence_enrollments TO authenticated;
GRANT REFERENCES ON TABLE public.sequence_enrollments TO authenticated;
GRANT SELECT ON TABLE public.sequence_enrollments TO authenticated;
GRANT TRIGGER ON TABLE public.sequence_enrollments TO authenticated;
GRANT TRUNCATE ON TABLE public.sequence_enrollments TO authenticated;
GRANT UPDATE ON TABLE public.sequence_enrollments TO authenticated;
GRANT DELETE ON TABLE public.sequence_steps TO authenticated;
GRANT INSERT ON TABLE public.sequence_steps TO authenticated;
GRANT REFERENCES ON TABLE public.sequence_steps TO authenticated;
GRANT SELECT ON TABLE public.sequence_steps TO authenticated;
GRANT TRIGGER ON TABLE public.sequence_steps TO authenticated;
GRANT TRUNCATE ON TABLE public.sequence_steps TO authenticated;
GRANT UPDATE ON TABLE public.sequence_steps TO authenticated;
GRANT DELETE ON TABLE public.service_health_checks TO authenticated;
GRANT INSERT ON TABLE public.service_health_checks TO authenticated;
GRANT REFERENCES ON TABLE public.service_health_checks TO authenticated;
GRANT SELECT ON TABLE public.service_health_checks TO authenticated;
GRANT TRIGGER ON TABLE public.service_health_checks TO authenticated;
GRANT TRUNCATE ON TABLE public.service_health_checks TO authenticated;
GRANT UPDATE ON TABLE public.service_health_checks TO authenticated;
GRANT DELETE ON TABLE public.site_404_log TO authenticated;
GRANT INSERT ON TABLE public.site_404_log TO authenticated;
GRANT REFERENCES ON TABLE public.site_404_log TO authenticated;
GRANT SELECT ON TABLE public.site_404_log TO authenticated;
GRANT TRIGGER ON TABLE public.site_404_log TO authenticated;
GRANT TRUNCATE ON TABLE public.site_404_log TO authenticated;
GRANT UPDATE ON TABLE public.site_404_log TO authenticated;
GRANT DELETE ON TABLE public.site_subscriptions TO authenticated;
GRANT INSERT ON TABLE public.site_subscriptions TO authenticated;
GRANT REFERENCES ON TABLE public.site_subscriptions TO authenticated;
GRANT SELECT ON TABLE public.site_subscriptions TO authenticated;
GRANT TRIGGER ON TABLE public.site_subscriptions TO authenticated;
GRANT TRUNCATE ON TABLE public.site_subscriptions TO authenticated;
GRANT UPDATE ON TABLE public.site_subscriptions TO authenticated;
GRANT DELETE ON TABLE public.sites TO authenticated;
GRANT INSERT ON TABLE public.sites TO authenticated;
GRANT REFERENCES ON TABLE public.sites TO authenticated;
GRANT SELECT ON TABLE public.sites TO authenticated;
GRANT TRIGGER ON TABLE public.sites TO authenticated;
GRANT TRUNCATE ON TABLE public.sites TO authenticated;
GRANT UPDATE ON TABLE public.sites TO authenticated;
GRANT DELETE ON TABLE public.sr_findings TO authenticated;
GRANT INSERT ON TABLE public.sr_findings TO authenticated;
GRANT REFERENCES ON TABLE public.sr_findings TO authenticated;
GRANT SELECT ON TABLE public.sr_findings TO authenticated;
GRANT TRIGGER ON TABLE public.sr_findings TO authenticated;
GRANT TRUNCATE ON TABLE public.sr_findings TO authenticated;
GRANT UPDATE ON TABLE public.sr_findings TO authenticated;
GRANT DELETE ON TABLE public.sr_orgs TO authenticated;
GRANT INSERT ON TABLE public.sr_orgs TO authenticated;
GRANT REFERENCES ON TABLE public.sr_orgs TO authenticated;
GRANT SELECT ON TABLE public.sr_orgs TO authenticated;
GRANT TRIGGER ON TABLE public.sr_orgs TO authenticated;
GRANT TRUNCATE ON TABLE public.sr_orgs TO authenticated;
GRANT UPDATE ON TABLE public.sr_orgs TO authenticated;
GRANT DELETE ON TABLE public.sr_outreach TO authenticated;
GRANT INSERT ON TABLE public.sr_outreach TO authenticated;
GRANT REFERENCES ON TABLE public.sr_outreach TO authenticated;
GRANT SELECT ON TABLE public.sr_outreach TO authenticated;
GRANT TRIGGER ON TABLE public.sr_outreach TO authenticated;
GRANT TRUNCATE ON TABLE public.sr_outreach TO authenticated;
GRANT UPDATE ON TABLE public.sr_outreach TO authenticated;
GRANT DELETE ON TABLE public.sr_people TO authenticated;
GRANT INSERT ON TABLE public.sr_people TO authenticated;
GRANT REFERENCES ON TABLE public.sr_people TO authenticated;
GRANT SELECT ON TABLE public.sr_people TO authenticated;
GRANT TRIGGER ON TABLE public.sr_people TO authenticated;
GRANT TRUNCATE ON TABLE public.sr_people TO authenticated;
GRANT UPDATE ON TABLE public.sr_people TO authenticated;
GRANT DELETE ON TABLE public.sr_sync_state TO authenticated;
GRANT INSERT ON TABLE public.sr_sync_state TO authenticated;
GRANT REFERENCES ON TABLE public.sr_sync_state TO authenticated;
GRANT SELECT ON TABLE public.sr_sync_state TO authenticated;
GRANT TRIGGER ON TABLE public.sr_sync_state TO authenticated;
GRANT TRUNCATE ON TABLE public.sr_sync_state TO authenticated;
GRANT UPDATE ON TABLE public.sr_sync_state TO authenticated;
GRANT DELETE ON TABLE public.sr_worklist TO authenticated;
GRANT INSERT ON TABLE public.sr_worklist TO authenticated;
GRANT REFERENCES ON TABLE public.sr_worklist TO authenticated;
GRANT SELECT ON TABLE public.sr_worklist TO authenticated;
GRANT TRIGGER ON TABLE public.sr_worklist TO authenticated;
GRANT TRUNCATE ON TABLE public.sr_worklist TO authenticated;
GRANT UPDATE ON TABLE public.sr_worklist TO authenticated;
GRANT DELETE ON TABLE public.subscriber_sessions TO authenticated;
GRANT INSERT ON TABLE public.subscriber_sessions TO authenticated;
GRANT REFERENCES ON TABLE public.subscriber_sessions TO authenticated;
GRANT SELECT ON TABLE public.subscriber_sessions TO authenticated;
GRANT TRIGGER ON TABLE public.subscriber_sessions TO authenticated;
GRANT TRUNCATE ON TABLE public.subscriber_sessions TO authenticated;
GRANT UPDATE ON TABLE public.subscriber_sessions TO authenticated;
GRANT DELETE ON TABLE public.sync_health TO authenticated;
GRANT INSERT ON TABLE public.sync_health TO authenticated;
GRANT REFERENCES ON TABLE public.sync_health TO authenticated;
GRANT SELECT ON TABLE public.sync_health TO authenticated;
GRANT TRIGGER ON TABLE public.sync_health TO authenticated;
GRANT TRUNCATE ON TABLE public.sync_health TO authenticated;
GRANT UPDATE ON TABLE public.sync_health TO authenticated;
GRANT DELETE ON TABLE public.sync_runs TO authenticated;
GRANT INSERT ON TABLE public.sync_runs TO authenticated;
GRANT REFERENCES ON TABLE public.sync_runs TO authenticated;
GRANT SELECT ON TABLE public.sync_runs TO authenticated;
GRANT TRIGGER ON TABLE public.sync_runs TO authenticated;
GRANT TRUNCATE ON TABLE public.sync_runs TO authenticated;
GRANT UPDATE ON TABLE public.sync_runs TO authenticated;
GRANT DELETE ON TABLE public.tags TO authenticated;
GRANT INSERT ON TABLE public.tags TO authenticated;
GRANT REFERENCES ON TABLE public.tags TO authenticated;
GRANT SELECT ON TABLE public.tags TO authenticated;
GRANT TRIGGER ON TABLE public.tags TO authenticated;
GRANT TRUNCATE ON TABLE public.tags TO authenticated;
GRANT UPDATE ON TABLE public.tags TO authenticated;
GRANT DELETE ON TABLE public.template_folders TO authenticated;
GRANT INSERT ON TABLE public.template_folders TO authenticated;
GRANT REFERENCES ON TABLE public.template_folders TO authenticated;
GRANT SELECT ON TABLE public.template_folders TO authenticated;
GRANT TRIGGER ON TABLE public.template_folders TO authenticated;
GRANT TRUNCATE ON TABLE public.template_folders TO authenticated;
GRANT UPDATE ON TABLE public.template_folders TO authenticated;
GRANT DELETE ON TABLE public.templates TO authenticated;
GRANT INSERT ON TABLE public.templates TO authenticated;
GRANT REFERENCES ON TABLE public.templates TO authenticated;
GRANT SELECT ON TABLE public.templates TO authenticated;
GRANT TRIGGER ON TABLE public.templates TO authenticated;
GRANT TRUNCATE ON TABLE public.templates TO authenticated;
GRANT UPDATE ON TABLE public.templates TO authenticated;
GRANT DELETE ON TABLE public.tours TO authenticated;
GRANT INSERT ON TABLE public.tours TO authenticated;
GRANT REFERENCES ON TABLE public.tours TO authenticated;
GRANT SELECT ON TABLE public.tours TO authenticated;
GRANT TRIGGER ON TABLE public.tours TO authenticated;
GRANT TRUNCATE ON TABLE public.tours TO authenticated;
GRANT UPDATE ON TABLE public.tours TO authenticated;
GRANT DELETE ON TABLE public.video_allowed_users TO authenticated;
GRANT INSERT ON TABLE public.video_allowed_users TO authenticated;
GRANT REFERENCES ON TABLE public.video_allowed_users TO authenticated;
GRANT SELECT ON TABLE public.video_allowed_users TO authenticated;
GRANT TRIGGER ON TABLE public.video_allowed_users TO authenticated;
GRANT TRUNCATE ON TABLE public.video_allowed_users TO authenticated;
GRANT UPDATE ON TABLE public.video_allowed_users TO authenticated;
GRANT DELETE ON TABLE public.video_generations TO authenticated;
GRANT INSERT ON TABLE public.video_generations TO authenticated;
GRANT REFERENCES ON TABLE public.video_generations TO authenticated;
GRANT SELECT ON TABLE public.video_generations TO authenticated;
GRANT TRIGGER ON TABLE public.video_generations TO authenticated;
GRANT TRUNCATE ON TABLE public.video_generations TO authenticated;
GRANT UPDATE ON TABLE public.video_generations TO authenticated;
GRANT DELETE ON TABLE public.visit_events TO authenticated;
GRANT INSERT ON TABLE public.visit_events TO authenticated;
GRANT REFERENCES ON TABLE public.visit_events TO authenticated;
GRANT SELECT ON TABLE public.visit_events TO authenticated;
GRANT TRIGGER ON TABLE public.visit_events TO authenticated;
GRANT TRUNCATE ON TABLE public.visit_events TO authenticated;
GRANT UPDATE ON TABLE public.visit_events TO authenticated;
GRANT DELETE ON TABLE public.woocommerce_orders TO authenticated;
GRANT INSERT ON TABLE public.woocommerce_orders TO authenticated;
GRANT REFERENCES ON TABLE public.woocommerce_orders TO authenticated;
GRANT SELECT ON TABLE public.woocommerce_orders TO authenticated;
GRANT TRIGGER ON TABLE public.woocommerce_orders TO authenticated;
GRANT TRUNCATE ON TABLE public.woocommerce_orders TO authenticated;
GRANT UPDATE ON TABLE public.woocommerce_orders TO authenticated;
GRANT SELECT ON TABLE public.cfa_page_events TO metabase_ro;
GRANT SELECT ON TABLE public.cvent_attendees TO metabase_ro;
GRANT SELECT ON TABLE public.cvent_events TO metabase_ro;
GRANT SELECT ON TABLE public.cvent_order_items TO metabase_ro;
GRANT SELECT ON TABLE public.cvent_orders TO metabase_ro;
GRANT SELECT ON TABLE public.site_404_log TO metabase_ro;
GRANT SELECT ON TABLE public.sr_findings TO metabase_ro;
GRANT SELECT ON TABLE public.sr_orgs TO metabase_ro;
GRANT SELECT ON TABLE public.sr_outreach TO metabase_ro;
GRANT SELECT ON TABLE public.sr_people TO metabase_ro;
GRANT SELECT ON TABLE public.sr_sync_state TO metabase_ro;
GRANT SELECT ON TABLE public.sr_worklist TO metabase_ro;
GRANT SELECT ON TABLE public.sync_health TO metabase_ro;
GRANT DELETE ON TABLE public.admin_users TO service_role;
GRANT INSERT ON TABLE public.admin_users TO service_role;
GRANT REFERENCES ON TABLE public.admin_users TO service_role;
GRANT SELECT ON TABLE public.admin_users TO service_role;
GRANT TRIGGER ON TABLE public.admin_users TO service_role;
GRANT TRUNCATE ON TABLE public.admin_users TO service_role;
GRANT UPDATE ON TABLE public.admin_users TO service_role;
GRANT DELETE ON TABLE public.ai_followup_analytics TO service_role;
GRANT INSERT ON TABLE public.ai_followup_analytics TO service_role;
GRANT REFERENCES ON TABLE public.ai_followup_analytics TO service_role;
GRANT SELECT ON TABLE public.ai_followup_analytics TO service_role;
GRANT TRIGGER ON TABLE public.ai_followup_analytics TO service_role;
GRANT TRUNCATE ON TABLE public.ai_followup_analytics TO service_role;
GRANT UPDATE ON TABLE public.ai_followup_analytics TO service_role;
GRANT DELETE ON TABLE public.ai_followup_config TO service_role;
GRANT INSERT ON TABLE public.ai_followup_config TO service_role;
GRANT REFERENCES ON TABLE public.ai_followup_config TO service_role;
GRANT SELECT ON TABLE public.ai_followup_config TO service_role;
GRANT TRIGGER ON TABLE public.ai_followup_config TO service_role;
GRANT TRUNCATE ON TABLE public.ai_followup_config TO service_role;
GRANT UPDATE ON TABLE public.ai_followup_config TO service_role;
GRANT DELETE ON TABLE public.ai_followup_contacts TO service_role;
GRANT INSERT ON TABLE public.ai_followup_contacts TO service_role;
GRANT REFERENCES ON TABLE public.ai_followup_contacts TO service_role;
GRANT SELECT ON TABLE public.ai_followup_contacts TO service_role;
GRANT TRIGGER ON TABLE public.ai_followup_contacts TO service_role;
GRANT TRUNCATE ON TABLE public.ai_followup_contacts TO service_role;
GRANT UPDATE ON TABLE public.ai_followup_contacts TO service_role;
GRANT DELETE ON TABLE public.ai_followup_drafts TO service_role;
GRANT INSERT ON TABLE public.ai_followup_drafts TO service_role;
GRANT REFERENCES ON TABLE public.ai_followup_drafts TO service_role;
GRANT SELECT ON TABLE public.ai_followup_drafts TO service_role;
GRANT TRIGGER ON TABLE public.ai_followup_drafts TO service_role;
GRANT TRUNCATE ON TABLE public.ai_followup_drafts TO service_role;
GRANT UPDATE ON TABLE public.ai_followup_drafts TO service_role;
GRANT DELETE ON TABLE public.analytics_events TO service_role;
GRANT INSERT ON TABLE public.analytics_events TO service_role;
GRANT REFERENCES ON TABLE public.analytics_events TO service_role;
GRANT SELECT ON TABLE public.analytics_events TO service_role;
GRANT TRIGGER ON TABLE public.analytics_events TO service_role;
GRANT TRUNCATE ON TABLE public.analytics_events TO service_role;
GRANT UPDATE ON TABLE public.analytics_events TO service_role;
GRANT DELETE ON TABLE public.applications TO service_role;
GRANT INSERT ON TABLE public.applications TO service_role;
GRANT REFERENCES ON TABLE public.applications TO service_role;
GRANT SELECT ON TABLE public.applications TO service_role;
GRANT TRIGGER ON TABLE public.applications TO service_role;
GRANT TRUNCATE ON TABLE public.applications TO service_role;
GRANT UPDATE ON TABLE public.applications TO service_role;
GRANT DELETE ON TABLE public.cairn_sessions TO service_role;
GRANT INSERT ON TABLE public.cairn_sessions TO service_role;
GRANT REFERENCES ON TABLE public.cairn_sessions TO service_role;
GRANT SELECT ON TABLE public.cairn_sessions TO service_role;
GRANT TRIGGER ON TABLE public.cairn_sessions TO service_role;
GRANT TRUNCATE ON TABLE public.cairn_sessions TO service_role;
GRANT UPDATE ON TABLE public.cairn_sessions TO service_role;
GRANT DELETE ON TABLE public.calendly_integrations TO service_role;
GRANT INSERT ON TABLE public.calendly_integrations TO service_role;
GRANT REFERENCES ON TABLE public.calendly_integrations TO service_role;
GRANT SELECT ON TABLE public.calendly_integrations TO service_role;
GRANT TRIGGER ON TABLE public.calendly_integrations TO service_role;
GRANT TRUNCATE ON TABLE public.calendly_integrations TO service_role;
GRANT UPDATE ON TABLE public.calendly_integrations TO service_role;
GRANT DELETE ON TABLE public.campaign_folders TO service_role;
GRANT INSERT ON TABLE public.campaign_folders TO service_role;
GRANT REFERENCES ON TABLE public.campaign_folders TO service_role;
GRANT SELECT ON TABLE public.campaign_folders TO service_role;
GRANT TRIGGER ON TABLE public.campaign_folders TO service_role;
GRANT TRUNCATE ON TABLE public.campaign_folders TO service_role;
GRANT UPDATE ON TABLE public.campaign_folders TO service_role;
GRANT DELETE ON TABLE public.campaigns TO service_role;
GRANT INSERT ON TABLE public.campaigns TO service_role;
GRANT REFERENCES ON TABLE public.campaigns TO service_role;
GRANT SELECT ON TABLE public.campaigns TO service_role;
GRANT TRIGGER ON TABLE public.campaigns TO service_role;
GRANT TRUNCATE ON TABLE public.campaigns TO service_role;
GRANT UPDATE ON TABLE public.campaigns TO service_role;
GRANT DELETE ON TABLE public.cc_campaigns TO service_role;
GRANT INSERT ON TABLE public.cc_campaigns TO service_role;
GRANT REFERENCES ON TABLE public.cc_campaigns TO service_role;
GRANT SELECT ON TABLE public.cc_campaigns TO service_role;
GRANT TRIGGER ON TABLE public.cc_campaigns TO service_role;
GRANT TRUNCATE ON TABLE public.cc_campaigns TO service_role;
GRANT UPDATE ON TABLE public.cc_campaigns TO service_role;
GRANT DELETE ON TABLE public.cc_contacts TO service_role;
GRANT INSERT ON TABLE public.cc_contacts TO service_role;
GRANT REFERENCES ON TABLE public.cc_contacts TO service_role;
GRANT SELECT ON TABLE public.cc_contacts TO service_role;
GRANT TRIGGER ON TABLE public.cc_contacts TO service_role;
GRANT TRUNCATE ON TABLE public.cc_contacts TO service_role;
GRANT UPDATE ON TABLE public.cc_contacts TO service_role;
GRANT DELETE ON TABLE public.cc_decline_list_members TO service_role;
GRANT INSERT ON TABLE public.cc_decline_list_members TO service_role;
GRANT REFERENCES ON TABLE public.cc_decline_list_members TO service_role;
GRANT SELECT ON TABLE public.cc_decline_list_members TO service_role;
GRANT TRIGGER ON TABLE public.cc_decline_list_members TO service_role;
GRANT TRUNCATE ON TABLE public.cc_decline_list_members TO service_role;
GRANT UPDATE ON TABLE public.cc_decline_list_members TO service_role;
GRANT DELETE ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT INSERT ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT REFERENCES ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT SELECT ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT TRIGGER ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT TRUNCATE ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT UPDATE ON TABLE public.cc_decline_sync_runs TO service_role;
GRANT DELETE ON TABLE public.cc_engagement TO service_role;
GRANT INSERT ON TABLE public.cc_engagement TO service_role;
GRANT REFERENCES ON TABLE public.cc_engagement TO service_role;
GRANT SELECT ON TABLE public.cc_engagement TO service_role;
GRANT TRIGGER ON TABLE public.cc_engagement TO service_role;
GRANT TRUNCATE ON TABLE public.cc_engagement TO service_role;
GRANT UPDATE ON TABLE public.cc_engagement TO service_role;
GRANT DELETE ON TABLE public.cc_integrations TO service_role;
GRANT INSERT ON TABLE public.cc_integrations TO service_role;
GRANT REFERENCES ON TABLE public.cc_integrations TO service_role;
GRANT SELECT ON TABLE public.cc_integrations TO service_role;
GRANT TRIGGER ON TABLE public.cc_integrations TO service_role;
GRANT TRUNCATE ON TABLE public.cc_integrations TO service_role;
GRANT UPDATE ON TABLE public.cc_integrations TO service_role;
GRANT DELETE ON TABLE public.cc_list_memberships TO service_role;
GRANT INSERT ON TABLE public.cc_list_memberships TO service_role;
GRANT REFERENCES ON TABLE public.cc_list_memberships TO service_role;
GRANT SELECT ON TABLE public.cc_list_memberships TO service_role;
GRANT TRIGGER ON TABLE public.cc_list_memberships TO service_role;
GRANT TRUNCATE ON TABLE public.cc_list_memberships TO service_role;
GRANT UPDATE ON TABLE public.cc_list_memberships TO service_role;
GRANT DELETE ON TABLE public.cc_lists TO service_role;
GRANT INSERT ON TABLE public.cc_lists TO service_role;
GRANT REFERENCES ON TABLE public.cc_lists TO service_role;
GRANT SELECT ON TABLE public.cc_lists TO service_role;
GRANT TRIGGER ON TABLE public.cc_lists TO service_role;
GRANT TRUNCATE ON TABLE public.cc_lists TO service_role;
GRANT UPDATE ON TABLE public.cc_lists TO service_role;
GRANT DELETE ON TABLE public.cfa_consolidated_people TO service_role;
GRANT INSERT ON TABLE public.cfa_consolidated_people TO service_role;
GRANT REFERENCES ON TABLE public.cfa_consolidated_people TO service_role;
GRANT SELECT ON TABLE public.cfa_consolidated_people TO service_role;
GRANT TRIGGER ON TABLE public.cfa_consolidated_people TO service_role;
GRANT TRUNCATE ON TABLE public.cfa_consolidated_people TO service_role;
GRANT UPDATE ON TABLE public.cfa_consolidated_people TO service_role;
GRANT DELETE ON TABLE public.cfa_page_events TO service_role;
GRANT INSERT ON TABLE public.cfa_page_events TO service_role;
GRANT REFERENCES ON TABLE public.cfa_page_events TO service_role;
GRANT SELECT ON TABLE public.cfa_page_events TO service_role;
GRANT TRIGGER ON TABLE public.cfa_page_events TO service_role;
GRANT TRUNCATE ON TABLE public.cfa_page_events TO service_role;
GRANT UPDATE ON TABLE public.cfa_page_events TO service_role;
GRANT DELETE ON TABLE public.clients TO service_role;
GRANT INSERT ON TABLE public.clients TO service_role;
GRANT REFERENCES ON TABLE public.clients TO service_role;
GRANT SELECT ON TABLE public.clients TO service_role;
GRANT TRIGGER ON TABLE public.clients TO service_role;
GRANT TRUNCATE ON TABLE public.clients TO service_role;
GRANT UPDATE ON TABLE public.clients TO service_role;
GRANT DELETE ON TABLE public.contact_notes TO service_role;
GRANT INSERT ON TABLE public.contact_notes TO service_role;
GRANT REFERENCES ON TABLE public.contact_notes TO service_role;
GRANT SELECT ON TABLE public.contact_notes TO service_role;
GRANT TRIGGER ON TABLE public.contact_notes TO service_role;
GRANT TRUNCATE ON TABLE public.contact_notes TO service_role;
GRANT UPDATE ON TABLE public.contact_notes TO service_role;
GRANT DELETE ON TABLE public.contact_tasks TO service_role;
GRANT INSERT ON TABLE public.contact_tasks TO service_role;
GRANT REFERENCES ON TABLE public.contact_tasks TO service_role;
GRANT SELECT ON TABLE public.contact_tasks TO service_role;
GRANT TRIGGER ON TABLE public.contact_tasks TO service_role;
GRANT TRUNCATE ON TABLE public.contact_tasks TO service_role;
GRANT UPDATE ON TABLE public.contact_tasks TO service_role;
GRANT DELETE ON TABLE public.contacts TO service_role;
GRANT INSERT ON TABLE public.contacts TO service_role;
GRANT REFERENCES ON TABLE public.contacts TO service_role;
GRANT SELECT ON TABLE public.contacts TO service_role;
GRANT TRIGGER ON TABLE public.contacts TO service_role;
GRANT TRUNCATE ON TABLE public.contacts TO service_role;
GRANT UPDATE ON TABLE public.contacts TO service_role;
GRANT DELETE ON TABLE public.cvent_attendees TO service_role;
GRANT INSERT ON TABLE public.cvent_attendees TO service_role;
GRANT REFERENCES ON TABLE public.cvent_attendees TO service_role;
GRANT SELECT ON TABLE public.cvent_attendees TO service_role;
GRANT TRIGGER ON TABLE public.cvent_attendees TO service_role;
GRANT TRUNCATE ON TABLE public.cvent_attendees TO service_role;
GRANT UPDATE ON TABLE public.cvent_attendees TO service_role;
GRANT DELETE ON TABLE public.cvent_events TO service_role;
GRANT INSERT ON TABLE public.cvent_events TO service_role;
GRANT REFERENCES ON TABLE public.cvent_events TO service_role;
GRANT SELECT ON TABLE public.cvent_events TO service_role;
GRANT TRIGGER ON TABLE public.cvent_events TO service_role;
GRANT TRUNCATE ON TABLE public.cvent_events TO service_role;
GRANT UPDATE ON TABLE public.cvent_events TO service_role;
GRANT DELETE ON TABLE public.cvent_order_items TO service_role;
GRANT INSERT ON TABLE public.cvent_order_items TO service_role;
GRANT REFERENCES ON TABLE public.cvent_order_items TO service_role;
GRANT SELECT ON TABLE public.cvent_order_items TO service_role;
GRANT TRIGGER ON TABLE public.cvent_order_items TO service_role;
GRANT TRUNCATE ON TABLE public.cvent_order_items TO service_role;
GRANT UPDATE ON TABLE public.cvent_order_items TO service_role;
GRANT DELETE ON TABLE public.cvent_orders TO service_role;
GRANT INSERT ON TABLE public.cvent_orders TO service_role;
GRANT REFERENCES ON TABLE public.cvent_orders TO service_role;
GRANT SELECT ON TABLE public.cvent_orders TO service_role;
GRANT TRIGGER ON TABLE public.cvent_orders TO service_role;
GRANT TRUNCATE ON TABLE public.cvent_orders TO service_role;
GRANT UPDATE ON TABLE public.cvent_orders TO service_role;
GRANT DELETE ON TABLE public.dashboard_summaries TO service_role;
GRANT INSERT ON TABLE public.dashboard_summaries TO service_role;
GRANT REFERENCES ON TABLE public.dashboard_summaries TO service_role;
GRANT SELECT ON TABLE public.dashboard_summaries TO service_role;
GRANT TRIGGER ON TABLE public.dashboard_summaries TO service_role;
GRANT TRUNCATE ON TABLE public.dashboard_summaries TO service_role;
GRANT UPDATE ON TABLE public.dashboard_summaries TO service_role;
GRANT DELETE ON TABLE public.discovered_media_urls TO service_role;
GRANT INSERT ON TABLE public.discovered_media_urls TO service_role;
GRANT REFERENCES ON TABLE public.discovered_media_urls TO service_role;
GRANT SELECT ON TABLE public.discovered_media_urls TO service_role;
GRANT TRIGGER ON TABLE public.discovered_media_urls TO service_role;
GRANT TRUNCATE ON TABLE public.discovered_media_urls TO service_role;
GRANT UPDATE ON TABLE public.discovered_media_urls TO service_role;
GRANT DELETE ON TABLE public.email_conversations TO service_role;
GRANT INSERT ON TABLE public.email_conversations TO service_role;
GRANT REFERENCES ON TABLE public.email_conversations TO service_role;
GRANT SELECT ON TABLE public.email_conversations TO service_role;
GRANT TRIGGER ON TABLE public.email_conversations TO service_role;
GRANT TRUNCATE ON TABLE public.email_conversations TO service_role;
GRANT UPDATE ON TABLE public.email_conversations TO service_role;
GRANT DELETE ON TABLE public.email_sequences TO service_role;
GRANT INSERT ON TABLE public.email_sequences TO service_role;
GRANT REFERENCES ON TABLE public.email_sequences TO service_role;
GRANT SELECT ON TABLE public.email_sequences TO service_role;
GRANT TRIGGER ON TABLE public.email_sequences TO service_role;
GRANT TRUNCATE ON TABLE public.email_sequences TO service_role;
GRANT UPDATE ON TABLE public.email_sequences TO service_role;
GRANT DELETE ON TABLE public.enrollments TO service_role;
GRANT INSERT ON TABLE public.enrollments TO service_role;
GRANT REFERENCES ON TABLE public.enrollments TO service_role;
GRANT SELECT ON TABLE public.enrollments TO service_role;
GRANT TRIGGER ON TABLE public.enrollments TO service_role;
GRANT TRUNCATE ON TABLE public.enrollments TO service_role;
GRANT UPDATE ON TABLE public.enrollments TO service_role;
GRANT DELETE ON TABLE public.eval_runs TO service_role;
GRANT INSERT ON TABLE public.eval_runs TO service_role;
GRANT REFERENCES ON TABLE public.eval_runs TO service_role;
GRANT SELECT ON TABLE public.eval_runs TO service_role;
GRANT TRIGGER ON TABLE public.eval_runs TO service_role;
GRANT TRUNCATE ON TABLE public.eval_runs TO service_role;
GRANT UPDATE ON TABLE public.eval_runs TO service_role;
GRANT DELETE ON TABLE public.facts_applications TO service_role;
GRANT INSERT ON TABLE public.facts_applications TO service_role;
GRANT REFERENCES ON TABLE public.facts_applications TO service_role;
GRANT SELECT ON TABLE public.facts_applications TO service_role;
GRANT TRIGGER ON TABLE public.facts_applications TO service_role;
GRANT TRUNCATE ON TABLE public.facts_applications TO service_role;
GRANT UPDATE ON TABLE public.facts_applications TO service_role;
GRANT DELETE ON TABLE public.facts_inquiries TO service_role;
GRANT INSERT ON TABLE public.facts_inquiries TO service_role;
GRANT REFERENCES ON TABLE public.facts_inquiries TO service_role;
GRANT SELECT ON TABLE public.facts_inquiries TO service_role;
GRANT TRIGGER ON TABLE public.facts_inquiries TO service_role;
GRANT TRUNCATE ON TABLE public.facts_inquiries TO service_role;
GRANT UPDATE ON TABLE public.facts_inquiries TO service_role;
GRANT DELETE ON TABLE public.families TO service_role;
GRANT INSERT ON TABLE public.families TO service_role;
GRANT REFERENCES ON TABLE public.families TO service_role;
GRANT SELECT ON TABLE public.families TO service_role;
GRANT TRIGGER ON TABLE public.families TO service_role;
GRANT TRUNCATE ON TABLE public.families TO service_role;
GRANT UPDATE ON TABLE public.families TO service_role;
GRANT DELETE ON TABLE public.form_intake_configs TO service_role;
GRANT INSERT ON TABLE public.form_intake_configs TO service_role;
GRANT REFERENCES ON TABLE public.form_intake_configs TO service_role;
GRANT SELECT ON TABLE public.form_intake_configs TO service_role;
GRANT TRIGGER ON TABLE public.form_intake_configs TO service_role;
GRANT TRUNCATE ON TABLE public.form_intake_configs TO service_role;
GRANT UPDATE ON TABLE public.form_intake_configs TO service_role;
GRANT DELETE ON TABLE public.form_submissions TO service_role;
GRANT INSERT ON TABLE public.form_submissions TO service_role;
GRANT REFERENCES ON TABLE public.form_submissions TO service_role;
GRANT SELECT ON TABLE public.form_submissions TO service_role;
GRANT TRIGGER ON TABLE public.form_submissions TO service_role;
GRANT TRUNCATE ON TABLE public.form_submissions TO service_role;
GRANT UPDATE ON TABLE public.form_submissions TO service_role;
GRANT DELETE ON TABLE public.ga4_daily TO service_role;
GRANT INSERT ON TABLE public.ga4_daily TO service_role;
GRANT REFERENCES ON TABLE public.ga4_daily TO service_role;
GRANT SELECT ON TABLE public.ga4_daily TO service_role;
GRANT TRIGGER ON TABLE public.ga4_daily TO service_role;
GRANT TRUNCATE ON TABLE public.ga4_daily TO service_role;
GRANT UPDATE ON TABLE public.ga4_daily TO service_role;
GRANT DELETE ON TABLE public.ga4_integrations TO service_role;
GRANT INSERT ON TABLE public.ga4_integrations TO service_role;
GRANT REFERENCES ON TABLE public.ga4_integrations TO service_role;
GRANT SELECT ON TABLE public.ga4_integrations TO service_role;
GRANT TRIGGER ON TABLE public.ga4_integrations TO service_role;
GRANT TRUNCATE ON TABLE public.ga4_integrations TO service_role;
GRANT UPDATE ON TABLE public.ga4_integrations TO service_role;
GRANT DELETE ON TABLE public.ga4_key_events_daily TO service_role;
GRANT INSERT ON TABLE public.ga4_key_events_daily TO service_role;
GRANT REFERENCES ON TABLE public.ga4_key_events_daily TO service_role;
GRANT SELECT ON TABLE public.ga4_key_events_daily TO service_role;
GRANT TRIGGER ON TABLE public.ga4_key_events_daily TO service_role;
GRANT TRUNCATE ON TABLE public.ga4_key_events_daily TO service_role;
GRANT UPDATE ON TABLE public.ga4_key_events_daily TO service_role;
GRANT DELETE ON TABLE public.ga4_pages_daily TO service_role;
GRANT INSERT ON TABLE public.ga4_pages_daily TO service_role;
GRANT REFERENCES ON TABLE public.ga4_pages_daily TO service_role;
GRANT SELECT ON TABLE public.ga4_pages_daily TO service_role;
GRANT TRIGGER ON TABLE public.ga4_pages_daily TO service_role;
GRANT TRUNCATE ON TABLE public.ga4_pages_daily TO service_role;
GRANT UPDATE ON TABLE public.ga4_pages_daily TO service_role;
GRANT DELETE ON TABLE public.gmail_integrations TO service_role;
GRANT INSERT ON TABLE public.gmail_integrations TO service_role;
GRANT REFERENCES ON TABLE public.gmail_integrations TO service_role;
GRANT SELECT ON TABLE public.gmail_integrations TO service_role;
GRANT TRIGGER ON TABLE public.gmail_integrations TO service_role;
GRANT TRUNCATE ON TABLE public.gmail_integrations TO service_role;
GRANT UPDATE ON TABLE public.gmail_integrations TO service_role;
GRANT DELETE ON TABLE public.gmail_messages TO service_role;
GRANT INSERT ON TABLE public.gmail_messages TO service_role;
GRANT REFERENCES ON TABLE public.gmail_messages TO service_role;
GRANT SELECT ON TABLE public.gmail_messages TO service_role;
GRANT TRIGGER ON TABLE public.gmail_messages TO service_role;
GRANT TRUNCATE ON TABLE public.gmail_messages TO service_role;
GRANT UPDATE ON TABLE public.gmail_messages TO service_role;
GRANT DELETE ON TABLE public.gmail_threads TO service_role;
GRANT INSERT ON TABLE public.gmail_threads TO service_role;
GRANT REFERENCES ON TABLE public.gmail_threads TO service_role;
GRANT SELECT ON TABLE public.gmail_threads TO service_role;
GRANT TRIGGER ON TABLE public.gmail_threads TO service_role;
GRANT TRUNCATE ON TABLE public.gmail_threads TO service_role;
GRANT UPDATE ON TABLE public.gmail_threads TO service_role;
GRANT DELETE ON TABLE public.google_ads_campaigns TO service_role;
GRANT INSERT ON TABLE public.google_ads_campaigns TO service_role;
GRANT REFERENCES ON TABLE public.google_ads_campaigns TO service_role;
GRANT SELECT ON TABLE public.google_ads_campaigns TO service_role;
GRANT TRIGGER ON TABLE public.google_ads_campaigns TO service_role;
GRANT TRUNCATE ON TABLE public.google_ads_campaigns TO service_role;
GRANT UPDATE ON TABLE public.google_ads_campaigns TO service_role;
GRANT DELETE ON TABLE public.google_ads_integrations TO service_role;
GRANT INSERT ON TABLE public.google_ads_integrations TO service_role;
GRANT REFERENCES ON TABLE public.google_ads_integrations TO service_role;
GRANT SELECT ON TABLE public.google_ads_integrations TO service_role;
GRANT TRIGGER ON TABLE public.google_ads_integrations TO service_role;
GRANT TRUNCATE ON TABLE public.google_ads_integrations TO service_role;
GRANT UPDATE ON TABLE public.google_ads_integrations TO service_role;
GRANT DELETE ON TABLE public.industry_links TO service_role;
GRANT INSERT ON TABLE public.industry_links TO service_role;
GRANT REFERENCES ON TABLE public.industry_links TO service_role;
GRANT SELECT ON TABLE public.industry_links TO service_role;
GRANT TRIGGER ON TABLE public.industry_links TO service_role;
GRANT TRUNCATE ON TABLE public.industry_links TO service_role;
GRANT UPDATE ON TABLE public.industry_links TO service_role;
GRANT DELETE ON TABLE public.invite_tokens TO service_role;
GRANT INSERT ON TABLE public.invite_tokens TO service_role;
GRANT REFERENCES ON TABLE public.invite_tokens TO service_role;
GRANT SELECT ON TABLE public.invite_tokens TO service_role;
GRANT TRIGGER ON TABLE public.invite_tokens TO service_role;
GRANT TRUNCATE ON TABLE public.invite_tokens TO service_role;
GRANT UPDATE ON TABLE public.invite_tokens TO service_role;
GRANT DELETE ON TABLE public.knowledge_bases TO service_role;
GRANT INSERT ON TABLE public.knowledge_bases TO service_role;
GRANT REFERENCES ON TABLE public.knowledge_bases TO service_role;
GRANT SELECT ON TABLE public.knowledge_bases TO service_role;
GRANT TRIGGER ON TABLE public.knowledge_bases TO service_role;
GRANT TRUNCATE ON TABLE public.knowledge_bases TO service_role;
GRANT UPDATE ON TABLE public.knowledge_bases TO service_role;
GRANT DELETE ON TABLE public.legal_firms TO service_role;
GRANT INSERT ON TABLE public.legal_firms TO service_role;
GRANT REFERENCES ON TABLE public.legal_firms TO service_role;
GRANT SELECT ON TABLE public.legal_firms TO service_role;
GRANT TRIGGER ON TABLE public.legal_firms TO service_role;
GRANT TRUNCATE ON TABLE public.legal_firms TO service_role;
GRANT UPDATE ON TABLE public.legal_firms TO service_role;
GRANT DELETE ON TABLE public.meta_ads_daily TO service_role;
GRANT INSERT ON TABLE public.meta_ads_daily TO service_role;
GRANT REFERENCES ON TABLE public.meta_ads_daily TO service_role;
GRANT SELECT ON TABLE public.meta_ads_daily TO service_role;
GRANT TRIGGER ON TABLE public.meta_ads_daily TO service_role;
GRANT TRUNCATE ON TABLE public.meta_ads_daily TO service_role;
GRANT UPDATE ON TABLE public.meta_ads_daily TO service_role;
GRANT DELETE ON TABLE public.meta_ig_daily TO service_role;
GRANT INSERT ON TABLE public.meta_ig_daily TO service_role;
GRANT REFERENCES ON TABLE public.meta_ig_daily TO service_role;
GRANT SELECT ON TABLE public.meta_ig_daily TO service_role;
GRANT TRIGGER ON TABLE public.meta_ig_daily TO service_role;
GRANT TRUNCATE ON TABLE public.meta_ig_daily TO service_role;
GRANT UPDATE ON TABLE public.meta_ig_daily TO service_role;
GRANT DELETE ON TABLE public.meta_integrations TO service_role;
GRANT INSERT ON TABLE public.meta_integrations TO service_role;
GRANT REFERENCES ON TABLE public.meta_integrations TO service_role;
GRANT SELECT ON TABLE public.meta_integrations TO service_role;
GRANT TRIGGER ON TABLE public.meta_integrations TO service_role;
GRANT TRUNCATE ON TABLE public.meta_integrations TO service_role;
GRANT UPDATE ON TABLE public.meta_integrations TO service_role;
GRANT DELETE ON TABLE public.meta_page_daily TO service_role;
GRANT INSERT ON TABLE public.meta_page_daily TO service_role;
GRANT REFERENCES ON TABLE public.meta_page_daily TO service_role;
GRANT SELECT ON TABLE public.meta_page_daily TO service_role;
GRANT TRIGGER ON TABLE public.meta_page_daily TO service_role;
GRANT TRUNCATE ON TABLE public.meta_page_daily TO service_role;
GRANT UPDATE ON TABLE public.meta_page_daily TO service_role;
GRANT DELETE ON TABLE public.pipeline_history TO service_role;
GRANT INSERT ON TABLE public.pipeline_history TO service_role;
GRANT REFERENCES ON TABLE public.pipeline_history TO service_role;
GRANT SELECT ON TABLE public.pipeline_history TO service_role;
GRANT TRIGGER ON TABLE public.pipeline_history TO service_role;
GRANT TRUNCATE ON TABLE public.pipeline_history TO service_role;
GRANT UPDATE ON TABLE public.pipeline_history TO service_role;
GRANT DELETE ON TABLE public.pipeline_stages TO service_role;
GRANT INSERT ON TABLE public.pipeline_stages TO service_role;
GRANT REFERENCES ON TABLE public.pipeline_stages TO service_role;
GRANT SELECT ON TABLE public.pipeline_stages TO service_role;
GRANT TRIGGER ON TABLE public.pipeline_stages TO service_role;
GRANT TRUNCATE ON TABLE public.pipeline_stages TO service_role;
GRANT UPDATE ON TABLE public.pipeline_stages TO service_role;
GRANT DELETE ON TABLE public.portal_invites TO service_role;
GRANT INSERT ON TABLE public.portal_invites TO service_role;
GRANT REFERENCES ON TABLE public.portal_invites TO service_role;
GRANT SELECT ON TABLE public.portal_invites TO service_role;
GRANT TRIGGER ON TABLE public.portal_invites TO service_role;
GRANT TRUNCATE ON TABLE public.portal_invites TO service_role;
GRANT UPDATE ON TABLE public.portal_invites TO service_role;
GRANT DELETE ON TABLE public.portal_questions TO service_role;
GRANT INSERT ON TABLE public.portal_questions TO service_role;
GRANT REFERENCES ON TABLE public.portal_questions TO service_role;
GRANT SELECT ON TABLE public.portal_questions TO service_role;
GRANT TRIGGER ON TABLE public.portal_questions TO service_role;
GRANT TRUNCATE ON TABLE public.portal_questions TO service_role;
GRANT UPDATE ON TABLE public.portal_questions TO service_role;
GRANT DELETE ON TABLE public.posts TO service_role;
GRANT INSERT ON TABLE public.posts TO service_role;
GRANT REFERENCES ON TABLE public.posts TO service_role;
GRANT SELECT ON TABLE public.posts TO service_role;
GRANT TRIGGER ON TABLE public.posts TO service_role;
GRANT TRUNCATE ON TABLE public.posts TO service_role;
GRANT UPDATE ON TABLE public.posts TO service_role;
GRANT DELETE ON TABLE public.programs TO service_role;
GRANT INSERT ON TABLE public.programs TO service_role;
GRANT REFERENCES ON TABLE public.programs TO service_role;
GRANT SELECT ON TABLE public.programs TO service_role;
GRANT TRIGGER ON TABLE public.programs TO service_role;
GRANT TRUNCATE ON TABLE public.programs TO service_role;
GRANT UPDATE ON TABLE public.programs TO service_role;
GRANT DELETE ON TABLE public.prospects TO service_role;
GRANT INSERT ON TABLE public.prospects TO service_role;
GRANT REFERENCES ON TABLE public.prospects TO service_role;
GRANT SELECT ON TABLE public.prospects TO service_role;
GRANT TRIGGER ON TABLE public.prospects TO service_role;
GRANT TRUNCATE ON TABLE public.prospects TO service_role;
GRANT UPDATE ON TABLE public.prospects TO service_role;
GRANT DELETE ON TABLE public.reengagement_config TO service_role;
GRANT INSERT ON TABLE public.reengagement_config TO service_role;
GRANT REFERENCES ON TABLE public.reengagement_config TO service_role;
GRANT SELECT ON TABLE public.reengagement_config TO service_role;
GRANT TRIGGER ON TABLE public.reengagement_config TO service_role;
GRANT TRUNCATE ON TABLE public.reengagement_config TO service_role;
GRANT UPDATE ON TABLE public.reengagement_config TO service_role;
GRANT DELETE ON TABLE public.salesforce_campaign_members TO service_role;
GRANT INSERT ON TABLE public.salesforce_campaign_members TO service_role;
GRANT REFERENCES ON TABLE public.salesforce_campaign_members TO service_role;
GRANT SELECT ON TABLE public.salesforce_campaign_members TO service_role;
GRANT TRIGGER ON TABLE public.salesforce_campaign_members TO service_role;
GRANT TRUNCATE ON TABLE public.salesforce_campaign_members TO service_role;
GRANT UPDATE ON TABLE public.salesforce_campaign_members TO service_role;
GRANT DELETE ON TABLE public.salesforce_campaigns TO service_role;
GRANT INSERT ON TABLE public.salesforce_campaigns TO service_role;
GRANT REFERENCES ON TABLE public.salesforce_campaigns TO service_role;
GRANT SELECT ON TABLE public.salesforce_campaigns TO service_role;
GRANT TRIGGER ON TABLE public.salesforce_campaigns TO service_role;
GRANT TRUNCATE ON TABLE public.salesforce_campaigns TO service_role;
GRANT UPDATE ON TABLE public.salesforce_campaigns TO service_role;
GRANT DELETE ON TABLE public.scheduled_emails TO service_role;
GRANT INSERT ON TABLE public.scheduled_emails TO service_role;
GRANT REFERENCES ON TABLE public.scheduled_emails TO service_role;
GRANT SELECT ON TABLE public.scheduled_emails TO service_role;
GRANT TRIGGER ON TABLE public.scheduled_emails TO service_role;
GRANT TRUNCATE ON TABLE public.scheduled_emails TO service_role;
GRANT UPDATE ON TABLE public.scheduled_emails TO service_role;
GRANT DELETE ON TABLE public.school_events TO service_role;
GRANT INSERT ON TABLE public.school_events TO service_role;
GRANT REFERENCES ON TABLE public.school_events TO service_role;
GRANT SELECT ON TABLE public.school_events TO service_role;
GRANT TRIGGER ON TABLE public.school_events TO service_role;
GRANT TRUNCATE ON TABLE public.school_events TO service_role;
GRANT UPDATE ON TABLE public.school_events TO service_role;
GRANT DELETE ON TABLE public.sequence_analytics TO service_role;
GRANT INSERT ON TABLE public.sequence_analytics TO service_role;
GRANT REFERENCES ON TABLE public.sequence_analytics TO service_role;
GRANT SELECT ON TABLE public.sequence_analytics TO service_role;
GRANT TRIGGER ON TABLE public.sequence_analytics TO service_role;
GRANT TRUNCATE ON TABLE public.sequence_analytics TO service_role;
GRANT UPDATE ON TABLE public.sequence_analytics TO service_role;
GRANT DELETE ON TABLE public.sequence_enrollments TO service_role;
GRANT INSERT ON TABLE public.sequence_enrollments TO service_role;
GRANT REFERENCES ON TABLE public.sequence_enrollments TO service_role;
GRANT SELECT ON TABLE public.sequence_enrollments TO service_role;
GRANT TRIGGER ON TABLE public.sequence_enrollments TO service_role;
GRANT TRUNCATE ON TABLE public.sequence_enrollments TO service_role;
GRANT UPDATE ON TABLE public.sequence_enrollments TO service_role;
GRANT DELETE ON TABLE public.sequence_steps TO service_role;
GRANT INSERT ON TABLE public.sequence_steps TO service_role;
GRANT REFERENCES ON TABLE public.sequence_steps TO service_role;
GRANT SELECT ON TABLE public.sequence_steps TO service_role;
GRANT TRIGGER ON TABLE public.sequence_steps TO service_role;
GRANT TRUNCATE ON TABLE public.sequence_steps TO service_role;
GRANT UPDATE ON TABLE public.sequence_steps TO service_role;
GRANT DELETE ON TABLE public.service_health_checks TO service_role;
GRANT INSERT ON TABLE public.service_health_checks TO service_role;
GRANT REFERENCES ON TABLE public.service_health_checks TO service_role;
GRANT SELECT ON TABLE public.service_health_checks TO service_role;
GRANT TRIGGER ON TABLE public.service_health_checks TO service_role;
GRANT TRUNCATE ON TABLE public.service_health_checks TO service_role;
GRANT UPDATE ON TABLE public.service_health_checks TO service_role;
GRANT DELETE ON TABLE public.site_404_log TO service_role;
GRANT INSERT ON TABLE public.site_404_log TO service_role;
GRANT REFERENCES ON TABLE public.site_404_log TO service_role;
GRANT SELECT ON TABLE public.site_404_log TO service_role;
GRANT TRIGGER ON TABLE public.site_404_log TO service_role;
GRANT TRUNCATE ON TABLE public.site_404_log TO service_role;
GRANT UPDATE ON TABLE public.site_404_log TO service_role;
GRANT DELETE ON TABLE public.site_subscriptions TO service_role;
GRANT INSERT ON TABLE public.site_subscriptions TO service_role;
GRANT REFERENCES ON TABLE public.site_subscriptions TO service_role;
GRANT SELECT ON TABLE public.site_subscriptions TO service_role;
GRANT TRIGGER ON TABLE public.site_subscriptions TO service_role;
GRANT TRUNCATE ON TABLE public.site_subscriptions TO service_role;
GRANT UPDATE ON TABLE public.site_subscriptions TO service_role;
GRANT DELETE ON TABLE public.sites TO service_role;
GRANT INSERT ON TABLE public.sites TO service_role;
GRANT REFERENCES ON TABLE public.sites TO service_role;
GRANT SELECT ON TABLE public.sites TO service_role;
GRANT TRIGGER ON TABLE public.sites TO service_role;
GRANT TRUNCATE ON TABLE public.sites TO service_role;
GRANT UPDATE ON TABLE public.sites TO service_role;
GRANT DELETE ON TABLE public.sr_findings TO service_role;
GRANT INSERT ON TABLE public.sr_findings TO service_role;
GRANT REFERENCES ON TABLE public.sr_findings TO service_role;
GRANT SELECT ON TABLE public.sr_findings TO service_role;
GRANT TRIGGER ON TABLE public.sr_findings TO service_role;
GRANT TRUNCATE ON TABLE public.sr_findings TO service_role;
GRANT UPDATE ON TABLE public.sr_findings TO service_role;
GRANT DELETE ON TABLE public.sr_orgs TO service_role;
GRANT INSERT ON TABLE public.sr_orgs TO service_role;
GRANT REFERENCES ON TABLE public.sr_orgs TO service_role;
GRANT SELECT ON TABLE public.sr_orgs TO service_role;
GRANT TRIGGER ON TABLE public.sr_orgs TO service_role;
GRANT TRUNCATE ON TABLE public.sr_orgs TO service_role;
GRANT UPDATE ON TABLE public.sr_orgs TO service_role;
GRANT DELETE ON TABLE public.sr_outreach TO service_role;
GRANT INSERT ON TABLE public.sr_outreach TO service_role;
GRANT REFERENCES ON TABLE public.sr_outreach TO service_role;
GRANT SELECT ON TABLE public.sr_outreach TO service_role;
GRANT TRIGGER ON TABLE public.sr_outreach TO service_role;
GRANT TRUNCATE ON TABLE public.sr_outreach TO service_role;
GRANT UPDATE ON TABLE public.sr_outreach TO service_role;
GRANT DELETE ON TABLE public.sr_people TO service_role;
GRANT INSERT ON TABLE public.sr_people TO service_role;
GRANT REFERENCES ON TABLE public.sr_people TO service_role;
GRANT SELECT ON TABLE public.sr_people TO service_role;
GRANT TRIGGER ON TABLE public.sr_people TO service_role;
GRANT TRUNCATE ON TABLE public.sr_people TO service_role;
GRANT UPDATE ON TABLE public.sr_people TO service_role;
GRANT DELETE ON TABLE public.sr_sync_state TO service_role;
GRANT INSERT ON TABLE public.sr_sync_state TO service_role;
GRANT REFERENCES ON TABLE public.sr_sync_state TO service_role;
GRANT SELECT ON TABLE public.sr_sync_state TO service_role;
GRANT TRIGGER ON TABLE public.sr_sync_state TO service_role;
GRANT TRUNCATE ON TABLE public.sr_sync_state TO service_role;
GRANT UPDATE ON TABLE public.sr_sync_state TO service_role;
GRANT DELETE ON TABLE public.sr_worklist TO service_role;
GRANT INSERT ON TABLE public.sr_worklist TO service_role;
GRANT REFERENCES ON TABLE public.sr_worklist TO service_role;
GRANT SELECT ON TABLE public.sr_worklist TO service_role;
GRANT TRIGGER ON TABLE public.sr_worklist TO service_role;
GRANT TRUNCATE ON TABLE public.sr_worklist TO service_role;
GRANT UPDATE ON TABLE public.sr_worklist TO service_role;
GRANT DELETE ON TABLE public.subscriber_sessions TO service_role;
GRANT INSERT ON TABLE public.subscriber_sessions TO service_role;
GRANT REFERENCES ON TABLE public.subscriber_sessions TO service_role;
GRANT SELECT ON TABLE public.subscriber_sessions TO service_role;
GRANT TRIGGER ON TABLE public.subscriber_sessions TO service_role;
GRANT TRUNCATE ON TABLE public.subscriber_sessions TO service_role;
GRANT UPDATE ON TABLE public.subscriber_sessions TO service_role;
GRANT DELETE ON TABLE public.sync_health TO service_role;
GRANT INSERT ON TABLE public.sync_health TO service_role;
GRANT REFERENCES ON TABLE public.sync_health TO service_role;
GRANT SELECT ON TABLE public.sync_health TO service_role;
GRANT TRIGGER ON TABLE public.sync_health TO service_role;
GRANT TRUNCATE ON TABLE public.sync_health TO service_role;
GRANT UPDATE ON TABLE public.sync_health TO service_role;
GRANT DELETE ON TABLE public.sync_runs TO service_role;
GRANT INSERT ON TABLE public.sync_runs TO service_role;
GRANT REFERENCES ON TABLE public.sync_runs TO service_role;
GRANT SELECT ON TABLE public.sync_runs TO service_role;
GRANT TRIGGER ON TABLE public.sync_runs TO service_role;
GRANT TRUNCATE ON TABLE public.sync_runs TO service_role;
GRANT UPDATE ON TABLE public.sync_runs TO service_role;
GRANT DELETE ON TABLE public.tags TO service_role;
GRANT INSERT ON TABLE public.tags TO service_role;
GRANT REFERENCES ON TABLE public.tags TO service_role;
GRANT SELECT ON TABLE public.tags TO service_role;
GRANT TRIGGER ON TABLE public.tags TO service_role;
GRANT TRUNCATE ON TABLE public.tags TO service_role;
GRANT UPDATE ON TABLE public.tags TO service_role;
GRANT DELETE ON TABLE public.template_folders TO service_role;
GRANT INSERT ON TABLE public.template_folders TO service_role;
GRANT REFERENCES ON TABLE public.template_folders TO service_role;
GRANT SELECT ON TABLE public.template_folders TO service_role;
GRANT TRIGGER ON TABLE public.template_folders TO service_role;
GRANT TRUNCATE ON TABLE public.template_folders TO service_role;
GRANT UPDATE ON TABLE public.template_folders TO service_role;
GRANT DELETE ON TABLE public.templates TO service_role;
GRANT INSERT ON TABLE public.templates TO service_role;
GRANT REFERENCES ON TABLE public.templates TO service_role;
GRANT SELECT ON TABLE public.templates TO service_role;
GRANT TRIGGER ON TABLE public.templates TO service_role;
GRANT TRUNCATE ON TABLE public.templates TO service_role;
GRANT UPDATE ON TABLE public.templates TO service_role;
GRANT DELETE ON TABLE public.tours TO service_role;
GRANT INSERT ON TABLE public.tours TO service_role;
GRANT REFERENCES ON TABLE public.tours TO service_role;
GRANT SELECT ON TABLE public.tours TO service_role;
GRANT TRIGGER ON TABLE public.tours TO service_role;
GRANT TRUNCATE ON TABLE public.tours TO service_role;
GRANT UPDATE ON TABLE public.tours TO service_role;
GRANT DELETE ON TABLE public.video_allowed_users TO service_role;
GRANT INSERT ON TABLE public.video_allowed_users TO service_role;
GRANT REFERENCES ON TABLE public.video_allowed_users TO service_role;
GRANT SELECT ON TABLE public.video_allowed_users TO service_role;
GRANT TRIGGER ON TABLE public.video_allowed_users TO service_role;
GRANT TRUNCATE ON TABLE public.video_allowed_users TO service_role;
GRANT UPDATE ON TABLE public.video_allowed_users TO service_role;
GRANT DELETE ON TABLE public.video_generations TO service_role;
GRANT INSERT ON TABLE public.video_generations TO service_role;
GRANT REFERENCES ON TABLE public.video_generations TO service_role;
GRANT SELECT ON TABLE public.video_generations TO service_role;
GRANT TRIGGER ON TABLE public.video_generations TO service_role;
GRANT TRUNCATE ON TABLE public.video_generations TO service_role;
GRANT UPDATE ON TABLE public.video_generations TO service_role;
GRANT DELETE ON TABLE public.visit_events TO service_role;
GRANT INSERT ON TABLE public.visit_events TO service_role;
GRANT REFERENCES ON TABLE public.visit_events TO service_role;
GRANT SELECT ON TABLE public.visit_events TO service_role;
GRANT TRIGGER ON TABLE public.visit_events TO service_role;
GRANT TRUNCATE ON TABLE public.visit_events TO service_role;
GRANT UPDATE ON TABLE public.visit_events TO service_role;
GRANT DELETE ON TABLE public.woocommerce_orders TO service_role;
GRANT INSERT ON TABLE public.woocommerce_orders TO service_role;
GRANT REFERENCES ON TABLE public.woocommerce_orders TO service_role;
GRANT SELECT ON TABLE public.woocommerce_orders TO service_role;
GRANT TRIGGER ON TABLE public.woocommerce_orders TO service_role;
GRANT TRUNCATE ON TABLE public.woocommerce_orders TO service_role;
GRANT UPDATE ON TABLE public.woocommerce_orders TO service_role;
