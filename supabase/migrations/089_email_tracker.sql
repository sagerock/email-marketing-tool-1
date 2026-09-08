BEGIN;

-- Editorial planning and historical records never enter the delivery queue.
CREATE TABLE public.email_tracker_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  source_id text NOT NULL,
  source_name text NOT NULL,
  source_url text,
  source_text text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id, source_id)
);

CREATE TABLE public.email_tracker_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  stage text NOT NULL DEFAULT 'started' CHECK (stage IN ('started','drafted','waiting_approval','approved')),
  brief text NOT NULL DEFAULT '',
  planned_for date,
  approval jsonb,
  campaign_snapshot jsonb,
  archived_at timestamptz,
  is_legacy boolean NOT NULL DEFAULT false,
  import_id uuid REFERENCES public.email_tracker_imports(id),
  source_key text,
  source_period text,
  source_comment text,
  source_author text,
  source_created_at timestamptz,
  source_edited_at timestamptz,
  reported_status text,
  review_needed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_id, source_key),
  CHECK (NOT is_legacy OR import_id IS NOT NULL)
);
CREATE UNIQUE INDEX email_tracker_one_live_campaign ON public.email_tracker_items(campaign_id) WHERE NOT is_legacy;
CREATE INDEX email_tracker_client ON public.email_tracker_items(client_id, updated_at DESC);

CREATE TABLE public.email_tracker_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.email_tracker_items(id),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  kind text NOT NULL,
  actor_id uuid,
  actor_label text NOT NULL,
  note text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tracker_event_timeline ON public.email_tracker_events(item_id, occurred_at DESC);

ALTER TABLE public.email_tracker_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_tracker_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_tracker_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tracker_import_read ON public.email_tracker_imports FOR SELECT TO authenticated USING(public.can_access_client(client_id));
CREATE POLICY tracker_item_read ON public.email_tracker_items FOR SELECT TO authenticated USING(public.can_access_client(client_id));
CREATE POLICY tracker_event_read ON public.email_tracker_events FOR SELECT TO authenticated USING(public.can_access_client(client_id));
REVOKE ALL ON public.email_tracker_imports, public.email_tracker_items, public.email_tracker_events FROM anon, authenticated;
GRANT SELECT ON public.email_tracker_imports, public.email_tracker_items, public.email_tracker_events TO authenticated;
GRANT ALL ON public.email_tracker_imports, public.email_tracker_items, public.email_tracker_events TO service_role;

