-- Requested-resource delivery, isolated from newsletter/sequence enrollment.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE public.intake_guide_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  contact_id uuid NOT NULL REFERENCES public.contacts(id),
  recipient text NOT NULL,
  resource text NOT NULL,
  request_day date NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed','uncertain','suppressed')),
  provider_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, recipient, resource, request_day)
);
ALTER TABLE public.intake_guide_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intake_guide_deliveries FROM anon, authenticated;
GRANT ALL ON public.intake_guide_deliveries TO service_role;

-- Atomic, non-destructive contact merge: simultaneous requests cannot lose tags
-- or submission history. Tenant, resource and consent wording are server-owned.
CREATE FUNCTION public.record_intake_guide_request(
  p_email text, p_name text, p_company text, p_size text,
  p_marketing boolean, p_attribution jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c public.contacts;
  submitted jsonb;
  new_tags text[];
  first_part text;
  last_part text;
BEGIN
  IF p_email IS NULL OR length(p_email)>200 OR p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR coalesce(btrim(p_name),'')='' OR coalesce(btrim(p_company),'')=''
    OR length(p_name)>120 OR length(p_company)>200 THEN
    RAISE EXCEPTION 'Invalid guide request';
  END IF;
  first_part := split_part(btrim(p_name), ' ', 1);
  last_part := nullif(btrim(substr(btrim(p_name),length(first_part)+1)), '');
  new_tags := ARRAY['intake-guide-request'];
  IF p_marketing IS TRUE THEN new_tags := new_tags || ARRAY['intake-guide-opt-in']; END IF;
  submitted := jsonb_build_object(
    'submitted_at', now(), 'source', 'website-intake-guide',
    'name', p_name, 'company', p_company,
    'resource', 'law-firm-intake-guide-v6',
    'firm_size', CASE WHEN p_size IN ('1','2-5','6+') THEN p_size ELSE NULL END,
    'marketing_opt_in', p_marketing IS TRUE,
    'consent_version', 'intake-guide-2026-11-13',
    'consent_text', 'Send me occasional practical guidance and information about SageRock’s services. Optional; unsubscribe anytime.',
    'attribution', coalesce(p_attribution, '{}'::jsonb)
  );
  INSERT INTO public.contacts AS existing
    (client_id,email,first_name,last_name,company,tags,source_code,form_submissions,unsubscribed)
  VALUES ('dab0af79-80db-4e91-854c-be1b5ccd7288', lower(btrim(p_email)), first_part,
    last_part, p_company, new_tags, 'website-intake-guide', jsonb_build_array(submitted), NOT coalesce(p_marketing,false))
  ON CONFLICT (email,client_id) DO UPDATE SET
    first_name=coalesce(nullif(existing.first_name,''),EXCLUDED.first_name),
    last_name=coalesce(nullif(existing.last_name,''),EXCLUDED.last_name),
    company=coalesce(nullif(existing.company,''),EXCLUDED.company),
    source_code=coalesce(nullif(existing.source_code,''),EXCLUDED.source_code),
    tags=ARRAY(SELECT DISTINCT unnest(coalesce(existing.tags,ARRAY[]::text[]) || EXCLUDED.tags)),
    form_submissions=coalesce(existing.form_submissions,'[]'::jsonb) || EXCLUDED.form_submissions,
    updated_at=now()
    -- Deliberately never updates existing unsubscribe/bounce status.
  RETURNING * INTO c;
  RETURN jsonb_build_object('id',c.id,'email',c.email,'bounce_status',c.bounce_status);
END;
$$;
REVOKE ALL ON FUNCTION public.record_intake_guide_request(text,text,text,text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_intake_guide_request(text,text,text,text,boolean,jsonb) TO service_role;
COMMIT;
