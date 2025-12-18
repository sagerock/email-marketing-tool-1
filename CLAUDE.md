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
cd api && npm run dev    # Start with nodemon (auto-reload)
cd api && npm start      # Start production server (port 3001)
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, React Router
- **Backend**: Express.js with node-cron for scheduled tasks
- **Database**: Supabase (PostgreSQL) with Row Level Security
- **Auth**: Supabase Auth with PKCE flow
- **Email**: SendGrid (API keys stored per-client in database)
- **State**: React Context (AuthContext, ClientContext) + React Query
- **Deployment**: Vercel (frontend), Railway (backend)

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

### Automation Sequences
- `automation_sequences` defines workflows with trigger conditions
- `sequence_steps` contains individual emails with delays
- `sequence_enrollments` tracks contact progress through sequences
- `scheduled_emails` queued emails processed by node-cron jobs

## Key Files

- `src/contexts/AuthContext.tsx` - Authentication state management
- `src/context/ClientContext.tsx` - Multi-client state management
- `src/lib/supabase.ts` - Supabase client initialization
- `src/lib/utils.ts` - Utilities: `cn()` (class merging), `formatDate()`, `formatDateTime()`
- `api/server.js` - Express backend with SendGrid and Salesforce integration
- `supabase/migrations/` - Database schema (run in order: 001-010)

## Database Schema

Core tables: `clients`, `contacts`, `templates`, `campaigns`, `analytics_events`, `tags`, `automation_sequences`, `sequence_steps`, `sequence_enrollments`, `scheduled_emails`, `admin_users`

Key patterns:
- UUIDs for all primary keys
- `client_id` FK on data tables for multi-tenancy
- JSONB for flexible fields (`custom_fields`, `trigger_config`)
- Array columns for tags (`tags text[]`)
- Unique constraint on `(email, client_id)` in contacts

## UI Component Library

Located in `src/components/ui/`:
- `Button` - Variants: default, outline, ghost, destructive; Sizes: sm, default, lg
- `Card`, `CardHeader`, `CardContent`, `CardTitle`, `CardDescription`
- `Input` - Standard form input with consistent styling
- `Badge` - Variants: default, secondary, outline, destructive

Uses `cn()` utility for merging Tailwind classes with clsx + tailwind-merge.

## Environment Variables

### Frontend (.env)
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_API_URL=              # Backend API URL
```

### Backend (api/.env)
```
VITE_SUPABASE_URL=
SUPABASE_SERVICE_KEY=      # Service role key (elevated permissions)
PORT=3001
NODE_ENV=
BASE_URL=                  # For unsubscribe links
```

Note: SendGrid API keys and Salesforce credentials are stored per-client in the `clients` database table, not in environment variables.
