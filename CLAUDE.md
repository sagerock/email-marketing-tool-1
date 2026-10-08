# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SageRock Email Marketing Tool - A multi-tenant email marketing platform with contact management, campaign builder, automation sequences, and analytics. Live at https://mail.sagerock.com

**CfA campaigns are Caitlin's (Sage, 2026-09-28).** Starting 2026-10-01, every Center for Anthroposophy email campaign goes through Caitlin Rooney (request form or communications@centerforanthroposophy.org). Never send, schedule or build a CfA campaign here, or in Constant Contact, at anyone else's request. Point them to Caitlin. Details: `sagerock/clients/center-for-anthroposophy/CLAUDE.md`.

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

### Ask / Polaris Email Design Drafts

`POST /api/ask/email-design-drafts` lets SageRock's internal Ask agent create
an email design in the SageRock template library. It uses a dedicated bearer
secret and a server-configured `ASK_EMAIL_DESIGN_CLIENT_ID`; the request cannot
select another tenant. The endpoint generates through the platform's existing
Claude email-builder rules and brand/reference templates, validates required
CAN-SPAM tags and passive email-safe HTML, and inserts only a template. It has
no campaign, recipient, schedule, or send path. `Idempotency-Key` is embedded
as a hidden template marker so inbound retries reuse the first draft.

`sourceTemplateId` requests a revision of an existing SageRock template. The
builder loads that tenant-scoped source and saves the result as a new template;
the source stays intact. Since 2026-10-07 (migration 110) every new version records
`templates.source_template_id` (builder "Save a new version" and Polaris revisions), and a
revision follows that chain to the most recently updated descendant before editing, so an older
review link still revises the newest version (`requested_source_template_id` in the response is
the one asked for). Responses include `preview_html`, with personalization
shown as placeholders and the unsubscribe action disabled. Ask carries this
HTML outside the model context into its normal threaded reply to the requester.
Rocky can request a newsletter from `rocky@sagerock.com` by emailing
`polaris@ask.sagerock.com`, then reply with edits. Gmail access is not enabled.

The draft endpoint also accepts `attachedHtml` (up to 500,000 characters) and
`attachmentImages` (up to six image records under `sagerock/email-drafts/`). Ask
reads selected inbound HTML files and re-encodes PNG/JPEG/WebP attachments before
uploading their pixels to SageRock's media library. HTML is builder input only,
never published directly. Relative/CID image links are resolved from the selected
attachments. The generated draft still passes the existing passive-HTML checks.

Review links retain their destination through sign-in. The builder resolves the
draft's owning client using the user's RLS-scoped template lookup, switches to an
accessible client, and shows an explicit loading/error state instead of silently
leaving the preview empty. `scripts/test-newsletter-review.cjs` exercises this
flow in Chromium with mocked authentication and data (see its build command).

### Brand Story

Each client can tell its own story at `/brand-story` (since 2026-10-07, migration 109):
free-text `clients.brand_story` plus an optional `clients.brand_look` jsonb (logo URL from
Media, up to eight named colors, fonts, website). `api/brand-story.js` validates input and
builds the prompt block that both the interactive builder (`/api/email-builder/chat`) and
Polaris drafts (`ask-email-design.js`) include on every generation. The story sets voice and
feel; a `brand_reference_template_id` email still wins on layout. Reads and writes go through
`GET/PUT /api/brand-story`, because clients-table RLS only lets super admins update. "Interview
me" (`POST /api/brand-story/interview`) asks a few questions and returns a draft the user edits
before saving; the model may suggest colors and fonts but never a logo URL. Browser test:
`scripts/test-brand-story.cjs`. Alderbrook (sample) was seeded from Sage's first builder chat.

### Builder edits are targeted, not full rewrites

Since 2026-10-07 the interactive builder (`/api/email-builder/chat`) sends the design in the
preview once per request as `currentEmail`, attached to the newest user turn after its cache
breakpoint; earlier designs are dropped from history (`[email design output omitted]`). For
changes, the model returns FIND/REPLACE pairs in an ```edits block (format and rules in
`api/email-builder-edits.js`); new emails and redesigns still come back as the full ```json
block. The server applies edits (exact match, then whitespace-tolerant, always unique) and
sends a `result` SSE event with the finished design. If any edit can't be applied, it asks the
model once for the full email; if that fails too, the preview stays unchanged. Logs show
`[email-builder] applied N targeted edit(s)` or `targeted edit failed`. Polaris revisions
(`sourceTemplateId`, no attached HTML) use the same edits since 2026-10-07 and fall back to a full
regeneration if they don't apply or fail validation (`[ask-email-design] revision via ...`). Tests: `api/email-builder-edits.test.js`, `scripts/test-builder-edits.cjs`.

