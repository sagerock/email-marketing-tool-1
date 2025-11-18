# Railway Environment Variables Setup

## Required Environment Variables

Add these in your Railway dashboard under **Variables**:

```env
# Base URL (your frontend domain)
BASE_URL=https://mail.sagerock.com

# Supabase Configuration
VITE_SUPABASE_URL=https://ckloewflialohuvixmvd.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzQyODQ1MiwiZXhwIjoyMDc5MDA0NDUyfQ.Z_6kVaKtZmKQWtDBV_iu3wyZzJm8zbyc_IHKLWBvJ2o

# Node Environment
NODE_ENV=production
```

## Important Notes

1. **Do NOT set PORT** - Railway automatically sets this
2. **BASE_URL** is critical for unsubscribe links to work
3. **SUPABASE_SERVICE_KEY** is different from the anon key (has more permissions)

## How to Add Variables in Railway

1. Go to your Railway project dashboard
2. Click on your service
3. Go to **Variables** tab
4. Click **New Variable**
5. Add each variable from above
6. Railway will automatically redeploy

## Verify Variables Are Set

After adding variables, check Railway logs for:
```
API server running on port 3001
```

If you see connection errors, double-check:
- Supabase URL is correct
- Service key has the right permissions
- BASE_URL matches your frontend domain
