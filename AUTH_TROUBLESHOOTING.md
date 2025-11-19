# Authentication Troubleshooting Guide

## Issue: Spinning/Loading After Login

If you're experiencing an infinite loading spinner after logging in, here's how to troubleshoot:

### Step 1: Check Browser Console

1. Open your browser's Developer Tools (F12 or right-click → Inspect)
2. Go to the **Console** tab
3. Look for error messages, particularly:
   - "Admin check failed (table may not exist)"
   - "Failed to check admin status"
   - "Auth state changed"
   - Any Supabase-related errors

### Step 2: Check Network Tab

1. In Developer Tools, go to the **Network** tab
2. Look for failed requests to Supabase
3. Check if any requests are stuck in "Pending" status
4. Look for 401 (Unauthorized) or 403 (Forbidden) errors

### Step 3: Verify Supabase Configuration

Check that your environment variables are correct:

```bash
# In .env file
VITE_SUPABASE_URL=https://ckloewflialohuvixmvd.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

### Step 4: Check Supabase Email Confirmation Settings

By default, Supabase requires email confirmation. This can cause issues:

1. Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd/auth/users
2. Check if your user has a green "confirmed" badge
3. If not confirmed, either:
   - Click on the user and manually confirm them
   - Or disable email confirmation:
     - Go to Authentication → Email Auth
     - Turn OFF "Confirm email"

### Step 5: Check Local Storage

1. In Developer Tools, go to **Application** tab (Chrome) or **Storage** tab (Firefox)
2. Look at **Local Storage** → `https://localhost:5173` (or your domain)
3. Look for Supabase session data
4. If it looks corrupted, try clearing it and logging in again

### Step 6: Apply the Admin Migration (if needed)

The admin_users table error is now handled gracefully, but you may want to apply the migration:

1. Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new
2. Copy the contents of `supabase/migrations/003_add_admin_system_fixed.sql`
3. Paste and run it

### Recent Fixes Applied

I've made several improvements to handle authentication issues:

1. **Timeout Protection** - Added 5-second timeout to admin status checks
2. **Non-blocking Admin Checks** - Admin status checks no longer block the loading state
3. **Better Error Handling** - Errors are now logged but don't crash the app
4. **Debug Logging** - Console logs show the authentication flow
5. **Timeout Warning** - After 10 seconds of loading, a helpful message appears

### Quick Test

Try this in the browser console while on the loading screen:

```javascript
// Check if Supabase client exists
console.log('Supabase URL:', import.meta.env.VITE_SUPABASE_URL)

// Check current session
const { data, error } = await supabase.auth.getSession()
console.log('Session:', data)
console.log('Error:', error)

// Check user
const { data: { user } } = await supabase.auth.getUser()
console.log('User:', user)
```

### If Nothing Works

1. Clear all browser data for localhost
2. Sign out from Supabase (if possible)
3. Refresh the page
4. Try logging in again
5. Check the console for the new debug logs

### Common Causes

1. **Email not confirmed** - Most common issue
2. **Supabase credentials incorrect** - Check .env file
3. **CORS issues** - Usually not a problem with localhost
4. **RLS policies** - Already set to allow all, so not the issue here
5. **admin_users table 500 error** - Now handled gracefully

## Still Stuck?

Share the console output (the debug logs that start with "ProtectedRoute" and "Auth state changed") and I can help debug further.