Model and media (2026-10-07): the builder and the Brand Story interview run on Claude Sonnet 5.5
(`api/email-builder-model.js`: effort `medium` for the builder, `low` for the interview,
64K max tokens since thinking counts toward it, server-side refusal fallback). Override with
`EMAIL_BUILDER_MODEL` / `EMAIL_BUILDER_EFFORT` on Railway to roll back without a deploy (set the
model to `claude-sonnet-4-6`; fallbacks are only sent for 5.5). Polaris uses the same model setting
and media library since 2026-10-07: on 5.5 a full draft comes back via structured output
(`output_config.format` JSON schema) because 5.5 rejects a forced `tool_choice`; rolled back to 4.6
it uses the forced tool again. Real-model check before shipping: revision 5s (4 edits), new draft
24s, both well under Ask's 150s timeout. The builder also attaches the client's 24 newest Media
uploads (`api/builder-media.js`) to the first user message as 320px thumbnails labeled with exact
URL and full size, cached in memory by key + ETag; the model picks images by what it sees and never
invents URLs. Verified against the real model on Alderbrook before shipping.

Click-to-edit (2026-10-07): the preview (`src/components/builder/SelectablePreview.tsx`) lets
the user click part of the email. `src/lib/emailSections.ts` scans the HTML source for selectable
elements and their exact source spans; only the preview copy gets `data-sr` markers, never the saved
HTML. First click selects the section (outermost block under the ~600px body that's under 60% of
its height), each further click drills into a smaller piece. The request sends `selection: {start,
end, label}`; the server adds a `<selected_part>` after `<current_email>`, requires every FIND to
lie inside the span (uniqueness is checked within it), retries once with corrected edits rather
than a full rewrite, and returns the shifted span so the selection persists. A global request
while a part is selected gets no edits and a suggestion to clear the selection. Browser test:
`scripts/test-click-to-edit.cjs <email.html>...` (pass real templates, e.g. Alderbrook + the Scoop).

Ready to send? (2026-10-07): `src/lib/emailChecks.ts` checks the builder's current email on
every change (pure, in the browser) and `ReadyToSendPanel` shows the count in the preview toolbar.
Errors: missing unsubscribe tag, no mailing address (the tag or a typed US postal address both
pass, e.g. the Scoop footer), no subject, links to `#`/empty/`javascript:`/non-URL/placeholder
domains/non-URL merge tags, images with no or relative src, unfilled `{{PLACEHOLDER}}`s (link
targets are reported per link instead), filler text. Warnings: no preview text, http links, no alt,
no width, WebP, `font-size:0` on an image cell, flex/grid, over Gmail's ~102 KB clip. Repeats are
grouped. "Fix it" sends the issue's `fixPrompt` scoped to its element via click-to-edit; "Fix it…"
selects the element and pre-fills the chat (e.g. "Change this link to: "). The header CAN-SPAM
warning reads from the same checks. Browser test: `scripts/test-ready-to-send.cjs <email.html>`.

Link health and visual check (2026-10-07): `POST /api/email-builder/check-links` checks whether
each link loads (`api/link-check.js`): public addresses only, enforced in the connection's own DNS
lookup (no rebinding), redirects followed by hand with each hop re-checked, ports 80/443 only,
HEAD then GET, 8s timeout, 40 URLs max, 10-minute cache. Only clear failures (404/410, no such
site, refused) become errors; bot-blocking 403s, 5xx and timeouts are not reported. After each
builder change the frontend calls `POST /api/email-builder/visual-check`: `api/visual-check.js`
renders the email in headless Chromium with JavaScript off and only public images, stylesheets and
fonts allowed, slices it into up to five 640x1000 JPEGs, and asks the model (low effort,
structured output) whether the requested change is visible and anything looks broken. The verdict
shows under the chat message with a "Fix these" button; it is advisory and never edits on its own.
Rate limit 20/min, 2 at a time. Real-model check: it confirmed a correct change, caught a
claimed-but-missing change and a broken image, in 4-7s. Structured output needs Sonnet 5.5, so with
the 4.6 rollback the check reports unavailable and the UI shows nothing.

