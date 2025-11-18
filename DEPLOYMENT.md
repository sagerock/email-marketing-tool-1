# Deployment Guide

This guide walks you through deploying your Email Marketing Tool to production using Vercel (frontend) and Railway (backend).

## Architecture Overview

```
┌─────────────────────────┐
│ mail.sagerock.com       │ ← React Frontend (Vercel)
│ - Contact Management    │
│ - Campaign Creation     │
│ - Analytics Dashboard   │
└───────────┬─────────────┘
            │ API Calls
            ▼
┌─────────────────────────┐
│ api.mail.sagerock.com   │ ← Express Backend (Railway)
│ - SendGrid Integration  │
│ - Email Sending         │
│ - Webhook Processing    │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ SendGrid                │ ← Email Service
│ - Email Delivery        │
│ - Event Webhooks        │
└─────────────────────────┘
```

---

## Prerequisites

Before deploying, ensure you have:

- [x] GitHub repository with your code
- [x] Vercel account (free tier is fine)
- [x] Railway account (free trial available)
- [x] Supabase project set up
- [x] Domain access for `sagerock.com`
- [x] SendGrid account with API key

---

## Part 1: Database Setup (Supabase)

### 1. Run Migrations

Go to your Supabase dashboard:

1. Navigate to **SQL Editor**
2. Run the initial schema:
   ```sql
   -- Copy and paste contents from:
   supabase/migrations/001_initial_schema.sql
   ```
3. Run the unsubscribe migration:
   ```sql
   -- Copy and paste contents from:
   supabase/migrations/002_add_unsubscribe.sql
   ```

### 2. Get API Keys

In Supabase dashboard:

1. Go to **Settings** > **API**
2. Copy these values:
   - Project URL: `https://xxxxx.supabase.co`
   - `anon` `public` key (for frontend)
   - `service_role` `secret` key (for backend)

---

## Part 2: Backend Deployment (Railway)

### Step 1: Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Click **"New Project"** > **"Deploy from GitHub repo"**
3. Authorize Railway to access your GitHub
4. Select your repository

### Step 2: Configure Environment Variables

In Railway dashboard, go to **Variables** and add:

```env
BASE_URL=https://mail.sagerock.com
VITE_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
NODE_ENV=production
```

**Important:** Don't set `PORT` - Railway sets this automatically.

### Step 3: Configure Custom Domain

1. In Railway dashboard, go to **Settings** > **Networking**
2. Click **"Generate Domain"** (Railway will give you a `.railway.app` domain)
3. Click **"Add Custom Domain"**
4. Enter: `api.mail.sagerock.com`
5. Railway will show you DNS records to add

### Step 4: Add DNS Records

In your domain provider (wherever `sagerock.com` is hosted):

Add a CNAME record:
```
Type: CNAME
Name: api.mail
Value: [Railway provides this - something like your-app.railway.app]
TTL: 3600
```

### Step 5: Verify Deployment

1. Railway will automatically deploy when you push to GitHub
2. Check logs in Railway dashboard for any errors
3. Test the health endpoint:
   ```bash
   curl https://api.mail.sagerock.com/api/health
   ```
   Should return: `{"status":"ok"}`

---

## Part 3: Frontend Deployment (Vercel)

### Step 1: Create Vercel Project

