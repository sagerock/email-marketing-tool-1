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
- OAuth flow for connecting Salesforce to a client (per-client, not global)
- Endpoints in `api/server.js`:
  - `GET /api/salesforce/authorize` - Initiate OAuth flow
  - `GET /api/salesforce/callback` - Handle OAuth redirect
  - `GET /api/salesforce/status` - Get connection status
  - `POST /api/salesforce/disconnect` - Remove connection
  - `GET /api/salesforce/fields` - List all Lead/Contact fields (helps discover API names)
  - `POST /api/salesforce/sync` - Sync contacts (incremental or full)
  - `GET /api/salesforce/preview` - Preview data without syncing
- Tokens stored in `clients` table: `salesforce_instance_url`, `salesforce_access_token`, `salesforce_refresh_token`
- Contacts table has Salesforce fields: `salesforce_id`, `record_type`, `source_code`, `industry`
- Sync uses `LastModifiedDate` for incremental updates
- UI in Settings page shows connection status, sync button, and field browser

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
FRONTEND_URL=              # For OAuth redirects

# Salesforce OAuth (from Connected App in Salesforce Setup → App Manager)
SALESFORCE_CLIENT_ID=      # Consumer Key
SALESFORCE_CLIENT_SECRET=  # Consumer Secret
SALESFORCE_CALLBACK_URL=   # Must match Connected App callback URL exactly
```

Note: SendGrid API keys are stored per-client in the `clients` database table, not in environment variables. Salesforce OAuth tokens are also stored per-client after connection.