Preview width (2026-10-07): the desktop preview frame is a fixed 620px and never shrinks, so a
600px mobile breakpoint can't fire on a laptop (at 1280px the old 45/55 split squeezed it to 496px
and Rocky's newsletter columns stacked). The chat pane is 38% (340-520px) and "Hide chat" in the
preview toolbar gives the preview the whole width. Browser test: `scripts/test-preview-width.cjs <email.html>`.

One Save button (2026-10-07): for an existing design, Save updates it in one click with its current
name, subject and preview text (no form) and is off when nothing changed. Its ▾ menu holds "Save as a
new version…" (keeps the original, records `source_template_id`) and "Rename or edit subject…". A
brand-new design's Save opens the name/folder form. Rocky found the old "Save changes" + "Save a new
version" pair, with a second "Save draft" inside the form, confusing. Browser test:
`scripts/test-save-button.cjs <email.html>` (and `test-newsletter-review.cjs`).

Autosave (2026-10-08): two seconds after the email settles, the builder saves in the background
(chat stays usable; status reads "Saving…" then "All changes saved"). An existing design is updated
in place, so "Save as a new version…" is how to branch a copy; a new email is created under its
subject once the user has sent a message (opening a starter alone doesn't create a draft). A failed
autosave shows an error and isn't retried until the email changes again. Same browser test.

Attachments in the chat (2026-10-08): the paperclip (or drag-and-drop / paste on the chat panel)
attaches up to six images or PDFs per message; the clock icon is the old "reference a previous
email". Each file uploads to the client's media library right away (`POST /api/media/upload`, which
now also takes PDFs, stored as-is after a `%PDF-` check); Send waits for uploads. A message carries
only `{key, name}`; `api/builder-attachments.js` keeps keys under the client's `s3_prefix`, reads them
back from S3, and adds them to that message: images as a 1000px view, PDFs as a `document` block,
each labeled with its exact public URL to show or link. Media lists PDFs as tiles. Real-model check:
read a flyer PDF's date, address and RSVP date, used both exact URLs, invented none, 5.5s. Tests:
`api/builder-attachments.test.js`, `scripts/test-chat-attachments.cjs <image> <pdf> <other file>`.

Typing in the preview (2026-10-08): double-click text in the preview to type over it; Enter or
clicking away keeps it, Esc cancels. Only elements whose content is text plus inline formatting
(`isTextEditable` in `src/lib/emailSections.ts`) are editable, as `contenteditable="plaintext-only"`.
`applyTextEdit` writes back into that element's source span: if the text nodes still line up with the
source text runs (entities decoded), only the changed runs are rewritten, so formatting, links,
entities and merge tags stay byte-for-byte; otherwise the element's inner HTML is rebuilt from the
edited preview (markers stripped). If no closing tag is found, nothing changes and the preview says to
ask in the chat. Edits go into the current email, so autosave and the AI's next turn both see them.
Browser test: `scripts/test-inline-edit.cjs <email.html> "<headline>" "<paragraph start>"` (passes on
the October SageRock newsletter and the August Scoop).

Stock photos (2026-10-08): Adobe's Stock API has been Enterprise-only since Nov 2024 (Sage's plan isn't), so
the tool can't search or license for him. "Stock photos" in the preview toolbar (`StockPhotosPanel.tsx`)
sends the email's images (alt, src, size, nearby text; `src/lib/stockPhotos.ts`) and plain text to
`POST /api/email-builder/stock-ideas` (`api/stock-ideas.js`, low effort, structured output, brand story
included). The model suggests up to three Adobe Stock searches per photo, skips logos, icons and other
graphics, and may suggest up to three places for new photos. Each search is a link to
`stock.adobe.com/search/images?k=…&filters[content_type:photo]=1&filters[orientation]=…` (Adobe's bot
protection blocks automated checks, so the filter format comes from public examples). "Use a new photo
here" selects that exact `<img>` and pre-fills the chat, so the licensed file dropped in replaces only that
image. Real-model check: October newsletter and August Scoop, 4-5s, sensible searches, skipped the logos,
the book cover, the 80th-anniversary badge and social icons. Tests: `api/stock-ideas.test.js`,
`scripts/test-stock-photos.cjs <email.html> <photo>`.