1. Go to [vercel.com](https://vercel.com)
2. Click **"Add New..."** > **"Project"**
3. Import your GitHub repository
4. Vercel will auto-detect it's a Vite project

### Step 2: Configure Build Settings

Vercel should auto-detect, but verify:

```
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

### Step 3: Add Environment Variables

In Vercel dashboard, go to **Settings** > **Environment Variables**:

Add these for **Production**:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_API_URL=https://api.mail.sagerock.com
```

### Step 4: Configure Custom Domain

1. In Vercel dashboard, go to **Settings** > **Domains**
2. Add domain: `mail.sagerock.com`
3. Vercel will show you DNS records to add

### Step 5: Add DNS Records

In your domain provider:

Add a CNAME record:
```
Type: CNAME
Name: mail
Value: cname.vercel-dns.com
TTL: 3600
```

Or if you prefer A records, Vercel will provide IP addresses.

### Step 6: Deploy

1. Click **"Deploy"** in Vercel dashboard
2. Wait for build to complete (usually 1-2 minutes)
3. Visit `https://mail.sagerock.com` to verify

---

## Part 4: SendGrid Configuration

### Step 1: Configure Event Webhook

1. Go to [SendGrid Dashboard](https://app.sendgrid.com)
2. Navigate to **Settings** > **Mail Settings** > **Event Webhook**
3. Click **"Create"**
4. Set HTTP POST URL:
   ```
   https://api.mail.sagerock.com/api/webhook/sendgrid
   ```
5. Enable these events:
   - ✅ Delivered
   - ✅ Opened
   - ✅ Clicked
   - ✅ Bounced
   - ✅ Spam Reports
   - ✅ Unsubscribed
6. Click **"Test Your Integration"** to verify it works
7. Enable the webhook

### Step 2: Domain Authentication (Recommended)

1. In SendGrid, go to **Settings** > **Sender Authentication**
2. Click **"Authenticate Your Domain"**
3. Follow steps to add DNS records for `sagerock.com`
4. This improves email deliverability

---

## Part 5: Testing the Deployment

### 1. Test Frontend

Visit `https://mail.sagerock.com` and verify:
- [x] Page loads without errors
- [x] Can access Settings page
- [x] Can add a client (test with dummy data first)

### 2. Test Backend API

```bash
# Test health endpoint
curl https://api.mail.sagerock.com/api/health

# Should return: {"status":"ok"}
```

### 3. Test Full Flow

1. Add a client in Settings with your SendGrid API key
2. Add a test contact (use your own email)
3. Create a simple email design with unsubscribe link:
   ```html
   <p>Test email</p>
   <a href="{{unsubscribe_url}}">Unsubscribe</a>
   ```
4. Create and send a test campaign
5. Check your email
6. Verify unsubscribe link works

### 4. Test Webhook

1. Send a test campaign
2. Open the email
3. Check Railway logs to see webhook events:
   ```
   Railway Dashboard > Deployments > View Logs
   ```
4. Verify events appear in Analytics page

---

## Part 6: DNS Configuration Summary

Here's what your DNS should look like:

```
# Main domain (if not already configured)
sagerock.com          A      76.76.21.21 (your hosting IP)

# Frontend (Vercel)
mail.sagerock.com     CNAME  cname.vercel-dns.com

# Backend (Railway)
api.mail.sagerock.com CNAME  your-app.railway.app

# SendGrid (for email authentication)
em1234.sagerock.com   CNAME  sendgrid.net
s1._domainkey...      CNAME  s1.domainkey.sendgrid.net
s2._domainkey...      CNAME  s2.domainkey.sendgrid.net
```

---

## Continuous Deployment

Both Vercel and Railway support automatic deployments:

### Automatic Deployments
- Push to `main` branch → Auto-deploys to production
- Push to other branches → Creates preview deployments

### Manual Deployments
- **Vercel:** Dashboard > Deployments > Redeploy
- **Railway:** Dashboard > Deployments > Redeploy

---

## Environment Variables Reference

### Frontend (Vercel)
```env
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
VITE_API_URL=https://api.mail.sagerock.com
```

### Backend (Railway)
```env
BASE_URL=https://mail.sagerock.com
VITE_SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
NODE_ENV=production
```

---

## Troubleshooting

### Frontend Issues

**Problem:** White screen or blank page
- Check Vercel deployment logs for build errors
- Verify environment variables are set
- Check browser console for JavaScript errors

**Problem:** API calls failing
- Verify `VITE_API_URL` is set correctly
- Check CORS errors in browser console
- Verify Railway backend is running

### Backend Issues

**Problem:** Railway deployment fails
- Check Railway logs for errors
- Verify all environment variables are set
- Make sure `package.json` has all dependencies

**Problem:** Emails not sending
- Verify SendGrid API key is correct in database
- Check Railway logs for SendGrid errors
- Verify `BASE_URL` is set for unsubscribe links

**Problem:** Webhooks not working
- Test webhook URL manually
- Check Railway logs when webhook fires
- Verify webhook URL in SendGrid is correct
- Make sure webhook is enabled in SendGrid

### Database Issues

**Problem:** Can't connect to Supabase
- Verify Supabase project URL is correct
- Check API keys are valid
- Ensure RLS policies allow access

### DNS Issues

**Problem:** Domain not resolving
- Wait 24-48 hours for DNS propagation
- Use `dig mail.sagerock.com` to check DNS
- Verify CNAME records are correct
- Clear browser cache

---

## Monitoring & Logs

### Vercel Logs
- Dashboard > Deployments > [Latest] > Logs
- View runtime logs and errors

### Railway Logs
- Dashboard > Deployments > View Logs
- Real-time logs of API requests and errors
- Watch for SendGrid webhook events

### Supabase Logs
- Dashboard > Logs > API Logs
- View database queries and errors

---

## Security Checklist

- [x] Use environment variables for all secrets
- [x] Never commit `.env` files to Git
- [x] Use `service_role` key only in backend
- [x] Use `anon` key in frontend
- [x] Enable CORS only for your domains
- [x] Use HTTPS for all endpoints
- [x] Verify webhook signatures (optional enhancement)

---

## Cost Estimates

### Free Tier Limits

**Vercel (Free)**
- Bandwidth: 100 GB/month
- Build minutes: 6,000/month
- Serverless function executions: 100k/month
- ✅ More than enough for small-medium usage

**Railway (Free Trial)**
- $5 free trial credit
- After trial: ~$5-10/month for small usage
- No execution limits

**Supabase (Free)**
- Database: 500 MB
- API requests: Unlimited
- Bandwidth: 2 GB
- ✅ Great for starting out

**SendGrid (Free)**
- 100 emails/day forever free
- Can upgrade as needed

---

## Next Steps After Deployment

1. **Test thoroughly** with a small contact list
2. **Set up monitoring** (Railway and Vercel both have built-in monitoring)
3. **Configure backups** in Supabase
4. **Add your logo/branding** to email templates
5. **Create email templates** in Stripo
6. **Import your contacts**
7. **Send your first campaign!**

---

## Getting Help

If you run into issues:

1. Check the logs (Vercel, Railway, Supabase)
2. Review this deployment guide
3. Check `UNSUBSCRIBE_SETUP.md` for unsubscribe-specific issues
4. Verify all environment variables are set correctly
5. Test each component individually

---

## Deployment Checklist

Use this checklist to ensure everything is deployed correctly:

### Database
- [ ] Ran migration 001_initial_schema.sql
- [ ] Ran migration 002_add_unsubscribe.sql
- [ ] Verified tables exist in Supabase

### Railway (Backend)
- [ ] Project created and connected to GitHub
- [ ] Environment variables configured
- [ ] Custom domain `api.mail.sagerock.com` added
- [ ] DNS CNAME record added
- [ ] Deployment successful
- [ ] Health check endpoint works

### Vercel (Frontend)
- [ ] Project created and connected to GitHub
- [ ] Environment variables configured
- [ ] Custom domain `mail.sagerock.com` added
- [ ] DNS CNAME record added
- [ ] Deployment successful
- [ ] Website loads without errors

### SendGrid
- [ ] Event webhook configured
- [ ] Webhook URL points to Railway backend
- [ ] All event types enabled
- [ ] Webhook tested and working
- [ ] (Optional) Domain authentication completed

### Testing
- [ ] Can login to frontend
- [ ] Can add a client
- [ ] Can add contacts
- [ ] Can create email designs
- [ ] Can create campaigns
- [ ] Test email sends successfully
- [ ] Unsubscribe link works
- [ ] Analytics show webhook events

---

**Congratulations! Your email marketing tool is now live! 🎉**
