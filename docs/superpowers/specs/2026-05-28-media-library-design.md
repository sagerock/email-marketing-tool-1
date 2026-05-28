# Media Library Design

**Status:** Draft — awaiting user review
**Date:** 2026-05-28

## Problem

When composing a campaign or sequence email, users have no way to discover and reuse images that have been used in past emails. The current workflow is "remember the URL or hunt through old templates." For a tradeshow follow-up, the user knows there's a standard Alconox header image somewhere but can't easily find it.

Images already exist in two places:

- S3 bucket `sagerock-email-images` (us-east-2), partly under clean per-client folders (`alconox/social/*.png`) and partly under Stripo-generated paths (`guids/CABINET_<hash>/images/*`) that aren't tied to any client.
- External hosts referenced from past templates (e.g. `alconox.com/wp-content/...`).

## Goals

1. Per-client browsable library of images that have been used or uploaded.
2. Upload new images directly to the per-client S3 prefix without leaving the app.
3. Surface images from past templates and campaigns, including S3-hosted Stripo images and externally hosted images, so users can find that "trade-show header" without remembering the URL.
4. One-click copy of the public URL for pasting into HTML.

## Non-goals

- Image resize / crop / on-the-fly transformations.
- Folders, tags, alt-text editing.
- Re-hosting externally referenced images.
- Auto-insert at cursor in the email builder.
- Migrating legacy `guids/CABINET_*` paths into per-client folders.
- Usage tracking beyond the initial scan.

## Approach

S3 is the source of truth for uploaded images. We do not maintain a parallel `media_assets` table for S3 objects — listing them on demand avoids drift. A small table tracks discovered URLs (since scanning template/campaign HTML is expensive to repeat). Per-client isolation is enforced by an `s3_prefix` column on `clients` and server-side guards on delete.

### Data model

**`clients`** — add one column:

```sql
ALTER TABLE clients ADD COLUMN s3_prefix TEXT;
```

- Lowercase, URL-safe slug. Used as the S3 key prefix for that client (`{s3_prefix}/...`).
- Backfilled manually for existing clients (Alconox → `alconox`, etc.).
- Required for upload/delete to work; UI shows a "Set up media library" notice if null.

**`discovered_media_urls`** — new table:

```sql
CREATE TABLE discovered_media_urls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT,                  -- last path segment, used for search
  first_seen_in TEXT,             -- 'template:<uuid>' or 'campaign:<uuid>' — first place we saw it
  last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, url)
);

CREATE INDEX idx_discovered_media_urls_client ON discovered_media_urls (client_id);
```

RLS: enabled with `FOR ALL USING (true)` — matches the existing project pattern (see `salesforce_campaigns`, `industry_links`, etc.). There is no `user_clients` table; per-client isolation is enforced at the application/API layer via `client_id` filtering in every query.

### Backend (`api/server.js`)

New dependency: `@aws-sdk/client-s3` (already in stack indirectly via Supabase, but add explicitly for clarity).

New env vars (Railway):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION=us-east-2`
- `S3_MEDIA_BUCKET=sagerock-email-images`

Endpoints:

**`GET /api/media?client_id=X`** — returns merged list of S3 objects and discovered URLs.

1. Look up `s3_prefix` for the client. If null, return `[]` with a flag `needs_setup: true`.
2. `ListObjectsV2(Bucket, Prefix=s3_prefix + '/')`, follow continuation tokens until done (cap at 2000 objects for safety; log a warning if hit).
3. Filter out objects whose **basename** (last path segment) starts with `stripothumbnailurl` — these are Stripo's auto-generated thumbnails of originals also present in the bucket. Keep originals only.
4. Construct public URL as `https://{bucket}.s3.{region}.amazonaws.com/{key}`.
5. Query `discovered_media_urls` for the same `client_id`, exclude any URL whose host+path matches an S3 object already returned in step 2 (dedupe).
6. Return array:
   ```ts
   [{
     key: string,          // S3 key, or "" for discovered
     url: string,
     filename: string,
     size: number | null,  // null for discovered (we don't fetch HEAD)
     last_modified: string | null,
     source: 's3' | 'discovered'
   }]
   ```

**`POST /api/media/upload`** — multipart upload.

- `multer` memory storage (file size limit 5MB enforced by multer config).
- Validate `mimetype` ∈ {`image/png`, `image/jpeg`, `image/gif`, `image/webp`}.
- Sanitize filename: `path.basename(originalname).toLowerCase().replace(/[^a-z0-9.-]/g, '-')`.
- Key: `{s3_prefix}/{Date.now()}-{safe_filename}`.
- `PutObject` with `ContentType` from mimetype. Bucket already has public-read policy on objects; no explicit ACL needed.
- Return `{ url, key }`.

**`DELETE /api/media?key=...`** — delete a single S3 object.

- Look up client's `s3_prefix`.
- Reject if `key` does not start with `{s3_prefix}/`. Return 403.
- `DeleteObject`. Return 204.
- Discovered URLs cannot be deleted via this endpoint (no S3 key); separate row delete on `discovered_media_urls` if we want that later.

**`POST /api/media/scan`** — scan templates and campaigns for image URLs.