Free photos in the same panel (2026-10-08): a "Free photos from: Unsplash | Pixabay" switch, and each suggested
search loads 12 results inline (`POST /api/stock/:source/search`, `/use`). Clicking one on an image row swaps it
straight into that `<img>` (`setImageSource` in `src/lib/stockPhotos.ts`: only `src` changes, `alt` filled only if
empty; no AI call), adds a "Swapped in a photo by …" chat message (so earlier previews can be restored) and
autosaves; on a new-photo idea or the free search box, the URL goes into the chat for the AI to place.
- Unsplash (`api/unsplash.js`, `UNSPLASH_ACCESS_KEY`, app 1096628 "SageRock Email Tool", demo tier 50 requests/hour;
  production (1,000/hour) applied for 2026-10-08, see `docs/unsplash-production-application/`): their rules require hotlinking, so the email uses `images.unsplash.com` with `fm=jpg`
  and, when the slot has both sizes, `fit=crop` to its shape at 2x. Choosing a photo pings its
  `download_location`; Unsplash+ photos are filtered out; credits link with `utm_source=sagerock_email_tool`.
- Pixabay (`api/pixabay.js`, `PIXABAY_API_KEY`, 100 requests/min): their rules forbid permanent hotlinking and
  require 24-hour caching of searches, so a chosen photo is downloaded (1280px), cropped to the slot with
  sharp (`position: attention`, 2x, JPEG) and stored under the client's `s3_prefix` as
  `<ts>-pixabay-<id>-<tag>.jpg`; the email uses our S3 URL.
Both keys live in `/mnt/d/dev/.env` and on BOTH Railway services: "frontend" serves mail.sagerock.com and its
same-origin `/api` (what users hit), "backend" serves api.mail.sagerock.com. A key on only one service fails silently
for the other (on 2026-10-08 the panel said "Free photo search isn't set up yet" until frontend got the keys). Real check: a Pixabay pick was cropped to a
510x293 slot as a 1020x586, 56 KB JPEG in 0.3s; an Unsplash pick came back as a 1020x586 JPEG.
Tests: `api/unsplash.test.js`, `api/pixabay.test.js`, same browser test.

### Media uploads are resized

Since 2026-10-07, `POST /api/media/upload` runs every image through `api/image-optimize.js`
(sharp) before storing it: longest side ≤ 1200px, EXIF orientation baked in, metadata/GPS
stripped, recompressed. Opaque photo PNGs become JPEG and WebP becomes JPEG/PNG (classic
Outlook can't show WebP); transparent PNGs stay PNG; animated GIFs and already-small images are
stored untouched. Upload limit is 25 MB. If sharp fails to load, uploads fall back to the
original file. `scripts/optimize-media-library.mjs` shrinks files already in the library in
place (same key and format, so sent emails keep working), backing originals up to
`_originals/<key>`; `--restore` puts them back. Ran 2026-10-07: 9 files, 3.5 MB → 1 MB.

### Public List Signups

`POST /api/public/list-signup` (body: `email`, optional `first_name`, `list`) lets a
public page add someone to a named list on the `PUBLIC_SIGNUP_CLIENT_ID` client
(SageRock). Lists are allowlisted in `api/public-list-signup.js`; each maps to contact
tags. The endpoint only tags the contact. Welcome mail comes from an `email_sequences`
row with `trigger_type = 'tag_added'` on the list's first tag, created in the UI. Existing
contacts keep their name and unsubscribe status. Current list: `law-firm-workspace`
(sagerock.com/law-firm-workspace). To add one, add an entry to `PUBLIC_LISTS`.

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

### Google Search Console Warehouse

Search Console reporting is stored by client in `search_console_site_daily` and
`search_console_query_page_daily`. The service-role-only
`search_console_credentials` table holds encrypted, read-only OAuth credentials;
normal authenticated users cannot select that table. When `RUN_SCHEDULER=true`,
the server syncs finalized data daily at 07:15 UTC and re-fetches a seven-day
window to repair Google's late revisions.

Operational commands:

```bash
node scripts/apply-search-console-migration.mjs          # read-only check
node scripts/apply-search-console-migration.mjs --apply  # install migration 090
node scripts/search-console-auth.mjs url                 # begin read-only OAuth
node scripts/search-console-auth.mjs code URL --install  # encrypt/install token
node scripts/search-console-sync.mjs --start=YYYY-MM-DD --end=YYYY-MM-DD
```

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

### Salesforce Prospect Activities (Alconox website touches)

Alconox's site writes one `Prospect_Activity__c` per touch (member resource downloads,
AI chat, web forms, sample requests) linked to the Lead/Contact. Since 2026-09-22,
`api/salesforce-prospect-activities.js` syncs them into `salesforce_prospect_activities`
(migration 101) during the manual and daily sync, after Leads/Contacts. Resource
downloads tag the contact `Resource Download` plus `Downloaded: <resource>`. Each run
also compares the download campaign's members ("Resource Download 2026") with the
activity rows and logs anyone missing. Orgs without the object are skipped.

