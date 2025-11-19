-- ============================================================================
-- COPY AND PASTE THIS ENTIRE FILE INTO SUPABASE SQL EDITOR
-- Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new
-- ============================================================================

-- Clean admin system migration (no contact table modifications)

-- Drop existing objects if they exist (for re-running)
DROP TABLE IF EXISTS admin_users CASCADE;
DROP FUNCTION IF EXISTS is_admin(UUID);
DROP FUNCTION IF EXISTS is_super_admin(UUID);
DROP FUNCTION IF EXISTS has_client_access(UUID, UUID);

-- Create admin_users table to track who has admin access
CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'client_admin')),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE, -- NULL for super_admin, set for client_admin
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id),
  UNIQUE(user_id)
);

-- Index for quick lookups
CREATE INDEX idx_admin_users_user_id ON admin_users(user_id);
CREATE INDEX idx_admin_users_client_id ON admin_users(client_id);

-- Enable RLS
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Policy: Admins can view all admin records
CREATE POLICY "Admins can view all admin records" ON admin_users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM admin_users
      WHERE user_id = auth.uid()
    )
  );

-- Policy: Super admins can insert/update/delete admin records
CREATE POLICY "Super admins can manage admin records" ON admin_users
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_users
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
  );

-- Function to check if a user is an admin
CREATE OR REPLACE FUNCTION is_admin(check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users WHERE user_id = check_user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if a user is a super admin
CREATE OR REPLACE FUNCTION is_super_admin(check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users
    WHERE user_id = check_user_id AND role = 'super_admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if a user has access to a specific client
CREATE OR REPLACE FUNCTION has_client_access(check_user_id UUID, check_client_id UUID)
RETURNS BOOLEAN AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add comment explaining the roles
COMMENT ON TABLE admin_users IS 'Manages administrative access to the system. Roles: super_admin (full access), admin (all clients), client_admin (specific client only)';

-- ============================================================================
-- MIGRATION COMPLETE!
-- Now you can create your first admin user (optional):
-- ============================================================================

-- Uncomment and replace 'your-email@example.com' with your actual email:
-- INSERT INTO admin_users (user_id, email, role)
-- SELECT id, email, 'super_admin'
-- FROM auth.users
-- WHERE email = 'your-email@example.com';
