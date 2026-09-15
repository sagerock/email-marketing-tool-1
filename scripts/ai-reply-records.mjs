import { createHash } from 'node:crypto'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const literal = value => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('hex')}', 'hex'), 'UTF8')::jsonb`

export function validateReply(input) {
  for (const key of ['clientId', 'draftId']) {
    if (!uuid.test(input[key] || '')) throw new Error(`${key} must be a UUID`)
  }
  for (const key of ['senderEmail', 'originalMessageId', 'sourceUrl', 'receivedAt', 'body', 'recordedBy', 'outboundMessageId']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} is required`)
  }
  if (input.kind !== 'human_reply') throw new Error('Only a reviewed human_reply can be recorded; exclude auto-responses and bounces')
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(input.senderEmail)) throw new Error('Invalid senderEmail')
  if (!/^https:\/\//.test(input.sourceUrl)) throw new Error('sourceUrl must be an HTTPS evidence link')
  if (!/(Z|[+-]\d\d:\d\d)$/.test(input.receivedAt) || !Number.isFinite(Date.parse(input.receivedAt))) throw new Error('receivedAt requires an explicit time zone')
  if (Date.parse(input.receivedAt) > Date.now()) throw new Error('receivedAt cannot be in the future')
  if (input.body.length > 100000) throw new Error('Reply body is too long')
  for (const key of ['originalMessageId', 'recordedBy', 'outboundMessageId']) {
    if (/[\r\n\[\]]/.test(input[key])) throw new Error(`Invalid ${key}`)
  }
  return {
    ...input,
    senderEmail: input.senderEmail.toLowerCase(),
    receivedAt: new Date(input.receivedAt).toISOString(),
    eventId: `manual-reply:${createHash('sha256').update(`${input.clientId.toLowerCase()}\n${input.originalMessageId.trim()}`).digest('hex')}`,
  }
}

// A single transaction updates existing stores. The unique event ID makes repeat
// imports safe, including simultaneous imports of the same original response.
// No webhook invocation, mail sending, schema change, or routing change occurs.
export function replySql(input, apply = false) {
  const p = validateReply(input)
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE reply_import_result(result jsonb) ON COMMIT DROP;
DO $record_reply$
DECLARE
  p jsonb := ${literal(p)};
  d public.ai_followup_drafts%ROWTYPE;
  c public.contacts%ROWTYPE;
  existing public.ai_followup_analytics%ROWTYPE;
  event_uuid uuid;
  marker text;
  reply_body text;
BEGIN
  SELECT * INTO d FROM public.ai_followup_drafts
    WHERE id=(p->>'draftId')::uuid AND client_id=(p->>'clientId')::uuid FOR UPDATE;
  IF NOT FOUND OR d.status <> 'sent' OR d.sent_at IS NULL THEN
    RAISE EXCEPTION 'A sent draft belonging to this client is required';
  END IF;
  IF d.sendgrid_message_id IS DISTINCT FROM p->>'outboundMessageId' THEN
    RAISE EXCEPTION 'Outbound message ID does not match the selected draft';
  END IF;
  IF (p->>'receivedAt')::timestamptz < d.sent_at OR (p->>'receivedAt')::timestamptz > now() THEN
    RAISE EXCEPTION 'Reply timestamp must follow the send and cannot be in the future';
  END IF;
  SELECT * INTO c FROM public.contacts
    WHERE id=d.contact_id AND client_id=d.client_id FOR UPDATE;
  IF NOT FOUND OR lower(c.email) <> p->>'senderEmail' THEN
    RAISE EXCEPTION 'Original sender does not match the contact in this client';
  END IF;
  marker := '[recorded-reply:' || (p->>'eventId') || ']';
  reply_body := marker || E'\n[message-id:' || (p->>'originalMessageId') || E']\n[ai-draft:' || d.id ||
    E']\n[source:' || (p->>'sourceUrl') || E']\n[recorded-by:' || (p->>'recordedBy') ||
    E']\n[recorded-at:' || now() || E']\n\n' || (p->>'body');
  INSERT INTO public.ai_followup_analytics(draft_id,email,event_type,timestamp,sg_event_id)
    VALUES(d.id,c.email,'reply',(p->>'receivedAt')::timestamptz,p->>'eventId')
    ON CONFLICT (sg_event_id) DO NOTHING RETURNING id INTO event_uuid;
  IF event_uuid IS NULL THEN
    SELECT * INTO existing FROM public.ai_followup_analytics WHERE sg_event_id=p->>'eventId';
    IF existing.draft_id <> d.id OR existing.event_type <> 'reply'
       OR existing.timestamp IS DISTINCT FROM (p->>'receivedAt')::timestamptz
       OR lower(existing.email) <> lower(c.email) THEN
      RAISE EXCEPTION 'This original reply was already recorded with different attribution';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.email_conversations
      WHERE client_id=d.client_id AND contact_id=d.contact_id AND direction='inbound'
      AND starts_with(body, marker || E'\n') AND right(body,length(p->>'body')+2)=E'\n\n' || (p->>'body')) THEN
      RAISE EXCEPTION 'Recorded conversation is missing or differs; review before changing it';
    END IF;
    INSERT INTO reply_import_result VALUES(jsonb_build_object('status','already_recorded','draftId',d.id));
    RETURN;
  END IF;
  INSERT INTO public.email_conversations(client_id,contact_id,direction,subject,body,ai_generated,escalated,created_at)
    VALUES(d.client_id,d.contact_id,'inbound','Re: ' || coalesce(d.subject,'(no subject)'),reply_body,false,false,(p->>'receivedAt')::timestamptz);
  UPDATE public.contacts SET
    last_replied_at=greatest(last_replied_at,(p->>'receivedAt')::timestamptz),
    tags=CASE WHEN 'Replied'=ANY(coalesce(tags,ARRAY[]::text[])) THEN tags
      ELSE array_append(coalesce(tags,ARRAY[]::text[]),'Replied') END
    WHERE id=c.id AND client_id=d.client_id;
  UPDATE public.ai_followup_contacts SET replied=true
    WHERE id=d.followup_contact_id AND contact_id=c.id AND client_id=d.client_id;
  INSERT INTO reply_import_result VALUES(jsonb_build_object('status','recorded','draftId',d.id,'contactId',c.id,'eventId',event_uuid));
END;
$record_reply$;
SELECT result || jsonb_build_object('applied',${apply}) AS result FROM reply_import_result;
${apply ? 'COMMIT' : 'ROLLBACK'};`
}