**Downloads feed the AI follow-up agents** (`api/ai-followup-downloads.js`, migration
102, since 2026-09-22). alconox.com replaced its Gravity download forms with
member-download pages on 2026-09-19, so the White Paper and Aqueous Cleaning Handbook
agents stopped enrolling. Now each new `Resource Download` activity enrolls the contact
through the same enroll + generate path the Gravity webhook uses: `Source_Detail__c`
`Aqueous Cleaning Handbook` goes to the Handbook agent, anything else to the White Paper
agent (`ai_followup_config.trigger_download_resource`, `'*'` = catch-all). The
activity's `Web_Page__c` becomes the enrollment's `resource_url`, which the generate
endpoint uses as the approved link. Each activity row is processed once
(`followup_processed_at` + enrollment id or skip reason); only touchpoints after the
agent's `download_trigger_since` cutover enroll, and `@alconox.com` addresses, contacts
tagged `Alconox Internal`, unsubscribed, and hard-bounced contacts are skipped. Runs
after every Salesforce sync plus an hourly download-only refresh at :20.

```bash
node scripts/apply-ai-followup-download-migration.mjs --apply   # install migration 102
node scripts/ai-followup-downloads.mjs status                    # agents, cutover, pending rows
node scripts/ai-followup-downloads.mjs dry-run                   # decisions, no writes
node scripts/ai-followup-downloads.mjs enable                    # cutover = now (go live)
node scripts/ai-followup-downloads.mjs disable                   # bridge inert again
```

**AI Chat cases feed a review-first agent** (`api/ai-chat-followups.js`, migration 103,
since 2026-09-22). The website AI chat lands in Salesforce as a Closed Case with
`Case_Origin_Subtype__c = 'AI Chat'` and the transcript in `Description`. The sync stores
cases in `salesforce_ai_chat_cases` with the IP line stripped before storage. Each new case
enrolls the person once (`ai_followup_config.trigger_ai_chat`, gated by
`chat_trigger_since`; same internal/test exclusions as downloads, plus
`cloudadoptionsolutions.com`) in the Alconox "AI Chat Follow-up" agent: one very general
email, no technical content, Ask Alconox CTA, reply-to `cleaning@alconox.com`,
`auto_send=true` since 2026-09-23 (Michelle Modica: "No approvals needed going forward";
Sage agreed). The model only ever sees what the visitor typed, never the bot's answers.
Drafts now send on generation; a draft only stays pending if the auto-send fails, and then
reviewers in `review_notify_emails` get an email per draft (draft, transcript, case number)
with a personal signed link to `/api/ai-followup/review/:draftId`; that page shows the
draft and two POST buttons, Approve and send / Skip. GET never sends (mail scanners click
links). Runs with the download bridge: after each Salesforce sync and hourly at :20.

```bash
node scripts/apply-ai-chat-migration.mjs --apply     # install migration 103
node scripts/ai-chat-followups.mjs status            # agent, cutover, cases, recent drafts
node scripts/ai-chat-followups.mjs sync [--all]      # pull cases from Salesforce
node scripts/ai-chat-followups.mjs dry-run           # enrollment decisions, no writes
node scripts/ai-chat-followups.mjs enable|disable    # cutover on/off
node scripts/ai-chat-followups.mjs reviewers a@x,b@y # who gets review emails
node scripts/ai-chat-followups.mjs notify [--only=email] [--dry-run]
```

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

### Describe who should get it (2026-10-08)

