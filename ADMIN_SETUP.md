# Admin System Setup

## Initial Admin Setup

After deploying the authentication system, you need to create your first admin user.

### Step 1: Run the Admin Migration

1. Go to your Supabase dashboard: https://supabase.com/dashboard/project/ckloewflialohuvixmvd
2. Navigate to **SQL Editor**
3. Run the migration file: `supabase/migrations/003_add_admin_system.sql`

### Step 2: Create Your First Super Admin

After signing up for an account, you need to manually add yourself as a super admin.

**Option A: Using Supabase SQL Editor**

1. Go to **SQL Editor** in Supabase
2. Run this query (replace with your email):

```sql
-- Get your user ID
SELECT id, email FROM auth.users WHERE email = 'your-email@example.com';

-- Insert yourself as super admin (use the ID from above)
INSERT INTO admin_users (user_id, email, role, created_by)
VALUES (
  'YOUR_USER_ID_HERE',
  'your-email@example.com',
  'super_admin',
  'YOUR_USER_ID_HERE'
);
```

**Option B: Using Supabase Table Editor**

1. Go to **Table Editor** in Supabase
2. Select `admin_users` table
3. Click **Insert** → **Insert row**
4. Fill in:
   - `user_id`: Your user ID from `auth.users` table
   - `email`: Your email address
   - `role`: `super_admin`
   - `created_by`: Your user ID (same as user_id)
5. Click **Save**

### Step 3: Refresh Your App

1. Sign out and sign back in
2. You should now see "Admin Panel" in the sidebar
3. You can now manage other admins

---

## Admin Roles Explained

### Super Admin (`super_admin`)
- **Access:** Everything
- **Can do:**
  - Manage all clients
  - Manage all contacts, campaigns, templates
  - Add/remove other admins (including other super admins)
  - Assign client admins
- **Use case:** System owner (you)

### Admin (`admin`)
- **Access:** All clients
- **Can do:**
  - Manage all clients
  - Manage all contacts, campaigns, templates
  - Cannot manage other admins
- **Use case:** Full-time staff member

### Client Admin (`client_admin`)
- **Access:** Specific client only
- **Can do:**
  - Manage assigned client's contacts, campaigns, templates
  - View only assigned client in client selector
  - Cannot access other clients
  - Cannot manage admins
- **Use case:** Client who manages their own account

---

## Adding More Admins

Once you're a super admin:

1. Ask the new admin to **sign up** at https://mail.sagerock.com/signup
2. Go to **Admin Panel** in your sidebar
3. Enter their email address
4. Select role:
   - **Super Admin** - Another system owner
   - **Admin** - Staff member with full access
   - **Client Admin** - Client-specific access
5. For Client Admin, select which client they can access
6. Click **Add Admin**

---

## Checking Your Admin Status

You can check if you're an admin by:

1. Sign in to the app
2. Check the sidebar - you should see "Admin Panel"
3. If you don't see it, you're not an admin yet
4. Follow Step 2 above to add yourself

---

## Admin Panel Features

### View All Admins
- See all users with admin access
- View their role and assigned client (if any)
- See when they were added

### Add New Admins
- Add existing users as admins
- User must sign up first
- Assign appropriate role and client access

### Remove Admins
- Remove admin access from users
- User can still sign in but won't have admin features
- Super admins can remove other super admins

### Role Management
- Super admins can change roles
- Promote/demote between admin types
- Reassign client access for client admins

---

## Future Enhancements

This system is designed to be extended:

### Potential Features
- [ ] Email notifications when added as admin
- [ ] Activity logging for admin actions
- [ ] Permission granularity (read/write/delete per resource)
- [ ] Client admin self-service (client admins can add their own team)
- [ ] Admin dashboard with system metrics
- [ ] Audit trail for all admin actions
- [ ] Two-factor authentication for admins
- [ ] Session management (force sign out)

### Database Structure
The `admin_users` table is ready for expansion:
- Add `permissions` JSONB column for granular permissions
- Add `last_login_at` for activity tracking
- Add `is_active` for soft-deleting admin access
- Add `settings` JSONB for user preferences

---

## Security Notes

1. **Super Admin Power**: Super admins can add/remove other super admins. Be careful who you give this role to.

2. **Client Isolation**: Client admins can ONLY see their assigned client. The system enforces this at the database level.

3. **RLS Policies**: Row Level Security ensures admins can only access what they're allowed to.

4. **No Self-Service**: Regular users cannot make themselves admins. It must be done by a super admin or via direct database access.

---

## Troubleshooting

### Can't see Admin Panel
- Make sure you're signed in
- Check you're in the `admin_users` table
- Try signing out and back in
- Check browser console for errors

### Can't add admins
- Make sure you're a super admin (not just admin)
- The user must have signed up first
- Check the email address is correct
- Check Supabase logs for errors

### Client admin can see wrong clients
- Check the `client_id` field in `admin_users` table
- Make sure it matches the intended client
- Client admins with NULL client_id can see all clients (shouldn't happen)

---

## Quick Reference: SQL Queries

### Check if user is admin
```sql
SELECT * FROM admin_users WHERE email = 'user@example.com';
```

### List all admins
```sql
SELECT
  au.email,
  au.role,
  c.name as client_name,
  au.created_at
FROM admin_users au
LEFT JOIN clients c ON au.client_id = c.id
ORDER BY au.created_at DESC;
```

### Make someone a super admin
```sql
UPDATE admin_users
SET role = 'super_admin', client_id = NULL
WHERE email = 'user@example.com';
```

### Remove admin access
```sql
DELETE FROM admin_users WHERE email = 'user@example.com';
```

---

**Need Help?** Check the Supabase logs and database table to debug issues.
