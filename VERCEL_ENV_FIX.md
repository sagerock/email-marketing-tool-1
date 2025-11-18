# Fix Vercel Environment Variables

## Problem
Frontend shows blank screen with error:
```
Uncaught Error: Missing Supabase environment variables
```

This is because Vercel doesn't have the environment variables configured.

## Solution

You need to add environment variables in Vercel dashboard:

### Step 1: Go to Vercel Dashboard

1. Visit: https://vercel.com/dashboard
2. Find your project: `email-marketing-tool-1` (or similar name)
3. Click on the project

### Step 2: Add Environment Variables

1. Click **Settings** tab
2. Click **Environment Variables** in the left sidebar
3. Add these THREE variables:

#### Variable 1: VITE_SUPABASE_URL
```
Name: VITE_SUPABASE_URL
Value: https://ckloewflialohuvixmvd.supabase.co
Environment: Production, Preview, Development (select all)
```

#### Variable 2: VITE_SUPABASE_ANON_KEY
```
Name: VITE_SUPABASE_ANON_KEY
Value: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0Mjg0NTIsImV4cCI6MjA3OTAwNDQ1Mn0.W3GFbdfx0a05J_OksNIQ7SngCAf-7ytcRUZUhDIgHJo
Environment: Production, Preview, Development (select all)
```

#### Variable 3: VITE_API_URL
```
Name: VITE_API_URL
Value: https://api.mail.sagerock.com
Environment: Production, Preview, Development (select all)
```

### Step 3: Redeploy

After adding all three variables:

1. Go to **Deployments** tab
2. Find the latest deployment
3. Click the three dots menu (⋮)
4. Click **Redeploy**
5. Confirm redeploy

**OR** trigger a redeploy by pushing to GitHub:
```bash
git commit --allow-empty -m "Trigger Vercel redeploy"
git push origin main
```

### Step 4: Verify

Wait 1-2 minutes for deployment to complete, then:

1. Visit: https://mail.sagerock.com
2. You should see the application load (no blank screen)
3. Open browser console - no errors about missing env vars

---

## Quick Copy-Paste Values

For easy copying:

**VITE_SUPABASE_URL:**
```
https://ckloewflialohuvixmvd.supabase.co
```

**VITE_SUPABASE_ANON_KEY:**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0Mjg0NTIsImV4cCI6MjA3OTAwNDQ1Mn0.W3GFbdfx0a05J_OksNIQ7SngCAf-7ytcRUZUhDIgHJo
```

**VITE_API_URL:**
```
https://api.mail.sagerock.com
```

---

## Alternative: Using Vercel CLI

If you have Vercel CLI installed:

```bash
# Login to Vercel
vercel login

# Link to your project
vercel link

# Add environment variables
vercel env add VITE_SUPABASE_URL production
# Paste: https://ckloewflialohuvixmvd.supabase.co

vercel env add VITE_SUPABASE_ANON_KEY production
# Paste the anon key

vercel env add VITE_API_URL production
# Paste: https://api.mail.sagerock.com

# Redeploy
vercel --prod
```

---

## Troubleshooting

**Still seeing blank screen after redeployment?**
1. Hard refresh browser: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)
2. Clear browser cache
3. Check Vercel deployment logs for build errors
4. Verify environment variables are saved in Vercel dashboard

**Build fails after adding env vars?**
- Check for typos in variable names (must be exact: `VITE_SUPABASE_URL`, not `SUPABASE_URL`)
- Ensure no extra spaces in values
- Verify you selected the right environments (Production at minimum)

---

## Why This Happened

Environment variables in `.env` are only for local development. When you deploy to Vercel:
- Vercel builds the app in their environment
- They don't have access to your local `.env` file
- You must configure env vars in Vercel dashboard
- Vercel injects them during build time

The `VITE_` prefix is required for Vite to expose these variables to the frontend code.
