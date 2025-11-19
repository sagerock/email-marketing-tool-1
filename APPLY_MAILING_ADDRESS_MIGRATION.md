# Apply Mailing Address Migration

## Quick Setup

To enable the mailing address feature, you need to apply a database migration.

### Option 1: Copy & Paste SQL (2 minutes)

1. **Go to Supabase SQL Editor:**
   👉 https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new

2. **Copy and paste this SQL:**

```sql
-- Add mailing_address field to clients table for CAN-SPAM compliance
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS mailing_address TEXT;

COMMENT ON COLUMN clients.mailing_address IS 'Physical mailing address for CAN-SPAM compliance. Required in all commercial emails.';
```

3. **Click "Run"**

4. **Done!** The mailing address field is now available.

### Option 2: Use Migration File

If you have Supabase CLI installed:

```bash
supabase db push
```

This will apply `supabase/migrations/004_add_mailing_address.sql`

## After Migration

1. **Go to Settings** in your app
2. **Edit your client**
3. **Add your mailing address:**
   ```
   123 Main Street
   Suite 100
   San Francisco, CA 94105
   ```
4. **Click Update**

## Using in Templates

Add this to your email footer:

```html
<p style="font-size: 12px; color: #666;">
  <strong>{{mailing_address}}</strong><br>
  <a href="{{unsubscribe_url}}">Unsubscribe</a>
</p>
```

## Verification

After applying the migration and adding your address:

1. Create a test campaign
2. Click "Send Test"
3. Check the email you receive
4. Verify the mailing address appears correctly

The `{{mailing_address}}` tag will be replaced with your actual address!

## Why This is Required

**CAN-SPAM Act (US law)** requires:
- ✅ Physical mailing address in all commercial emails
- ✅ Working unsubscribe mechanism
- ❌ Penalties up to $46,517 per violation

**GDPR (EU law)** requires:
- ✅ Easy way to unsubscribe
- ✅ Clear sender identification

Both requirements are now built into this system!
