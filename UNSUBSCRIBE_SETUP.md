# Unsubscribe System Setup Guide

This email marketing tool includes a comprehensive unsubscribe system that complies with email marketing laws (CAN-SPAM, GDPR, CASL).

## Features

✅ **Automatic Token Generation** - Every contact gets a unique unsubscribe token
✅ **Public Unsubscribe Page** - No authentication required to unsubscribe
✅ **One-Click Unsubscribe** - List-Unsubscribe headers for email clients
✅ **Resubscribe Option** - Contacts can resubscribe if they change their mind
✅ **Automatic Filtering** - Unsubscribed contacts are excluded from all campaigns
✅ **Webhook Integration** - SendGrid unsubscribe events update contact status
✅ **Analytics Tracking** - Unsubscribe events tracked in campaign analytics

## Database Setup

1. **Run the migration** to add unsubscribe fields to your database:

```bash
# In your Supabase dashboard, run this SQL:
/Volumes/T7/Scripts/Email Marketing Tool 1/supabase/migrations/002_add_unsubscribe.sql
```

This adds:
- `unsubscribed` (boolean) - Whether contact is unsubscribed
- `unsubscribed_at` (timestamp) - When they unsubscribed
- `unsubscribe_token` (text) - Unique token for unsubscribe links

## Email Template Requirements

All email templates created in Stripo (or any HTML editor) **MUST** include an unsubscribe link.

### Required Merge Tags

Your email templates should include these merge tags:

```html
<!-- Unsubscribe Link (REQUIRED) -->
<a href="{{unsubscribe_url}}">Unsubscribe</a>

<!-- Optional Personalization -->
Hello {{first_name}},
Email: {{email}}
```

### Example Footer HTML

Add this to the bottom of your email templates:

```html
<div style="text-align: center; padding: 20px; color: #666; font-size: 12px;">
  <p>
    You're receiving this email because you signed up for our newsletter.
  </p>
  <p>
    <a href="{{unsubscribe_url}}" style="color: #666; text-decoration: underline;">
      Unsubscribe from these emails
    </a>
  </p>
  <p>
    Company Name | 123 Main St, City, State 12345
  </p>
</div>
```

## Environment Configuration

Add to your `.env` file:

```env
# Base URL for unsubscribe links (production)
BASE_URL=https://yourdomain.com

# Supabase (already configured)
VITE_SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key
```

For local development, it defaults to `http://localhost:5173`

## SendGrid Configuration

### 1. Event Webhook Setup

Configure SendGrid to send webhook events to your API:

1. Go to SendGrid Dashboard → Settings → Mail Settings → Event Webhook
2. Set HTTP POST URL: `https://your-api-domain.com/api/webhook/sendgrid`
3. Enable these events:
   - ✅ Delivered
   - ✅ Opened
   - ✅ Clicked
   - ✅ Bounced
   - ✅ Spam Reports
   - ✅ Unsubscribed

### 2. Subscription Tracking (Optional)

SendGrid has built-in subscription tracking, but our custom implementation gives you more control.

If you want to use SendGrid's tracking:
1. Go to Settings → Tracking → Subscription Tracking
2. Enable it and customize the text
3. Our webhook will still catch these events

## How It Works

### When Sending Campaigns

1. **Filtering**: Only contacts with `unsubscribed = false` are fetched
2. **Token Generation**: Each contact has a unique `unsubscribe_token`
3. **URL Replacement**: `{{unsubscribe_url}}` is replaced with:
   ```
   https://yourdomain.com/unsubscribe?token=abc123...
   ```
4. **Headers Added**: List-Unsubscribe headers for one-click unsubscribe
5. **Personalization**: Other merge tags (first_name, email) also replaced

### When Someone Unsubscribes

**Method 1: Click Unsubscribe Link**
1. User clicks link in email → Taken to `/unsubscribe?token=...`
2. Public page shows their email and confirms action
3. Click "Unsubscribe" → Database updated with:
   - `unsubscribed = true`
   - `unsubscribed_at = current timestamp`

**Method 2: One-Click (Email Client)**
1. User clicks "Unsubscribe" in Gmail/Outlook header
2. SendGrid processes it → Sends webhook event
3. Our API receives event → Updates contact in database

### Viewing Unsubscribe Status

In the **Contacts** page, you'll see:
- 🟢 **Subscribed** badge (green) - Can receive emails
- 🔴 **Unsubscribed** badge (red) - Excluded from campaigns

## Testing the System

### 1. Test Unsubscribe Link

```javascript
// In browser console or Node.js
const token = 'your_contact_token_from_database'
const url = `http://localhost:5173/unsubscribe?token=${token}`
console.log(url)
// Visit this URL to test
```

### 2. Test Email Sending

Before sending to real contacts:
1. Create a test contact with your own email
2. Create a simple campaign
3. Verify the unsubscribe link works
4. Check that the link format is correct

### 3. Test Webhook

Use SendGrid's Event Webhook test feature:
1. SendGrid Dashboard → Event Webhook → Test Your Integration
2. Send test events
3. Check that analytics_events table receives data

## API Utilities

### Generate Unsubscribe URL (Frontend)

```typescript
import { generateUnsubscribeUrl } from './lib/unsubscribe'

const url = generateUnsubscribeUrl(contact.unsubscribe_token)
// Returns: https://yourdomain.com/unsubscribe?token=abc123...
```

### Replace Merge Tags

```typescript
import { replaceMergeTags } from './lib/unsubscribe'

const personalizedHtml = replaceMergeTags(template.html_content, {
  email: contact.email,
  first_name: contact.first_name,
  last_name: contact.last_name,
  unsubscribe_url: generateUnsubscribeUrl(contact.unsubscribe_token)
})
```

### Check for Unsubscribe Link

```typescript
import { hasUnsubscribeLink } from './lib/unsubscribe'

if (!hasUnsubscribeLink(template.html_content)) {
  alert('Warning: Template is missing unsubscribe link!')
}
```

## Legal Compliance

### CAN-SPAM Act (US)
✅ Unsubscribe link in every email
✅ Honor unsubscribe within 10 days (instant in our system)
✅ Physical address in footer (add to your templates)

### GDPR (EU)
✅ Easy unsubscribe process
✅ Unsubscribe data stored with timestamp
✅ No emails sent to unsubscribed contacts

### CASL (Canada)
✅ Unsubscribe mechanism in every email
✅ Honored immediately

## Troubleshooting

### Unsubscribe link not working
- Check that migration 002 was run in database
- Verify contact has `unsubscribe_token` (should auto-generate)
- Check BASE_URL in .env matches your domain

### Contacts still receiving emails after unsubscribe
- Verify `unsubscribed` field is `true` in database
- Check campaign filtering in api/server.js line 79
- Ensure webhook is configured in SendGrid

### Merge tags not being replaced
- Check that template HTML uses `{{tag_name}}` format (double curly braces)
- Verify api/server.js lines 112-116 for replacement logic
- Test with simple HTML first

## Next Steps

1. ✅ Run database migration
2. ✅ Add BASE_URL to .env
3. ✅ Update email templates with unsubscribe links
4. ✅ Configure SendGrid webhook
5. ✅ Test with a few contacts
6. ✅ Monitor analytics for unsubscribe events

## Support

If you encounter issues:
1. Check browser console for errors
2. Check API server logs
3. Verify SendGrid webhook is receiving events
4. Check Supabase database for updated records
