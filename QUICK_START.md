# Quick Start Guide

## What You Have

A complete email marketing platform with:
- ✅ Contact management with tag-based filtering
- ✅ Template library for storing Stripo HTML emails
- ✅ Campaign builder with scheduling
- ✅ Analytics dashboard
- ✅ Multi-client support
- ✅ SendGrid integration with IP pool support

## Next Steps

### 1. Set Up Supabase (5 minutes)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Copy your project URL and anon key from Settings > API
4. Create `.env` file in the project root:
   ```env
   VITE_SUPABASE_URL=your_project_url
   VITE_SUPABASE_ANON_KEY=your_anon_key
   ```
5. Go to SQL Editor in Supabase dashboard
6. Copy and run the entire contents of `supabase/migrations/001_initial_schema.sql`

### 2. Start the Frontend (1 minute)

```bash
npm run dev
```

Open http://localhost:5173 in your browser

### 3. Set Up SendGrid (5 minutes)

1. Create account at [sendgrid.com](https://sendgrid.com)
2. Go to Settings > API Keys
3. Create new API key with "Full Access"
4. In your app, go to Settings page
5. Click "Add Client" and paste your SendGrid API key

### 4. Add Your First Contact

1. Go to Contacts page
2. Click "Add Contact"
3. Enter email and optionally add tags like "newsletter", "customer", etc.

### 5. Create a Template

1. Design email in [Stripo](https://stripo.email) or use any HTML
2. Go to Templates page
3. Click "Add Template"
4. Paste your HTML and add subject line

### 6. Create a Campaign

1. Go to Campaigns page
2. Click "Create Campaign"
3. Select your template
4. Configure sender info (use verified SendGrid email)
5. Save as draft or schedule

## Optional: Backend API Setup

For actually sending emails and tracking analytics, you'll need the backend:

```bash
cd api
npm install
```

Create `api/.env`:
```env
VITE_SUPABASE_URL=your_project_url
SUPABASE_SERVICE_KEY=your_service_key  # From Supabase Settings > API
PORT=3001
```

Start the API:
```bash
npm start
```

## SendGrid Webhook (for Analytics)

1. Deploy your backend API to a public URL
2. In SendGrid: Settings > Mail Settings > Event Webhook
3. Set POST URL to: `https://your-domain.com/api/webhook/sendgrid`
4. Enable events: Delivered, Opened, Clicked, Bounced, Spam Reports, Unsubscribes

## Tips

- **Tags**: Use tags to segment contacts (e.g., "vip", "newsletter", "customer")
- **IP Pools**: If you have dedicated IPs in SendGrid, add pool names in Settings
- **Templates**: Export HTML from Stripo and paste directly into Templates
- **Testing**: Start with test contacts using your own email addresses

## Workflow Example

1. Import contacts or add them manually with tags
2. Create email template in Stripo
3. Create campaign and target specific tags
4. Schedule or send immediately
5. Check Analytics page for performance

## Need Help?

- Check the full README.md for detailed documentation
- Review the database schema in `supabase/migrations/001_initial_schema.sql`
- All SendGrid integration is in `api/server.js`
- Frontend code is well-commented and organized by feature

## Multi-Client Usage

To manage multiple clients:
1. Add each client in Settings with their SendGrid API key
2. Contact/Campaign/Template data automatically associates with clients
3. Switch between clients via the UI (to be implemented)

Currently all data is shared, but the database is ready for multi-tenancy.

---

Happy emailing!
