# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SageRock Email Marketing Tool - A multi-tenant email marketing platform with contact management, campaign builder, automation sequences, and analytics. Live at https://mail.sagerock.com

## Development Commands

### Frontend (root directory)
```bash
npm run dev        # Start Vite dev server (localhost:5173)
npm run build      # TypeScript compilation + Vite production build
npm run lint       # Run ESLint
npm run preview    # Preview production build
```

### Backend API (api/ directory)
```bash
npm run dev:api          # Start API with nodemon (auto-reload)
cd api && npm start      # Start production server (port 3001)
```

### Combined (for production)
```bash
npm run build:all    # Build frontend + install API deps
npm start            # Start server (serves both frontend and API)
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, React Router
- **Backend**: Express.js with node-cron for scheduled tasks
- **Database**: Supabase (PostgreSQL) with Row Level Security
- **Auth**: Supabase Auth with PKCE flow
- **Email**: SendGrid (API keys stored per-client in database)
- **State**: React Context (AuthContext, ClientContext) + React Query
- **Deployment**: Railway (unified frontend + backend)

## Architecture

### Multi-Tenant Design
- Each client has separate SendGrid API key stored in `clients` table
- All data tables include `client_id` foreign key for isolation
- Client selection persisted in localStorage, accessible via `useClient()` hook
- RLS policies enforce client-level data isolation

### Authentication Flow
- Supabase Auth with PKCE (secure for SPAs)
- `AuthContext` provides `user`, `session`, `signIn()`, `signOut()`
- `ProtectedRoute` component guards authenticated pages
- Public routes: `/welcome` (landing), `/login`, `/signup`, `/unsubscribe`

### Frontend → Backend Communication
- Frontend uses Supabase anon key for direct database queries (protected by RLS)
- Backend handles sensitive operations requiring service key:
  - `/api/send-campaign` - Send emails via SendGrid
  - `/api/send-test-email` - Send test emails
  - `/api/webhook/sendgrid` - Process SendGrid events
  - `/api/ip-pools` - IP pool management

### Salesforce Integration
Uses **OAuth 2.0 Client Credentials Flow** - no user interaction or callback URLs needed.

**Endpoints in `api/server.js`:**
- `POST /api/salesforce/connect` - Store credentials and test connection
- `GET /api/salesforce/status` - Get connection status
- `POST /api/salesforce/disconnect` - Remove connection
- `GET /api/salesforce/fields` - List all Lead/Contact fields (helps discover API names)
- `POST /api/salesforce/sync` - Sync contacts (incremental or full)
- `GET /api/salesforce/preview` - Preview data without syncing

**Credentials stored per-client in `clients` table:**
- `salesforce_instance_url` - e.g., https://yourcompany.my.salesforce.com
- `salesforce_client_id` - Consumer Key from Connected App
- `salesforce_client_secret` - Consumer Secret from Connected App

**Contacts table Salesforce fields:** `salesforce_id`, `record_type`, `source_code`, `industry`

**How it works:** Each API call gets a fresh access token using the Client Credentials flow (no refresh tokens needed).

## Setting Up Salesforce for a New Client

### Step 1: Salesforce Admin Creates Connected App
In Salesforce Setup:
1. **Enable Client Credentials Flow globally:**
   - Setup → OAuth and OpenID Connect Settings
   - Enable "Allow OAuth 2.0 Client Credentials Flow"

2. **Create Connected App:**
   - Setup → App Manager → New Connected App
   - Enable OAuth Settings
   - Callback URL: `https://localhost` (not used but required)
   - OAuth Scopes: Select "Manage user data via APIs (api)"
   - **Check "Enable Client Credentials Flow"**
   - Save

3. **Configure the "Run As" User:**
   - After saving, click "Manage" on the app
   - Click "Edit Policies"
   - Under "Client Credentials Flow", select a user in "Run As" field
   - This user's permissions determine what data the app can access
   - Save

4. **Get Credentials:**
   - Go back to the app's detail page
   - Click "Manage Consumer Details"
   - Copy the **Consumer Key** (Client ID) and **Consumer Secret**

### Step 2: Connect in Email Marketing Tool
1. Go to Settings page
2. Select the client from dropdown
3. Click "Connect Salesforce"
4. Enter:
   - Instance URL: `https://[company].my.salesforce.com`
   - Client ID: Consumer Key from step 1
   - Client Secret: Consumer Secret from step 1
5. Click Connect

### Step 3: Test and Sync
1. Click "View Fields" to see available Salesforce fields
2. Click "Sync Now" for incremental sync (only records changed since last sync)
3. Click "Full Sync" to re-sync all records

### Troubleshooting
- **"invalid_client" error**: Client ID or Secret is wrong
- **"unauthorized_client" error**: Client Credentials Flow not enabled on the Connected App
- **"INVALID_SESSION_ID"**: The "Run As" user may not have API permissions
- **Field not found in sync**: Check the field API name using "View Fields" button

### Salesforce Campaign Integration

Syncs Salesforce Campaigns and Campaign Members to enable tradeshow follow-up automations.

**Database Tables:**
- `salesforce_campaigns` - Synced SF Campaign records (id, name, type, status, dates)
- `salesforce_campaign_members` - Links contacts to campaigns
- `industry_links` - Maps industry names to URLs for dynamic content

