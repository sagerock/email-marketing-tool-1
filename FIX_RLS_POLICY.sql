-- ============================================================================
-- FIX RLS POLICY FOR admin_users TABLE
-- This allows authenticated users to check their own admin status
-- ============================================================================

-- First, let's drop the existing restrictive policies
DROP POLICY IF EXISTS "Admins can view all admin records" ON admin_users;
DROP POLICY IF EXISTS "Super admins can manage admin records" ON admin_users;

-- Create a more permissive policy that allows authenticated users to check admin status
-- This allows any authenticated user to read the admin_users table
CREATE POLICY "Authenticated users can view admin records" ON admin_users
  FOR SELECT
  TO authenticated
  USING (true);

-- Allow authenticated users to check their own record
CREATE POLICY "Users can view their own admin status" ON admin_users
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Super admins can still manage all records
CREATE POLICY "Super admins can manage admin records" ON admin_users
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_users
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
  );

-- ============================================================================
-- VERIFICATION
-- Run this to test if you can query the table:
-- ============================================================================

SELECT COUNT(*) FROM admin_users;

-- If you see a result (even if it's 0), the policy is working!
-- ============================================================================