CREATE FUNCTION public.email_tracker_record(p_item uuid, p_kind text, p_note text DEFAULT '', p_details jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO email_tracker_events(item_id, client_id, kind, actor_id, actor_label, note, details)
  SELECT id, client_id, p_kind, auth.uid(),
    coalesce((SELECT email FROM admin_users WHERE user_id=auth.uid() LIMIT 1), 'System'),
    p_note, p_details FROM email_tracker_items WHERE id=p_item;
$$;
REVOKE ALL ON FUNCTION public.email_tracker_record(uuid,text,text,jsonb) FROM PUBLIC;

-- Capture the exact approved design, subject, sender and audience configuration.
CREATE FUNCTION public.email_tracker_snapshot(p_campaign uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('subject', c.subject, 'template_id', c.template_id,
    'html_content', coalesce(t.html_content,''), 'from_name',c.from_name,
    'from_email',c.from_email,'reply_to',c.reply_to,'filter_tags',c.filter_tags,
    'audience_filter',c.audience_filter,'salesforce_campaign_id',c.salesforce_campaign_id,
    'purchase_filter',c.purchase_filter,'bypass_safe_send',c.bypass_safe_send)
  FROM campaigns c LEFT JOIN templates t ON t.id=c.template_id AND t.client_id=c.client_id
  WHERE c.id=p_campaign;
$$;
REVOKE ALL ON FUNCTION public.email_tracker_snapshot(uuid) FROM PUBLIC;

CREATE FUNCTION public.email_tracker_change(
  p_client_id uuid, p_action text, p_item_id uuid DEFAULT NULL,
  p_value text DEFAULT NULL, p_note text DEFAULT '', p_expected_at timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v email_tracker_items; c campaigns; snapshot jsonb; linked uuid; next_date date;
BEGIN
  IF NOT coalesce(public.can_access_client(p_client_id), false) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_action='create' THEN
    INSERT INTO email_tracker_items(client_id,name,brief) VALUES(p_client_id,btrim(p_value),coalesce(p_note,'')) RETURNING * INTO v;
    PERFORM email_tracker_record(v.id,'started');
    RETURN v.id;
  END IF;
  -- Consistent lock order with campaign triggers: campaign before tracker item.
  SELECT campaign_id INTO linked FROM email_tracker_items WHERE id=p_item_id AND client_id=p_client_id;
  IF linked IS NOT NULL THEN SELECT * INTO c FROM campaigns WHERE id=linked FOR UPDATE; END IF;
  SELECT * INTO v FROM email_tracker_items WHERE id=p_item_id AND client_id=p_client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tracker item not found'; END IF;
  IF p_expected_at IS NULL OR v.updated_at IS DISTINCT FROM p_expected_at THEN
    RAISE EXCEPTION 'This email changed. Refresh and try again.';
  END IF;
  IF p_action='stage' THEN
    IF v.is_legacy THEN RAISE EXCEPTION 'Historical stages come from the source notes'; END IF;
    IF c.status IN ('scheduled','sending','sent') THEN RAISE EXCEPTION 'Manage this campaign in Campaigns before changing its preparation stage'; END IF;
    IF p_value NOT IN ('started','drafted','waiting_approval','approved') OR p_value IS NULL THEN RAISE EXCEPTION 'Invalid stage'; END IF;
    IF p_value='approved' THEN
      IF v.stage <> 'waiting_approval' THEN RAISE EXCEPTION 'Request approval first'; END IF;
      IF nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Enter the approver and approval note'; END IF;
      -- Serialize approval with template edits so a concurrent edit cannot
      -- leave approval pointing at a version that was never reviewed.
      PERFORM 1 FROM templates WHERE id=c.template_id FOR SHARE;
      snapshot := email_tracker_snapshot(v.campaign_id);
      IF snapshot IS NULL OR nullif(btrim(snapshot->>'html_content'),'') IS NULL OR nullif(btrim(snapshot->>'subject'),'') IS NULL THEN
        RAISE EXCEPTION 'Link a campaign with a subject and email design before approving';
      END IF;
      UPDATE email_tracker_items SET stage=p_value, approval=jsonb_build_object(
        'recorded_at',now(),'recorded_by',auth.uid(),'note',p_note,'snapshot',snapshot), updated_at=clock_timestamp() WHERE id=v.id;
    ELSE
      UPDATE email_tracker_items SET stage=p_value,approval=NULL,updated_at=clock_timestamp() WHERE id=v.id;
    END IF;
    PERFORM email_tracker_record(v.id,p_value,coalesce(p_note,''),jsonb_build_object('previous_stage',v.stage,'approval',CASE WHEN p_value='approved' THEN (SELECT approval FROM email_tracker_items WHERE id=v.id) ELSE NULL END));
  ELSIF p_action='note' THEN
    IF nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Enter a note'; END IF;
    UPDATE email_tracker_items SET updated_at=clock_timestamp() WHERE id=v.id;
    PERFORM email_tracker_record(v.id,'note',p_note);
  ELSIF p_action='plan' THEN
    next_date := nullif(p_value,'')::date;
    UPDATE email_tracker_items SET planned_for=next_date,updated_at=clock_timestamp() WHERE id=v.id;
    PERFORM email_tracker_record(v.id,'planned',p_note,jsonb_build_object('planned_for',next_date));
  ELSIF p_action='archive' THEN
    IF c.status IN ('scheduled','sending') AND NOT v.is_legacy THEN RAISE EXCEPTION 'Cancel the schedule in Campaigns before archiving'; END IF;
    UPDATE email_tracker_items SET archived_at=CASE WHEN p_value='restore' THEN NULL ELSE now() END,updated_at=clock_timestamp() WHERE id=v.id;
    PERFORM email_tracker_record(v.id,CASE WHEN p_value='restore' THEN 'restored' ELSE 'archived' END,p_note);
  ELSIF p_action='review' AND v.is_legacy THEN
    UPDATE email_tracker_items SET review_needed=false,updated_at=clock_timestamp() WHERE id=v.id;
    PERFORM email_tracker_record(v.id,'archive_reviewed',p_note);
  ELSIF p_action='link' THEN
    SELECT * INTO c FROM campaigns WHERE id=p_value::uuid AND client_id=p_client_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found for this client'; END IF;
    IF v.is_legacy THEN
      UPDATE email_tracker_items SET campaign_id=c.id,updated_at=clock_timestamp() WHERE id=v.id;
    ELSE
      -- A campaign already has its automatically-created tracker. Transfer the
      -- planning notes to it, retaining the original plan and all its events.
      SELECT id INTO linked FROM email_tracker_items WHERE campaign_id=c.id AND NOT is_legacy;
      IF linked IS NOT NULL AND linked<>v.id THEN
        PERFORM email_tracker_record(linked,'plan_linked',v.brief,jsonb_build_object('plan_id',v.id,'plan_name',v.name));
        UPDATE email_tracker_items SET archived_at=now(),updated_at=clock_timestamp() WHERE id=v.id;
        PERFORM email_tracker_record(v.id,'campaign_linked',p_note,jsonb_build_object('campaign_id',c.id,'tracker_id',linked));
        RETURN linked;
      END IF;
      UPDATE email_tracker_items SET campaign_id=c.id,stage='drafted',approval=NULL,updated_at=clock_timestamp() WHERE id=v.id;
    END IF;
    PERFORM email_tracker_record(v.id,'campaign_linked',p_note,jsonb_build_object('campaign_id',c.id));
  ELSE RAISE EXCEPTION 'Unknown tracker action';
  END IF;
  RETURN v.id;
END;
$$;
REVOKE ALL ON FUNCTION public.email_tracker_change(uuid,text,uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.email_tracker_change(uuid,text,uuid,text,text,timestamptz) TO authenticated;

CREATE FUNCTION public.email_tracker_campaign_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v email_tracker_items; content_changed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.client_id IS NULL THEN RETURN NEW; END IF;
    INSERT INTO email_tracker_items(client_id,campaign_id,name,stage,campaign_snapshot)
      VALUES(NEW.client_id,NEW.id,NEW.name,'drafted',jsonb_build_object('status',NEW.status,'scheduled_at',NEW.scheduled_at,'sent_at',NEW.sent_at)) RETURNING * INTO v;
    PERFORM email_tracker_record(v.id,'campaign_created','',jsonb_build_object('status',NEW.status,'scheduled_at',NEW.scheduled_at));
    RETURN NEW;
  END IF;
  SELECT * INTO v FROM email_tracker_items WHERE campaign_id=NEW.id AND NOT is_legacy FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN RAISE EXCEPTION 'A tracked campaign cannot be moved between clients'; END IF;
  content_changed := ROW(NEW.subject,NEW.template_id,NEW.from_name,NEW.from_email,NEW.reply_to,NEW.filter_tags,NEW.audience_filter,NEW.salesforce_campaign_id,NEW.purchase_filter,NEW.bypass_safe_send)
    IS DISTINCT FROM ROW(OLD.subject,OLD.template_id,OLD.from_name,OLD.from_email,OLD.reply_to,OLD.filter_tags,OLD.audience_filter,OLD.salesforce_campaign_id,OLD.purchase_filter,OLD.bypass_safe_send);
  IF content_changed AND v.approval IS NOT NULL AND OLD.status NOT IN ('sent','sending') THEN
    UPDATE email_tracker_items SET stage='drafted',approval=NULL,updated_at=clock_timestamp() WHERE id=v.id;
    IF NEW.status='scheduled' THEN NEW.status:='draft'; NEW.scheduled_at:=NULL; END IF;
    PERFORM email_tracker_record(v.id,'approval_invalidated','Subject, design, sender or audience changed. Any pending schedule was cancelled.');
  END IF;
  IF ROW(NEW.status,NEW.scheduled_at,NEW.sent_at) IS DISTINCT FROM ROW(OLD.status,OLD.scheduled_at,OLD.sent_at) THEN
    PERFORM email_tracker_record(v.id,'delivery_changed','',jsonb_build_object('previous_status',OLD.status,'status',NEW.status,'scheduled_at',NEW.scheduled_at,'sent_at',NEW.sent_at,'sent_count',NEW.sent_count,'failed_count',NEW.failed_count,'send_error',NEW.send_error));
  END IF;
  IF content_changed OR ROW(NEW.name,NEW.status,NEW.scheduled_at,NEW.sent_at,NEW.sent_count,NEW.failed_count,NEW.send_error) IS DISTINCT FROM ROW(OLD.name,OLD.status,OLD.scheduled_at,OLD.sent_at,OLD.sent_count,OLD.failed_count,OLD.send_error) THEN
    UPDATE email_tracker_items SET name=NEW.name,campaign_snapshot=jsonb_build_object('status',NEW.status,'scheduled_at',NEW.scheduled_at,'sent_at',NEW.sent_at),updated_at=clock_timestamp() WHERE id=v.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.email_tracker_campaign_sync() FROM PUBLIC;
CREATE TRIGGER email_tracker_campaign_insert AFTER INSERT ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.email_tracker_campaign_sync();
CREATE TRIGGER email_tracker_campaign_update BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.email_tracker_campaign_sync();

CREATE FUNCTION public.email_tracker_campaign_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v record;
BEGIN
  FOR v IN SELECT id FROM email_tracker_items WHERE campaign_id=OLD.id AND NOT is_legacy FOR UPDATE LOOP
    UPDATE email_tracker_items SET archived_at=now(),updated_at=clock_timestamp() WHERE id=v.id;
    PERFORM email_tracker_record(v.id,'campaign_deleted','Campaign removed; its tracker and history were archived.',
      jsonb_build_object('name',OLD.name,'subject',OLD.subject,'status',OLD.status,'scheduled_at',OLD.scheduled_at,'sent_at',OLD.sent_at,'sent_count',OLD.sent_count,'failed_count',OLD.failed_count));
  END LOOP;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.email_tracker_campaign_deleted() FROM PUBLIC;
CREATE TRIGGER email_tracker_campaign_delete BEFORE DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.email_tracker_campaign_deleted();

CREATE FUNCTION public.email_tracker_template_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v record;
BEGIN
  IF NEW.html_content IS NOT DISTINCT FROM OLD.html_content THEN RETURN NEW; END IF;
  FOR v IN SELECT c.id, i.id AS item_id FROM campaigns c JOIN email_tracker_items i ON i.campaign_id=c.id AND NOT i.is_legacy
    WHERE c.template_id=NEW.id AND c.status NOT IN ('sent','sending') AND i.approval IS NOT NULL ORDER BY c.id FOR UPDATE OF c,i
  LOOP
    UPDATE email_tracker_items SET stage='drafted',approval=NULL,updated_at=clock_timestamp() WHERE id=v.item_id;
    UPDATE campaigns SET status=CASE WHEN status='scheduled' THEN 'draft' ELSE status END,
      scheduled_at=CASE WHEN status='scheduled' THEN NULL ELSE scheduled_at END WHERE id=v.id;
    PERFORM email_tracker_record(v.item_id,'approval_invalidated','Email content changed. Any pending schedule was cancelled.');
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.email_tracker_template_changed() FROM PUBLIC;
CREATE TRIGGER email_tracker_template_update AFTER UPDATE ON public.templates FOR EACH ROW EXECUTE FUNCTION public.email_tracker_template_changed();

-- Existing deliveries are evidence; past approval dates are unknown.
INSERT INTO public.email_tracker_items(client_id,campaign_id,name,stage,created_at,campaign_snapshot)
SELECT client_id,id,name,'drafted',coalesce(created_at,now()),jsonb_build_object('status',status,'scheduled_at',scheduled_at,'sent_at',sent_at) FROM public.campaigns WHERE client_id IS NOT NULL;
INSERT INTO public.email_tracker_events(item_id,client_id,kind,actor_label,note,details)
SELECT i.id,i.client_id,'existing_campaign','System','Imported existing campaign. Earlier preparation and approval dates are unknown.',
  jsonb_build_object('created_at',c.created_at,'status',c.status,'scheduled_at',c.scheduled_at,'sent_at',c.sent_at)
FROM public.email_tracker_items i JOIN public.campaigns c ON c.id=i.campaign_id;

NOTIFY pgrst, 'reload schema';
COMMIT;
