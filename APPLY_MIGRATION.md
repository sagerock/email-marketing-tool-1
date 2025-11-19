# Apply Admin System Migration

The `admin_users` table needs to be created in your Supabase database. Here's how to apply the migration:

## Option 1: Using Supabase Dashboard (Recommended)

1. Go to https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new
2. Copy the contents of `supabase/migrations/003_add_admin_system_fixed.sql`
3. Paste it into the SQL Editor
4. Click "Run" to execute the migration

## Option 2: Using Command Line

If you have the Supabase CLI installed:

```bash
supabase db push
```

## After Applying the Migration

Once the migration is applied, you'll need to create your first admin user. Run this SQL in the Supabase SQL editor:

```sql
-- Replace 'your-email@example.com' with your actual email
INSERT INTO admin_users (user_id, email, role)
SELECT id, email, 'super_admin'
FROM auth.users
WHERE email = 'your-email@example.com';
```

This will give your account super admin privileges.

## Verifying the Migration

After applying, you can verify it worked by running:

```sql
SELECT * FROM admin_users;
```

You should see the `admin_users` table with your user record.
