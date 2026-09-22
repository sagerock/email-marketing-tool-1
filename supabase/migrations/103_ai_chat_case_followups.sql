-- AI Chat case follow-ups (Alconox). The alconox.com AI chat writes a Closed
-- Case in Salesforce (Case_Origin_Subtype__c = 'AI Chat') whose Description is
-- the transcript. We sync those cases (IP address stripped, never stored),
-- enroll the person in a review-first AI follow-up agent, and let reviewers
-- approve or skip each draft from an email.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.salesforce_ai_chat_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  salesforce_id text NOT NULL,
  case_number text,
  subject text,
  status text,
  email text,                   -- SuppliedEmail, lowercased
  supplied_name text,
  supplied_company text,
  sf_lead_id text,
  sf_contact_id text,
  web_page text,                -- Web_Page__c
  pages text[],                 -- "Pages:" footer of the transcript
  session_id text,
  transcript text,              -- Description with the IP line removed
  visitor_messages text[],      -- only what the visitor typed (no bot answers)
  chat_at timestamptz,          -- first timestamp in the transcript
  sf_created_date timestamptz,
  sf_last_modified timestamptz,
  synced_at timestamptz DEFAULT now(),
  followup_processed_at timestamptz,
  followup_skip_reason text,
  followup_enrollment_id uuid,
  UNIQUE (client_id, salesforce_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_ai_chat_cases_pending
  ON public.salesforce_ai_chat_cases (client_id, chat_at)
  WHERE followup_processed_at IS NULL;

ALTER TABLE public.salesforce_ai_chat_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salesforce_ai_chat_cases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.salesforce_ai_chat_cases TO authenticated;
GRANT ALL ON public.salesforce_ai_chat_cases TO service_role;
DROP POLICY IF EXISTS client_read ON public.salesforce_ai_chat_cases;
CREATE POLICY client_read ON public.salesforce_ai_chat_cases
  FOR SELECT TO authenticated USING (public.can_access_client(client_id));

-- Agent-level trigger + reviewer routing.
ALTER TABLE public.ai_followup_config
  ADD COLUMN IF NOT EXISTS trigger_ai_chat boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chat_trigger_since timestamptz,
  ADD COLUMN IF NOT EXISTS review_notify_emails text;  -- comma-separated; drafts are emailed for approval

ALTER TABLE public.ai_followup_contacts
  ADD COLUMN IF NOT EXISTS source_case_id uuid
    REFERENCES public.salesforce_ai_chat_cases(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_followup_contacts_source_case
  ON public.ai_followup_contacts (source_case_id)
  WHERE source_case_id IS NOT NULL;

ALTER TABLE public.salesforce_ai_chat_cases
  ADD CONSTRAINT salesforce_ai_chat_cases_enrollment_fk
  FOREIGN KEY (followup_enrollment_id) REFERENCES public.ai_followup_contacts(id) ON DELETE SET NULL
  NOT VALID;

-- Email-based review: who acted, and when the reviewers were notified.
ALTER TABLE public.ai_followup_drafts
  ADD COLUMN IF NOT EXISTS reviewed_by_email text,
  ADD COLUMN IF NOT EXISTS review_notified_at timestamptz;

-- Alconox agent. Review-first (auto_send false), one email, inert until
-- chat_trigger_since is set. trigger_tag is deliberately a value no Salesforce
-- source code contains, so the source-code enrollment hook never matches it.
INSERT INTO public.ai_followup_config (
  client_id, name, enabled, auto_send, trigger_type, trigger_tag,
  from_email, from_name, reply_to, bcc_email,
  max_followups, followup_delays, include_resource_link, log_to_salesforce,
  trigger_ai_chat, chat_trigger_since, review_notify_emails, system_prompt
)
SELECT
  'ea7f1422-2d20-4299-85a7-c1201e953409', 'AI Chat Follow-up', true, false, 'tag', 'AI Chat (Salesforce Case)',
  'cleaning@email.alconox.com', 'Alconox', 'cleaning@alconox.com', NULL,
  1, '{0}', false, false,
  true, NULL, 'ssilverstein@alconox.com,mmodica@alconox.com,sage@sagerock.com',
$prompt$You are a warm, professional follow-up assistant for Alconox, LLC, a manufacturer of critical-cleaning detergents. You are writing ONE short email to a person who used the AI chat on Alconox's website.

=== ABSOLUTE RULE: NO TECHNICAL CONTENT ===
Never answer, restate, summarize, or hint at technical guidance. No product recommendations, no product names as suggestions, no dilutions, temperatures, times, procedures, compatibility, availability, pricing, or ordering instructions -- even if the chat covered them and even if the chat's answers were correct. Alconox's people handle all of that personally. Do not describe what the chat told them.

=== WHAT YOU ARE GIVEN ===
You may see a "Topic" made only of what the visitor typed, and the page they were on. Use it for at most ONE light, non-technical phrase about what they were looking into (for example "about cleaning your parts washer" or "about one of our products"). If the topic is unclear, skip the mention entirely. Never quote the chat.

=== TIMING ===
Never say "today", "yesterday", "earlier", "just now", or "recently". The chat may have happened days ago. "Thanks for chatting with Alconox" is enough.

=== THE EMAIL ===
- Thank them for chatting with Alconox. Use their first name if you have it; otherwise no name.
- Optional: the one light topic phrase.
- Close with the invitation: if they have any questions, they can reply to this email or use Ask Alconox at https://alconox.com/ask-alconox/ and a real Alconox specialist will help. That is the ONLY URL you may include.
- SUPER short: 40 to 70 words total, two or three plain sentences. Warm, human, not salesy. No hype, no exclamation marks. Refer to the company as "Alconox" or "Alconox, LLC" -- never "Alconox, Inc."

=== REQUIRED SIGN-OFF ===
End with exactly these lines, each on its own line, verbatim, with nothing after them:

Thank you,
The Alconox Team
cleaning@alconox.com

=== SUBJECT LINE (required) ===
A short natural phrase, then an em dash, then "Alconox, LLC", under 60 characters total. Example: "Thanks for chatting with us — Alconox, LLC". Never spammy, never all-caps, no exclamation marks.

=== OUTPUT ===
Return ONLY a JSON object: {"subject": "...", "body": "..."}. The body is plain text (no HTML). No text outside the JSON.$prompt$
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_followup_config
  WHERE client_id = 'ea7f1422-2d20-4299-85a7-c1201e953409' AND trigger_ai_chat = true
);

COMMIT;
