# ⚡ QUICK FIX - Session Not Persisting Online

## TL;DR

Your app works locally but not on https://mail.sagerock.com because **Vercel doesn't have the environment variables**.

## ✅ 3-Step Fix

### 1️⃣ Go to Vercel
👉 https://vercel.com/dashboard → Your Project → Settings → Environment Variables

### 2️⃣ Add These Variables

Copy/paste these exactly:

```
VITE_SUPABASE_URL = https://ckloewflialohuvixmvd.supabase.co
VITE_SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbG9ld2ZsaWFsb2h1dml4bXZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0Mjg0NTIsImV4cCI6MjA3OTAwNDQ1Mn0.W3GFbdfx0a05J_OksNIQ7SngCAf-7ytcRUZUhDIgHJo
VITE_API_URL = https://api.mail.sagerock.com
```

Select **"Production"** for each one.

### 3️⃣ Redeploy

Deployments tab → Latest deployment → ... menu → Redeploy

## 🧪 Test It

1. Wait for redeploy to finish (1-2 min)
2. Go to https://mail.sagerock.com
3. Clear browser cache
4. Login
5. **Refresh page** ← should work now!

## 🔍 How to Check

Open console (F12) and type:
```javascript
import.meta.env.VITE_SUPABASE_URL
```

If it says `undefined` = variables not set
If it says `"https://ckloewflialohuvixmvd.supabase.co"` = ✅ working!

---

That's it! This will fix the issue.
