# Fix Vercel Environment Variables

## The Problem

You're accessing the app at **https://mail.sagerock.com** but it's not working after refresh. This is because **environment variables aren't set in Vercel**.

When you build locally, it uses the `.env` file. But Vercel doesn't have access to your `.env` file - you need to set the variables in the Vercel dashboard.

## The Solution (5 minutes)

### Step 1: Go to Vercel Dashboard

1. Go to https://vercel.com/dashboard
2. Find your project (probably "email-marketing-tool" or similar)
3. Click on it
4. Go to **Settings** → **Environment Variables**

### Step 2: Add These Environment Variables

Add each of these as a **new environment variable**:

| Name | Value | Where to Use |
|------|-------|--------------|
| `VITE_SUPABASE_URL` | `https://ckloewflialohuvixmvd.supabase.co` | Production |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0Mjg0NTIsImV4cCI6MjA3OTAwNDQ1Mn0.W3GFbdfx0a05J_OksNIQ7SngCAf-7ytcRUZUhDIgHJo` | Production |
| `VITE_API_URL` | `https://api.mail.sagerock.com` | Production |
| `BASE_URL` | `https://mail.sagerock.com` | Production |

### Step 3: Redeploy

After adding the environment variables:

1. Go to **Deployments** tab in Vercel
2. Find the latest deployment
3. Click the **...** menu
4. Click **Redeploy**
5. Wait for it to finish (usually 1-2 minutes)

### Step 4: Test

1. Go to https://mail.sagerock.com
2. Clear your browser (Cmd+Shift+Delete)
3. Login
4. Refresh the page
5. **It should work!**

## How to Verify Environment Variables

To check if environment variables are set correctly:

1. Go to https://mail.sagerock.com/debug
2. Open browser console (F12)
3. Type: `import.meta.env`
4. Press Enter

You should see:
```javascript
{
  VITE_SUPABASE_URL: "https://ckloewflialohuvixmvd.supabase.co",
  VITE_SUPABASE_ANON_KEY: "eyJh...",
  VITE_API_URL: "https://api.mail.sagerock.com",
  // ... other vars
}
```

If you see `undefined` for any of these, the environment variable isn't set correctly in Vercel.

## Important Notes

### Why VITE_ Prefix?

Vite only exposes environment variables that start with `VITE_` to the browser. This is for security - backend-only secrets (like `SUPABASE_SERVICE_KEY`) should NOT have the `VITE_` prefix.

### Frontend vs Backend

- **Frontend (Vercel)**: Set in Vercel dashboard → Settings → Environment Variables
- **Backend (Railway)**: Set in Railway dashboard → Your project → Variables

Your backend is already configured correctly (it's working). The issue is just the frontend environment variables.

## Alternative: Use Environment Variable UI

Vercel also has a nice UI for this:

1. In your project settings
2. Scroll to "Environment Variables"
3. Click "Add New"
4. Enter:
   - **Key**: `VITE_SUPABASE_URL`
   - **Value**: (paste the value)
   - **Environment**: Check "Production" (and optionally Preview/Development)
5. Click "Save"
6. Repeat for each variable
7. Redeploy

## After Setting Variables

Once you've set the environment variables and redeployed:

1. The session should persist across refreshes
2. No more infinite spinning
3. Everything should work like it does locally

The issue you're experiencing is 100% an environment variable problem!
