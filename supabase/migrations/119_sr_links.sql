-- 119_sr_links.sql
--
-- Personal outreach links (Sage, 2026-10-19). Each lawyer Sage writes to gets a
-- link like https://sagerock.com/sage?r=k7q2. The code is random and means
-- nothing on its own; sr_links maps it to a person. When the page loads, it
-- calls the `sr-link-click` edge function, which records one row in
-- sr_link_clicks, and it passes the code to GA4 as `ref_code` (custom dimension
-- registered 2026-10-19). Google never sees a name or email.
--
-- Scope decided with Sage: clicks and pages read, nothing more invasive.
-- Logged from page JavaScript, not a redirect, so mail-security scanners that
-- prefetch links (common at law firms) mostly don't count as clicks.

CREATE TABLE IF NOT EXISTS public.sr_links (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9]{4,10}$'),
  person_id   uuid REFERENCES public.sr_people(id) ON DELETE CASCADE,
  org_id      uuid REFERENCES public.sr_orgs(id) ON DELETE CASCADE,
  target_path text NOT NULL DEFAULT '/sage',
  campaign    text,                          -- e.g. 'lawyers-2026-10'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_links_person_idx ON public.sr_links (person_id);

CREATE TABLE IF NOT EXISTS public.sr_link_clicks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL REFERENCES public.sr_links(code) ON DELETE CASCADE,
  clicked_at  timestamptz NOT NULL DEFAULT now(),
  path        text,
  referrer    text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS sr_link_clicks_code_idx ON public.sr_link_clicks (code, clicked_at);

ALTER TABLE public.sr_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_link_clicks ENABLE ROW LEVEL SECURITY;
-- Staff read/write links; clicks are written only by the edge function (service role).
CREATE POLICY "Internal staff can select sr_links" ON public.sr_links FOR SELECT USING (public.is_internal_staff());
CREATE POLICY "Internal staff can insert sr_links" ON public.sr_links FOR INSERT WITH CHECK (public.is_internal_staff());
CREATE POLICY "Internal staff can update sr_links" ON public.sr_links FOR UPDATE USING (public.is_internal_staff());
CREATE POLICY "Internal staff can select sr_link_clicks" ON public.sr_link_clicks FOR SELECT USING (public.is_internal_staff());
