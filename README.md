# Email Marketing Tool

A modern, full-featured email marketing platform built with React, TypeScript, Supabase, and SendGrid. Designed for managing contacts, creating campaigns, and tracking analytics with support for multiple clients and dedicated IP pools.

**Live Demo:** https://mail.sagerock.com

## Features

- **Contact Management**
  - Import and organize contacts
  - Tag-based segmentation
  - Custom fields support
  - Search and filter capabilities

- **Template Library**
  - Store HTML email templates from Stripo
  - Preview templates before sending
  - Reusable template management

- **Campaign Builder**
  - Create and schedule email campaigns
  - Target specific contact segments by tags
  - Support for dedicated IP pools
  - Draft and scheduled campaign states

- **Analytics Dashboard**
  - Real-time campaign performance tracking
  - Open rates, click rates, bounce tracking
  - SendGrid webhook integration for events
  - Detailed engagement metrics

- **Multi-Client Support**
  - Manage multiple clients/workspaces
  - Separate SendGrid API keys per client
  - IP pool management per client
  - Client-level data isolation

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **Email Service**: SendGrid
- **Routing**: React Router
- **Backend API**: Node.js/Express (optional)

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- A Supabase account and project
- A SendGrid account and API key

### Installation

1. **Clone or navigate to the project directory**

2. **Install frontend dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   Create a `.env` file in the root directory:
   ```env
   VITE_SUPABASE_URL=your_supabase_project_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

4. **Set up Supabase database**
   - Go to your Supabase project dashboard
   - Navigate to the SQL Editor
   - Run the migration script from `supabase/migrations/001_initial_schema.sql`

5. **Start the development server**
   ```bash
   npm run dev
   ```

### Backend API Setup (Optional but Recommended)

The backend API handles SendGrid email sending and webhook events.

1. **Navigate to the api directory**
   ```bash
   cd api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create API .env file**
   Create `.env` in the `api` directory:
   ```env
   VITE_SUPABASE_URL=your_supabase_project_url
   SUPABASE_SERVICE_KEY=your_supabase_service_key
   PORT=3001
   ```

4. **Start the API server**
   ```bash
   npm start
   ```

## Database Schema

The application uses the following main tables:

- **clients**: Multi-client configuration with SendGrid API keys
- **contacts**: Email contacts with tags and custom fields
- **templates**: Email template storage
- **campaigns**: Campaign management and scheduling
- **analytics_events**: SendGrid webhook event tracking

See `supabase/migrations/001_initial_schema.sql` for the complete schema.

## SendGrid Configuration

### API Key Setup

1. Log in to your SendGrid account
2. Navigate to Settings > API Keys
3. Create a new API key with "Full Access" permissions
4. Add the API key to a client in the Settings page

### Webhook Configuration

To enable analytics tracking:

1. In SendGrid, go to Settings > Mail Settings > Event Webhook
2. Set the HTTP POST URL to your backend endpoint:
   ```
   https://your-domain.com/api/webhook/sendgrid
   ```
3. Enable the following events:
   - Delivered
   - Opened
   - Clicked
   - Bounced
   - Spam Reports
   - Unsubscribes

### IP Pool Setup (Optional)

1. In SendGrid, configure dedicated IP addresses
2. Create IP pools and assign IPs to them
3. Add IP pool names to your client configuration
4. Select IP pools when creating campaigns

## Usage Guide

### Adding Contacts

1. Navigate to the Contacts page
2. Click "Add Contact" or "Import CSV"
3. Enter contact details and assign tags
4. Tags can be used later for campaign segmentation

### Creating Templates

1. Design your email in Stripo (or any HTML email designer)
2. Export the HTML code
3. Go to Templates page and click "Add Template"
4. Paste the HTML and add template metadata

### Creating Campaigns

1. Go to Campaigns page and click "Create Campaign"
2. Select a template (or create custom HTML later)
3. Configure sender information
4. (Optional) Select tags to target specific contacts
5. (Optional) Choose an IP pool
6. (Optional) Schedule a send time or save as draft

### Viewing Analytics

1. Navigate to the Analytics page
2. Select a campaign from the dropdown
3. View metrics:
   - Send and delivery rates
   - Open and click rates
   - Bounce and spam reports
   - Recent event timeline

### Managing Multiple Clients

1. Go to Settings page
2. Click "Add Client"
3. Enter client name and SendGrid API key
4. (Optional) Add IP pool names
5. All data (contacts, campaigns, etc.) will be associated with the client

## Project Structure

```
email-marketing-tool/
├── src/
│   ├── components/
│   │   ├── ui/           # Reusable UI components
│   │   └── Layout.tsx    # Main layout with navigation
│   ├── pages/            # Main page components
│   │   ├── Contacts.tsx
│   │   ├── Templates.tsx
│   │   ├── Campaigns.tsx
│   │   ├── Analytics.tsx
│   │   └── Settings.tsx
│   ├── services/         # API services
│   │   └── sendgrid.ts
│   ├── lib/              # Utilities
│   │   ├── supabase.ts
│   │   └── utils.ts
│   ├── types/            # TypeScript types
│   └── App.tsx           # Main app component
├── api/                  # Backend API
│   ├── server.js         # Express server
│   └── package.json
├── supabase/
│   └── migrations/       # Database migrations
└── public/               # Static assets
```

## Development

### Available Scripts

**Frontend:**
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

**Backend API:**
- `npm start` - Start API server
- `npm run dev` - Start with nodemon (auto-reload)

### Building for Production

1. Build the frontend:
   ```bash
   npm run build
   ```

2. The built files will be in the `dist/` directory

3. Deploy the API server to your hosting platform

4. Update environment variables in production

## Deployment

### Frontend Deployment

Deploy to any static hosting platform:
- Vercel
- Netlify
- AWS S3 + CloudFront
- Cloudflare Pages

### Backend API Deployment

Deploy to any Node.js hosting platform:
- Railway
- Render
- Heroku
- AWS EC2/ECS
- DigitalOcean

### Environment Variables

Make sure to set all required environment variables in your hosting platform.

## Security Considerations

- Never expose SendGrid API keys in the frontend
- Use Row Level Security (RLS) in Supabase for production
- Implement authentication before deploying
- Use HTTPS for webhook endpoints
- Validate webhook signatures from SendGrid
- Store API keys securely (environment variables, secrets manager)

## Completed Features

- ✅ **Unsubscribe System** - Full CAN-SPAM and GDPR compliant unsubscribe handling
  - Public unsubscribe page with resubscribe option
  - Automatic contact filtering for unsubscribed users
  - List-Unsubscribe headers for one-click unsubscribe
  - Webhook integration for unsubscribe events
  - See `UNSUBSCRIBE_SETUP.md` for details

- ✅ **Deployment Ready** - Production deployment configurations
  - Vercel configuration for frontend
  - Railway configuration for backend
  - Complete deployment guide
  - See `DEPLOYMENT.md` for step-by-step instructions

## Roadmap

Future enhancements:
- [ ] User authentication and authorization
- [ ] Bulk contact import from CSV
- [ ] Email template builder (drag-and-drop)
- [ ] A/B testing for campaigns
- [ ] Automated campaign sequences
- [ ] Advanced reporting and exports
- [ ] Suppression list management

## License

MIT

## Support

For issues or questions, please open an issue on the repository.
