# Unsplash production application (app 1096628)

**Submitted 2026-10-08 (status: In Review; Unsplash quotes 5-10 business days).** Until approval the app
runs on the demo tier (50 requests/hour); production is 1,000/hour. The app was renamed from "Email creation
tool" to "SageRock Email Tool" and given the description below. Unsplash's form has no separate questions,
only the name, description, a requirements checklist and screenshots.

The screenshots show Sage's account email and the October SageRock newsletter. Both are fine to
share, but crop them first if you'd rather not.

## Application name

SageRock Email Tool

## Description (what the app does)

SageRock Email is the email marketing tool SageRock uses to build newsletters for small schools,
nonprofits and businesses. While someone edits an email, a "Find photos" panel suggests searches for
each photo spot. It shows Unsplash results right in the panel, and one click puts the chosen photo
into that spot of the email.

## How the app follows the API guidelines

- **Hotlinking:** emails use the image URLs the API returns (`urls.raw` from images.unsplash.com,
  with Unsplash's own size and crop parameters for the photo spot). We never download or re-host
  Unsplash images.
- **Download tracking:** when someone picks a photo, our server calls that photo's
  `links.download_location` before the photo goes into the email.
- **Attribution:** every result in the panel shows the photographer's name, linked to their Unsplash
  profile, and "Unsplash", linked to the photo page. Both links carry
  `utm_source=sagerock_email_tool&utm_medium=referral`. The panel footer reads "Free photos from
  Unsplash" with a link to unsplash.com.
- **Not a competing service:** the panel only appears inside the email editor for signed-in SageRock
  users. It doesn't offer browsing, wallpapers or downloads, and we don't sell Unsplash photos.
- **Unsplash+:** premium photos are filtered out of results.
- **Caching:** searches are cached for an hour, so repeat searches don't call the API again.

## Expected use

A handful of people at SageRock and its clients, while building newsletters. Roughly 50 to 300 searches
on a busy day.

## Screenshots

1. `1-search-results-with-attribution.png` shows the Find photos panel with real Unsplash results,
   each credited to its photographer and Unsplash, and the footer credit.
2. `2-photo-in-email-hotlinked.png` shows the chosen photo in the email, loading from
   images.unsplash.com and cropped to the slot.

## Where this lives in the code

- `api/unsplash.js` handles search, the download ping, hotlinked URLs and the Unsplash+ filter.
- `src/components/builder/StockPhotosPanel.tsx` is the panel and its credits.
- `api/unsplash.test.js` and `scripts/test-stock-photos.cjs` are the tests.