**Endpoints:**
- `POST /api/salesforce/sync-campaigns` - Sync campaigns & members (runs in background)
- `POST /api/sequences/:id/enroll-campaign-members` - Enroll existing campaign members

**Auto-Sync:** Campaigns sync daily at 6 AM UTC along with contacts.

**Manual Sync:** Settings page → "Sync Campaigns" button

### Industry Links

Maps contact industry values to URLs for personalized email content.

**Setup:** Settings page → Industry Links section
- Add industry name (must match Salesforce exactly, e.g., "Biotech/Biopharma")
- Add corresponding URL (e.g., "https://example.com/biotech")
- Default fallback: `https://alconox.com/industries/`

**Usage:** Use `{{industry_link}}` merge tag in email templates (see Merge Tags section).

### Automation Sequences
- `email_sequences` defines workflows with trigger conditions
- `sequence_steps` contains individual emails with delays
- `sequence_enrollments` tracks contact progress through sequences
- `scheduled_emails` queued emails processed by node-cron jobs

**Trigger Types:**
- `manual` - Manually enroll contacts
- `tag_added` - Auto-enroll when contact receives a specific tag
- `salesforce_campaign` - Auto-enroll when lead is added to selected SF Campaign(s)

**Multi-Campaign Triggers:** Sequences can be triggered by multiple SF Campaigns. Use checkbox UI to select campaigns. Leads added to ANY selected campaign will be enrolled.

**Enrolling Existing Members:**
When you save automation settings with SF Campaign trigger:
1. Prompt appears: "Enroll existing members?"
2. **OK** → Enrolls all current campaign members + future members auto-enroll
3. **Cancel** → Only future members (from syncs) will be enrolled

You can also use the "Enroll Existing Members" button in the Settings tab to manually trigger enrollment later.

### Merge Tags

Available in email templates for personalization:

**Text Tags:**
- `{{first_name}}` - Contact's first name
- `{{last_name}}` - Contact's last name
- `{{email}}` - Contact's email address
- `{{mailing_address}}` - Client's mailing address (CAN-SPAM required)
- `{{campaign_name}}` - Salesforce Campaign name (automations only, from trigger campaign)

**URL Tags (must wrap in `<a href="">`)**:
- `{{unsubscribe_url}}` - Unsubscribe link (CAN-SPAM required)
- `{{industry_link}}` - Industry-specific URL based on contact's industry field

**Example URL tag usage:**
```html
<a href="{{unsubscribe_url}}">Unsubscribe</a>
<a href="{{industry_link}}">View solutions for your industry</a>
```

### Campaign Recipient Filtering

Regular campaigns can filter recipients by:
- **Tags** - Send to contacts with selected tag(s) (OR logic)
- **Salesforce Campaign** - Send to contacts who are members of a SF Campaign

Both filters can be combined (AND logic) - e.g., "contacts in Tradeshow X who also have tag Y"

## Key Files

- `src/contexts/AuthContext.tsx` - Authentication state management
- `src/context/ClientContext.tsx` - Multi-client state management
- `src/lib/supabase.ts` - Supabase client initialization
- `src/lib/utils.ts` - Utilities: `cn()` (class merging), `formatDate()`, `formatDateTime()`
- `api/server.js` - Express backend with SendGrid and Salesforce integration
- `supabase/migrations/` - Database schema (run in order: 001-018)

## Database Schema

**Core tables:** `clients`, `contacts`, `templates`, `campaigns`, `analytics_events`, `tags`, `email_sequences`, `sequence_steps`, `sequence_enrollments`, `scheduled_emails`, `admin_users`

**Salesforce tables:** `salesforce_campaigns`, `salesforce_campaign_members`, `industry_links`

**Key patterns:**
- UUIDs for all primary keys
- `client_id` FK on data tables for multi-tenancy
- JSONB for flexible fields (`custom_fields`, `trigger_config`)
- Array columns for tags (`tags text[]`) and campaign triggers (`trigger_salesforce_campaign_ids uuid[]`)
- Unique constraint on `(email, client_id)` in contacts

**Key columns:**
- `campaigns.salesforce_campaign_id` - Links campaign to SF Campaign for recipient filtering
- `email_sequences.trigger_salesforce_campaign_ids` - Array of SF Campaign IDs that trigger enrollment
- `contacts.industry` - Used for `{{industry_link}}` merge tag lookup

## UI Component Library

Located in `src/components/ui/`:
- `Button` - Variants: default, outline, ghost, destructive; Sizes: sm, default, lg
- `Card`, `CardHeader`, `CardContent`, `CardTitle`, `CardDescription`
- `Input` - Standard form input with consistent styling
- `Badge` - Variants: default, secondary, outline, destructive

Uses `cn()` utility for merging Tailwind classes with clsx + tailwind-merge.

## Environment Variables

### Railway (unified deployment)
```
VITE_SUPABASE_URL=         # Supabase project URL
VITE_SUPABASE_ANON_KEY=    # Supabase anon key (frontend)
SUPABASE_SERVICE_KEY=      # Service role key (backend, elevated permissions)
VITE_API_URL=              # Leave empty for same-origin (unified deployment)
BASE_URL=                  # App URL for unsubscribe links
PORT=3001                  # Railway sets this automatically
NODE_ENV=production
```

Note: SendGrid API keys and Salesforce credentials are stored per-client in the `clients` database table, not in environment variables.
