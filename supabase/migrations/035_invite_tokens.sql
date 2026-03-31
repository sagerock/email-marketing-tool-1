-- Migration 035: Custom invite tokens for user onboarding
-- Replaces Supabase's built-in invite flow to avoid SendGrid click tracking consuming OTP tokens

CREATE TABLE invite_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'admin', 'client_admin')),
  client_id uuid REFERENCES clients(id),
  created_by uuid REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- RLS: only super_admins can manage invite tokens
ALTER TABLE invite_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can manage invite tokens" ON invite_tokens
  FOR ALL USING (is_super_admin());
