-- Public webinar registration (sagerock.com/budget-webinar/, Sage approved 2026-11-18).
-- One row per (tenant, event, email): it is both the registrant list for reminders and
-- the reservation that makes the confirmation email send at most once.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE public.webinar_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  contact_id uuid NOT NULL REFERENCES public.contacts(id),
  event text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  school text NOT NULL,
  role text NOT NULL,
  heard_from text NOT NULL CHECK (heard_from IN ('alma','sagerock','other')),
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  confirmation_status text NOT NULL DEFAULT 'sending'
    CHECK (confirmation_status IN ('sending','sent','failed','uncertain','suppressed')),
  provider_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, event, email)
);
ALTER TABLE public.webinar_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webinar_registrations FROM anon, authenticated;
GRANT ALL ON public.webinar_registrations TO service_role;

-- Atomic, non-destructive contact merge plus registration insert. Tenant, tag and
-- consent wording are server-owned. Never changes an existing unsubscribe/bounce flag.
CREATE FUNCTION public.record_webinar_registration(
  p_event text, p_email text, p_name text, p_school text, p_role text,
  p_heard_from text, p_marketing boolean, p_attribution jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tenant constant uuid := 'dab0af79-80db-4e91-854c-be1b5ccd7288';
  c public.contacts;
  reg_id uuid;
  reg_status text;
  created boolean := false;
  tag text;
  new_tags text[];
  submitted jsonb;
  email_norm text := lower(btrim(p_email));
  first_part text;
  last_part text;
BEGIN
  IF p_event IS NULL OR p_event !~ '^[a-z0-9-]{3,60}$'
    OR email_norm IS NULL OR length(email_norm)>200 OR email_norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR coalesce(btrim(p_name),'')='' OR coalesce(btrim(p_school),'')='' OR coalesce(btrim(p_role),'')=''
    OR length(p_name)>120 OR length(p_school)>200 OR length(p_role)>120
    OR p_heard_from IS NULL OR p_heard_from NOT IN ('alma','sagerock','other') THEN
    RAISE EXCEPTION 'Invalid webinar registration';
  END IF;
  tag := 'webinar-' || p_event;
  new_tags := ARRAY[tag];
  IF p_marketing IS TRUE THEN new_tags := new_tags || ARRAY[tag || '-opt-in']; END IF;
  first_part := split_part(btrim(p_name), ' ', 1);
  last_part := nullif(btrim(substr(btrim(p_name), length(first_part)+1)), '');
  submitted := jsonb_build_object(
    'submitted_at', now(), 'source', 'website-webinar', 'event', p_event,
    'name', p_name, 'school', p_school, 'role', p_role, 'heard_from', p_heard_from,
    'marketing_opt_in', p_marketing IS TRUE,
    'consent_version', 'webinar-2026-11-18',
    'consent_text', 'Also send me occasional practical notes from SageRock. Optional; unsubscribe anytime.',
    'attribution', coalesce(p_attribution, '{}'::jsonb)
  );
  INSERT INTO public.contacts AS existing
    (client_id,email,first_name,last_name,company,job_function,tags,source_code,utm_params,form_submissions,unsubscribed)
  VALUES (tenant, email_norm, first_part, last_part, p_school, p_role, new_tags, 'website-webinar',
    nullif(coalesce(p_attribution,'{}'::jsonb), '{}'::jsonb), jsonb_build_array(submitted), NOT coalesce(p_marketing,false))
  ON CONFLICT (email,client_id) DO UPDATE SET
    first_name=coalesce(nullif(existing.first_name,''),EXCLUDED.first_name),
    last_name=coalesce(nullif(existing.last_name,''),EXCLUDED.last_name),
    company=coalesce(nullif(existing.company,''),EXCLUDED.company),
    job_function=coalesce(nullif(existing.job_function,''),EXCLUDED.job_function),
    source_code=coalesce(nullif(existing.source_code,''),EXCLUDED.source_code),
    utm_params=coalesce(existing.utm_params,EXCLUDED.utm_params),
    tags=ARRAY(SELECT DISTINCT unnest(coalesce(existing.tags,ARRAY[]::text[]) || EXCLUDED.tags)),
    form_submissions=coalesce(existing.form_submissions,'[]'::jsonb) || EXCLUDED.form_submissions,
    updated_at=now()
    -- Deliberately never updates existing unsubscribe/bounce status.
  RETURNING * INTO c;

  INSERT INTO public.webinar_registrations
    (client_id,contact_id,event,email,name,school,role,heard_from,attribution,marketing_opt_in)
  VALUES (tenant, c.id, p_event, email_norm, btrim(p_name), btrim(p_school), btrim(p_role), p_heard_from,
    coalesce(p_attribution,'{}'::jsonb), p_marketing IS TRUE)
  ON CONFLICT (client_id,event,email) DO NOTHING
  RETURNING id, confirmation_status INTO reg_id, reg_status;
  IF reg_id IS NOT NULL THEN
    created := true;
  ELSE
    SELECT id, confirmation_status INTO reg_id, reg_status FROM public.webinar_registrations
      WHERE client_id=tenant AND event=p_event AND email=email_norm;
  END IF;
  RETURN jsonb_build_object('contact_id',c.id,'registration_id',reg_id,'created',created,
    'confirmation_status',reg_status,'bounce_status',c.bounce_status);
END;
$$;
REVOKE ALL ON FUNCTION public.record_webinar_registration(text,text,text,text,text,text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_webinar_registration(text,text,text,text,text,text,boolean,jsonb) TO service_role;
COMMIT;