1. Select all rows in `templates` and `campaigns` for the client_id where `html_content IS NOT NULL`.
2. For each row, extract image URLs with a regex: `/<img[^>]+src=["']([^"']+)["']/gi`. (Spec allows other formats like `srcset`, but per YAGNI we scan `src` only.)
3. Deduplicate URLs across the result set.
4. For each unique URL, derive `filename` from the last path segment (strip query string).
5. Upsert into `discovered_media_urls` keyed on `(client_id, url)` — update `last_scanned_at`, leave `first_seen_in` and `created_at` alone for existing rows.
6. Return `{ scanned: N, discovered: M }` where N is the row count examined and M is the count of fresh URLs added.

Scan is synchronous-blocking on the request (templates+campaigns are bounded; for Alconox ~hundreds of rows). If this turns out to be slow in practice we can move to a background job, but we will not pre-optimize.

### Frontend

**New route `/media`** — `src/pages/Media.tsx`.

Layout:

- Page title "Media Library" + brief sub-text.
- Top bar: search input (filters list by substring on `filename` and `key`), Upload button, "Scan past emails" button (shows a spinner while scanning, toast with result count).
- Grid of tiles (responsive, ~5 per row at desktop width).
- Each tile:
  - Thumbnail (`<img src={url}>` directly — works because of existing CORS rule for `https://mail.sagerock.com`).
  - Filename (truncated with title= for full).
  - Size in KB (if known) and last modified date (if known).
  - Source badge: subtle "S3" or "Discovered" label.
  - Hover overlay: "Copy URL" button, "Delete" button (Delete disabled for `source === 'discovered'`).
- Empty state when no images: shows upload CTA + Scan CTA.
- "Needs setup" state when `s3_prefix` is null: shows a message and a contact-admin instruction (no in-app form for setting `s3_prefix` — done manually in DB for now).

**New component `src/components/media/MediaPicker.tsx`** — modal version of the grid.

- Props: `open`, `onClose`, optional `onSelect(url)` callback.
- Renders the same grid + search but no upload/delete actions (read-only picker). If the user wants to upload, they go to `/media`.
- Click tile → calls `navigator.clipboard.writeText(url)`, fires `onSelect?.(url)`, closes modal, shows toast "URL copied to clipboard."

**Email Builder integration** — `src/pages/EmailBuilder.tsx`:

- Add an "Images" button to the editor toolbar (next to existing tools).
- Click opens `<MediaPicker open={true} ...>`. User picks an image, URL is now on their clipboard. They paste into the HTML editor.

**Nav** — add "Media" link in `src/components/Layout.tsx` top nav between existing items.

**React Query** — single hook `useMediaAssets(clientId)` in `src/hooks/useMediaAssets.ts`:

- `useQuery(['media', clientId], () => fetch('/api/media?client_id=' + clientId))`.
- Invalidated by upload and delete mutations.

### Error handling

- Upload failures (size, MIME, S3 error): toast with specific message, file stays unselected, no partial DB state.
- Delete failures (S3 error, prefix mismatch): toast with message, row stays in list.
- List failures: page shows error state with retry button; React Query handles retry automatically.
- Scan failures (DB error mid-loop): partial upserts are fine — `(client_id, url)` is unique and last_scanned_at refreshes on retry.
- The scan regex tolerates malformed HTML by design (it doesn't try to parse; just finds `src=`).

### Security

- Server-side prefix enforcement on delete: a client cannot delete another client's objects even if they guess a key.
- Multer 5MB cap (request-side) plus MIME allowlist (post-parse).
- Bucket already public-read; we do not change ACL or bucket policy.
- AWS credentials in env vars; not exposed to frontend.
- No signed URLs needed for reads (public bucket).

### Testing

- Manual E2E in dev: upload an image to a test client prefix, verify it appears in the grid, copy URL, verify it pastes correctly.
- Manual: scan an Alconox template, verify discovered URLs appear with "Discovered" badge.
- Manual: try to DELETE with a key under another client's prefix, expect 403.
- Manual: upload a 6MB file, expect rejection.
- Manual: upload a `.exe` renamed to `.png`, expect rejection (MIME check catches mismatched magic bytes? — multer reads the declared MIME from the request, which a client can spoof; this is acceptable risk because the bucket only serves what it has and we control upload. Documented as a known limitation.)

### Migration

```sql
-- 056_create_media_library.sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS s3_prefix TEXT;

CREATE TABLE IF NOT EXISTS discovered_media_urls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  filename TEXT,
  first_seen_in TEXT,
  last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, url)
);

CREATE INDEX IF NOT EXISTS idx_discovered_media_urls_client
  ON discovered_media_urls (client_id);

ALTER TABLE discovered_media_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on discovered_media_urls"
  ON discovered_media_urls FOR ALL USING (true);
```

Per-client isolation is enforced at the API layer (every endpoint filters by `client_id`), matching the existing project convention.

Manual post-migration step: set `s3_prefix` for existing clients (Alconox → `alconox`, etc.).

## Future enhancements (not in this spec)

- Resize on upload (sharp, generate 600px / 1200px variants).
- Folders or tags.
- Alt-text editor.
- Background scan job triggered by template/campaign save.
- Migrate `guids/CABINET_*` objects into per-client prefixes once we figure out which client owns each.
- Self-service `s3_prefix` setup in Settings.
