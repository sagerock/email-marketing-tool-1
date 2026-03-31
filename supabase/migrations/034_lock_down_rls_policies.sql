-- Migration 034: Lock down RLS policies
-- Replaces all USING(true) policies with proper role-based access control
--
-- Access model:
--   super_admin / admin: full access to all client data
--   client_admin: access only to their assigned client's data
--   unauthenticated: no access

-- ============================================================
-- 1. Helper functions (SECURITY DEFINER bypasses RLS)
-- ============================================================

-- is_super_admin() already exists from the admin_users fix

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION get_user_client_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT client_id FROM admin_users
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

-- Checks if user can access a given client_id
-- super_admin/admin can access any client
-- client_admin can only access their assigned client
CREATE OR REPLACE FUNCTION can_access_client(target_client_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
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

-- ============================================================
-- 2. Drop all existing USING(true) policies
-- ============================================================

-- Tables with client_id
DROP POLICY IF EXISTS "Allow all operations on contacts" ON contacts;
DROP POLICY IF EXISTS "Allow all operations on campaigns" ON campaigns;
DROP POLICY IF EXISTS "Allow all operations on templates" ON templates;
DROP POLICY IF EXISTS "Allow all operations on tags" ON tags;
DROP POLICY IF EXISTS "Allow all operations on campaign_folders" ON campaign_folders;
DROP POLICY IF EXISTS "Allow all operations on template_folders" ON template_folders;
DROP POLICY IF EXISTS "Allow all operations on industry_links" ON industry_links;
DROP POLICY IF EXISTS "Allow all operations on salesforce_campaigns" ON salesforce_campaigns;
DROP POLICY IF EXISTS "Allow all operations on salesforce_campaign_members" ON salesforce_campaign_members;
DROP POLICY IF EXISTS "Allow all for email_sequences" ON email_sequences;
DROP POLICY IF EXISTS "Allow all for ai_followup_config" ON ai_followup_config;
DROP POLICY IF EXISTS "Allow all for ai_followup_contacts" ON ai_followup_contacts;
DROP POLICY IF EXISTS "Allow all for ai_followup_drafts" ON ai_followup_drafts;

-- Tables without client_id
DROP POLICY IF EXISTS "Allow all operations on clients" ON clients;
DROP POLICY IF EXISTS "Allow all operations on analytics_events" ON analytics_events;
DROP POLICY IF EXISTS "Allow all for scheduled_emails" ON scheduled_emails;
DROP POLICY IF EXISTS "Allow all for sequence_enrollments" ON sequence_enrollments;
DROP POLICY IF EXISTS "Allow all for sequence_steps" ON sequence_steps;
DROP POLICY IF EXISTS "Allow all for sequence_analytics" ON sequence_analytics;

-- ============================================================
-- 3. New policies for tables WITH client_id (13 tables)
-- ============================================================

-- contacts
CREATE POLICY "Admins can select contacts" ON contacts
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert contacts" ON contacts
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update contacts" ON contacts
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete contacts" ON contacts
  FOR DELETE USING (can_access_client(client_id));

-- campaigns
CREATE POLICY "Admins can select campaigns" ON campaigns
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert campaigns" ON campaigns
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update campaigns" ON campaigns
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete campaigns" ON campaigns
  FOR DELETE USING (can_access_client(client_id));

-- templates
CREATE POLICY "Admins can select templates" ON templates
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert templates" ON templates
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update templates" ON templates
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete templates" ON templates
  FOR DELETE USING (can_access_client(client_id));

-- tags
CREATE POLICY "Admins can select tags" ON tags
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert tags" ON tags
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update tags" ON tags
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete tags" ON tags
  FOR DELETE USING (can_access_client(client_id));

-- campaign_folders
CREATE POLICY "Admins can select campaign_folders" ON campaign_folders
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert campaign_folders" ON campaign_folders
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update campaign_folders" ON campaign_folders
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete campaign_folders" ON campaign_folders
  FOR DELETE USING (can_access_client(client_id));

-- template_folders
CREATE POLICY "Admins can select template_folders" ON template_folders
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert template_folders" ON template_folders
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update template_folders" ON template_folders
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete template_folders" ON template_folders
  FOR DELETE USING (can_access_client(client_id));

-- industry_links
CREATE POLICY "Admins can select industry_links" ON industry_links
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert industry_links" ON industry_links
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update industry_links" ON industry_links
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete industry_links" ON industry_links
  FOR DELETE USING (can_access_client(client_id));

-- salesforce_campaigns
CREATE POLICY "Admins can select salesforce_campaigns" ON salesforce_campaigns
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert salesforce_campaigns" ON salesforce_campaigns
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update salesforce_campaigns" ON salesforce_campaigns
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete salesforce_campaigns" ON salesforce_campaigns
  FOR DELETE USING (can_access_client(client_id));

-- salesforce_campaign_members
CREATE POLICY "Admins can select salesforce_campaign_members" ON salesforce_campaign_members
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert salesforce_campaign_members" ON salesforce_campaign_members
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update salesforce_campaign_members" ON salesforce_campaign_members
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete salesforce_campaign_members" ON salesforce_campaign_members
  FOR DELETE USING (can_access_client(client_id));

-- email_sequences
CREATE POLICY "Admins can select email_sequences" ON email_sequences
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert email_sequences" ON email_sequences
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update email_sequences" ON email_sequences
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete email_sequences" ON email_sequences
  FOR DELETE USING (can_access_client(client_id));

-- ai_followup_config
CREATE POLICY "Admins can select ai_followup_config" ON ai_followup_config
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert ai_followup_config" ON ai_followup_config
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update ai_followup_config" ON ai_followup_config
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete ai_followup_config" ON ai_followup_config
  FOR DELETE USING (can_access_client(client_id));

-- ai_followup_contacts
CREATE POLICY "Admins can select ai_followup_contacts" ON ai_followup_contacts
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert ai_followup_contacts" ON ai_followup_contacts
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update ai_followup_contacts" ON ai_followup_contacts
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete ai_followup_contacts" ON ai_followup_contacts
  FOR DELETE USING (can_access_client(client_id));

-- ai_followup_drafts
CREATE POLICY "Admins can select ai_followup_drafts" ON ai_followup_drafts
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert ai_followup_drafts" ON ai_followup_drafts
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update ai_followup_drafts" ON ai_followup_drafts
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete ai_followup_drafts" ON ai_followup_drafts
  FOR DELETE USING (can_access_client(client_id));

-- ============================================================
-- 4. New policies for tables WITHOUT client_id
-- ============================================================

-- clients table: super_admin sees all, client_admin sees only their assigned client
CREATE POLICY "Super admins can manage all clients" ON clients
  FOR ALL USING (is_super_admin());
CREATE POLICY "Client admins can view their client" ON clients
  FOR SELECT USING (id = get_user_client_id());

-- analytics_events: scope via campaign -> campaigns.client_id
CREATE POLICY "Admins can select analytics_events" ON analytics_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.id = analytics_events.campaign_id
        AND can_access_client(c.client_id)
    )
  );