export function reportSql({ clientId, start, end, asOf = new Date().toISOString() }) {
  if (!uuid.test(clientId || '')) throw new Error('clientId must be a UUID')
  for (const date of [start, end, asOf]) {
    if (typeof date !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Report dates require explicit time zones')
  }
  if (Date.parse(end) <= Date.parse(start)) throw new Error('end must follow start (end is exclusive)')
  if (Date.parse(asOf) < Date.parse(start) || Date.parse(asOf) > Date.now()) throw new Error('asOf must be between start and now')
  return `WITH params AS (SELECT ${literal({ clientId, start, end, asOf })} AS p), sent AS (
    SELECT d.id,d.contact_id,d.config_id FROM public.ai_followup_drafts d,params
    WHERE d.client_id=(p->>'clientId')::uuid AND d.status='sent'
      AND d.sent_at >= (p->>'start')::timestamptz AND d.sent_at < (p->>'end')::timestamptz
      AND d.sent_at <= (p->>'asOf')::timestamptz
  ), replied AS (
    SELECT DISTINCT s.id FROM sent s JOIN public.ai_followup_drafts d ON d.id=s.id
    JOIN public.ai_followup_analytics a ON a.draft_id=s.id,params
    WHERE a.event_type='reply' AND a.timestamp >= d.sent_at AND a.timestamp <= (p->>'asOf')::timestamptz
  ) SELECT CASE WHEN grouping(s.config_id)=1 THEN 'All agents' ELSE cfg.name END AS agent,
    s.config_id,count(*)::int AS sent_emails,count(DISTINCT s.contact_id)::int AS recipients,
    count(DISTINCT s.contact_id) FILTER (WHERE r.id IS NOT NULL)::int AS responders,
    round(100.0 * count(DISTINCT s.contact_id) FILTER (WHERE r.id IS NOT NULL)
      / nullif(count(DISTINCT s.contact_id),0),2) AS recorded_response_rate_percent
    FROM sent s LEFT JOIN replied r ON r.id=s.id LEFT JOIN public.ai_followup_config cfg ON cfg.id=s.config_id
    GROUP BY GROUPING SETS ((),(s.config_id,cfg.name)) ORDER BY grouping(s.config_id) DESC,agent;`
}