The campaign form's Target Recipients box starts with "Describe who should get this"
(`src/components/AudienceFromText.tsx`). `POST /api/campaigns/audience-from-text` (`api/audience-from-text.js`)
loads the client's tags (paged, with contact counts; empty tags aren't offered) and Salesforce campaigns, takes
WooCommerce products from the form, and asks the builder model (low effort, structured output, so it needs
Sonnet 5.5) for the existing filters. Every tag, campaign id and SKU is checked against the real lists. The form
fills in, the live count re-runs, and the user sees a plain explanation, an amber "Not included" line for
anything the filters can't do (opens, clicks, location, NOT, OR across groups), and an undo. It never saves or
sends. The model is told to include every matching tag rather than silently widening the audience, and that
"Campaign: <name>" tags mirror Salesforce campaigns (that's how to reach several Pittcon years at once).
Real-model checks on Alconox (1,465 tags, 156 campaigns, 2-4s each): handbook downloaders → the
"Downloaded: Aqueous Cleaning Handbook" tag (5); Pittcon customers → all six "Campaign: Pittcon" tags +
customers (47); Pittcon 2026 dealers → that SF campaign + dealers; "leads who opened lately" → leads plus a
"can't filter opens" warning. The form's tag list is now paged too (it stopped at 1,000, hiding 465 Alconox
tags). Tests: `api/audience-from-text.test.js`, `scripts/test-audience-from-text.cjs`.

### Click Heatmap Report

Analytics → Click Heatmap → Download PNG / PDF calls `GET /api/campaigns/:id/heatmap-report?clientId=&format=png|pdf`
(since 2026-10-07). `api/heatmap-report.js` renders the campaign's template in the locked-down headless
Chromium (no JS, public images only), measures each link, and draws a one-page report: campaign name,
subject, send date; Sent / Delivered / people who clicked (`get_campaign_unique_clicks` engaged, bot-filtered)
/ click rate; the email with each link shaded by unique clicks and a rank badge; a ranked link table (share
of clickers, "N places in the email" when one URL appears several times); a color key. Clicks match links
exactly after dropping UTM tags, host case, `www.` and a trailing slash (no substring matching). Clicks on
URLs no longer in the template (it was edited after sending) are listed as such, never misattributed. The
campaign must belong to the requesting client. If the server report fails, the PNG button falls back to the
older browser-side image. The unrestricted `/api/screenshot` endpoint was removed the same day (unused since
March). First real run: September 2026 Scoop, 5s PNG / 4s PDF.

### Bot Click Filtering

Email security scanners (Barracuda, Proofpoint, Mimecast, etc.) automatically click all links in emails to check for malware. This creates inflated click stats that don't represent real human engagement.

**Bot Detection Rules (applied at webhook ingestion in `api/server.js`):**
1. **Rapid multi-click**: 3+ unique URLs clicked within 10 seconds = bot
2. **No prior open**: Click events with no corresponding open event = bot
3. **High click-to-open ratio**: 10+ clicks per open = bot

**How it works:**
- Webhook handler tracks recent clicks per email in memory (with TTL cleanup)
- Bot clicks are silently discarded, not stored in `analytics_events`
- Known bot emails are cached to skip future clicks from same sender

**Analytics Display:**
- **SendGrid Reported**: Raw stats from SendGrid API (includes bot activity)
- **Verified Human**: Filtered webhook stats (bot activity removed)
- When both are available, Analytics page shows side-by-side comparison
- Older campaigns (sent before category tracking) show only filtered stats

**Cleanup Scripts (in `api/` directory):**
- `cleanup-bot-clicks.js` - One-time cleanup of historical bot clicks
- `recalculate-engagement.js` - Recalculate contact engagement scores from events

## Key Files

- `src/contexts/AuthContext.tsx` - Authentication state management
- `src/context/ClientContext.tsx` - Multi-client state management
- `src/lib/supabase.ts` - Supabase client initialization
- `src/lib/utils.ts` - Utilities: `cn()` (class merging), `formatDate()`, `formatDateTime()`
- `api/server.js` - Express backend with SendGrid and Salesforce integration
- `supabase/baseline/` - Replayable schema snapshot; follow its README, then apply post-baseline migrations
- `supabase/migrations/` - Incremental schema changes and scoped production migration sources

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
AWS_ACCESS_KEY_ID=         # IAM user with PutObject/DeleteObject/ListBucket on sagerock-email-images
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-2
S3_MEDIA_BUCKET=sagerock-email-images
ASK_EMAIL_DESIGN_API_KEY=  # Shared only with Ask/Polaris
ASK_EMAIL_DESIGN_CLIENT_ID= # Fixed SageRock clients.id; caller cannot override
```

Note: SendGrid API keys and Salesforce credentials are stored per-client in the `clients` database table, not in environment variables.