CREATE POLICY "Admins can insert analytics_events" ON analytics_events
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.id = analytics_events.campaign_id
        AND can_access_client(c.client_id)
    )
  );
CREATE POLICY "Admins can update analytics_events" ON analytics_events
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.id = analytics_events.campaign_id
        AND can_access_client(c.client_id)
    )
  );

-- sequence_steps: scope via sequence_id -> email_sequences.client_id
CREATE POLICY "Admins can select sequence_steps" ON sequence_steps
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_steps.sequence_id
        AND can_access_client(es.client_id)
    )
  );
CREATE POLICY "Admins can insert sequence_steps" ON sequence_steps
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_steps.sequence_id
        AND can_access_client(es.client_id)
    )
  );
CREATE POLICY "Admins can update sequence_steps" ON sequence_steps
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_steps.sequence_id
        AND can_access_client(es.client_id)
    )
  );
CREATE POLICY "Admins can delete sequence_steps" ON sequence_steps
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_steps.sequence_id
        AND can_access_client(es.client_id)
    )
  );

-- sequence_enrollments: scope via sequence_id -> email_sequences.client_id
CREATE POLICY "Admins can select sequence_enrollments" ON sequence_enrollments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_enrollments.sequence_id
        AND can_access_client(es.client_id)
    )
  );
CREATE POLICY "Admins can insert sequence_enrollments" ON sequence_enrollments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_enrollments.sequence_id
        AND can_access_client(es.client_id)
    )
  );
CREATE POLICY "Admins can update sequence_enrollments" ON sequence_enrollments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_enrollments.sequence_id
        AND can_access_client(es.client_id)
    )
  );

-- sequence_analytics: scope via sequence_id -> email_sequences.client_id
CREATE POLICY "Admins can select sequence_analytics" ON sequence_analytics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_analytics.sequence_id
        AND can_access_client(es.client_id)
    )
  );
CREATE POLICY "Admins can insert sequence_analytics" ON sequence_analytics
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM email_sequences es
      WHERE es.id = sequence_analytics.sequence_id
        AND can_access_client(es.client_id)
    )
  );

-- scheduled_emails: scope via contact_id -> contacts.client_id
CREATE POLICY "Admins can select scheduled_emails" ON scheduled_emails
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = scheduled_emails.contact_id
        AND can_access_client(ct.client_id)
    )
  );
CREATE POLICY "Admins can insert scheduled_emails" ON scheduled_emails
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = scheduled_emails.contact_id
        AND can_access_client(ct.client_id)
    )
  );
CREATE POLICY "Admins can update scheduled_emails" ON scheduled_emails
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = scheduled_emails.contact_id
        AND can_access_client(ct.client_id)
    )
  );

-- ============================================================
-- 5. Grant execute on helper functions to authenticated role
-- ============================================================
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_client_id() TO authenticated;
GRANT EXECUTE ON FUNCTION can_access_client(uuid) TO authenticated;
