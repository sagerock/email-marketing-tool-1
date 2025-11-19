# Verified Senders Setup Guide

## Why This Matters

SendGrid requires **sender verification** to prevent spam. Any "from" email address used in campaigns must be verified in SendGrid first, otherwise your emails will be rejected.

This system enforces that requirement by:
1. Storing only verified sender emails in your client settings
2. Providing a dropdown (not free text) when creating campaigns
3. Preventing accidental use of unverified emails

---

## Step 1: Apply Database Migration

### Option A: Quick Copy & Paste (2 minutes)

1. **Go to Supabase SQL Editor:**
   https://supabase.com/dashboard/project/ckloewflialohuvixmvd/sql/new

2. **Copy and paste this SQL:**

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS verified_senders JSONB DEFAULT '[]'::jsonb;
```

3. **Click "Run"**

4. **Done!** The verified_senders field is now available.

### Option B: Use Migration File

If you have Supabase CLI installed:

```bash
supabase db push
```

This will apply `supabase/migrations/005_add_verified_senders.sql`

---

## Step 2: Verify Your Sender Emails in SendGrid

Before adding senders to the system, you must verify them in SendGrid:

1. **Go to SendGrid Dashboard:**
   https://app.sendgrid.com/settings/sender_auth/senders

2. **Click "Create New Sender"**

3. **Fill in your sender details:**
   - From Name: "Marketing Team" (or whatever you want)
   - From Email: "hello@example.com" (must be your domain)
   - Reply To: Same or different email
   - Company Address: Your physical address

4. **Verify the email:**
   - SendGrid will send a verification email
   - Click the link in that email
   - Wait for "Verified" status

5. **Repeat for each sender identity you need**

**Common sender emails to verify:**
- `hello@yourdomain.com` - Marketing
- `support@yourdomain.com` - Support/Service
- `news@yourdomain.com` - Newsletter
- `team@yourdomain.com` - General updates

---

## Step 3: Add Verified Senders to Your Client

1. **Go to Settings** in your app

2. **Click "Edit"** on your client

3. **Scroll to "Verified Sender Emails"**

4. **For each verified sender in SendGrid:**
   - Enter the **Sender Email** (must match SendGrid exactly)
   - Enter the **Sender Name** (what recipients see)
   - Click **"Add Sender"**

   Example:
   ```
   Sender Email: hello@example.com
   Sender Name: Marketing Team
   ```

5. **Click "Update Client"** to save

---

## Step 4: Create a Campaign with Verified Sender

1. **Go to Campaigns**

2. **Click "Create Campaign"**

3. **Under "From Sender"** - you'll now see a dropdown with your verified senders:
   ```
   Marketing Team <hello@example.com>
   Support Team <support@example.com>
   ```

4. **Select one** from the dropdown

5. **Continue creating your campaign as normal**

---

## What Happens If You Try to Use an Unverified Email?

If you add a sender to the system but haven't verified it in SendGrid:

- **Campaign creation:** ✅ Will work (no error)
- **Sending the campaign:** ❌ SendGrid will reject it with error:
  ```
  The from address does not match a verified Sender Identity
  ```

**Solution:** Always verify senders in SendGrid BEFORE adding them to the system.

---

## Troubleshooting

### "No verified senders configured"

**Problem:** You see this warning when creating a campaign.

**Solution:**
1. Verify at least one sender in SendGrid
2. Add it in Settings → Edit Client → Verified Sender Emails

### SendGrid rejects email: "does not match verified Sender Identity"

**Problem:** The email in your system doesn't exactly match SendGrid.

**Solution:**
1. Check SendGrid dashboard - what email is verified?
2. Make sure it matches EXACTLY (case-sensitive, no spaces)
3. Re-add the sender with the correct email

### I want to use multiple "from" addresses

**Solution:**
1. Verify each email separately in SendGrid
2. Add each one to your client's verified senders list
3. When creating campaigns, select from the dropdown

---

## Data Structure (for reference)

Verified senders are stored as JSON in the database:

```json
[
  {
    "email": "hello@example.com",
    "name": "Marketing Team"
  },
  {
    "email": "support@example.com",
    "name": "Support Team"
  }
]
```

This ensures:
- ✅ Only pre-approved emails can be used
- ✅ Consistent sender names across campaigns
- ✅ No typos in sender emails
- ✅ CAN-SPAM compliance (sender identification)
