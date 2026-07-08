# Scope: Outlook auto-check for the AI Email Builder

**Status:** proposal / not built. Written 2026-07-08.
**Goal:** close the generate → verify loop so an email is checked against *real*
classic Outlook (the Word engine) before a human ever sees it — turning the
manual "send a test, wait for Michelle" cycle into an automated one.

## What already exists (the building blocks)

- **`scripts/outlook-preview.sh`** — renders any template UUID or HTML file
  through real desktop Outlook on the WSL+Windows host and writes page-by-page
  PNGs. Uses a `/PIM` no-email profile (can't send), captures via `PrintWindow`
  (no focus stealing). Already validated: it reproduced, then confirmed the fix
  for, the Scoop doubled-separator bug.
- **Pixel-analysis heuristics** — the PIL scans used during the Scoop fix detect
  full-width separator lines and their color; the basis of an automated pass/fail.
- **AI builder** (`/api/email-builder/chat`, `src/pages/EmailBuilder.tsx`) —
  streams complete HTML, saves to `templates`. Its system prompt is now hardened
  with the Word-engine rules (prevention); this doc covers detection.

## The core constraint

The harness needs **real Outlook + an interactive (unlocked) Windows desktop**.
Production runs on Railway (Linux, headless) — Outlook cannot run there. So the
check **cannot execute inline inside the prod request**. Any design must send the
render job to a machine that has Outlook. That is the whole architectural problem.

## Options

| # | Where Outlook runs | Pros | Cons |
|---|---|---|---|
| 1 | **The existing desktop**, via a job queue the desktop polls | Reuses the Outlook + harness we already have; ~zero new cost | Depends on the desktop being on/unlocked; async (~30–60s/render); one Outlook version |
| 2 | **Self-hosted Windows runner** in cloud (VM or Windows CI runner) with Outlook | Not tied to the desktop; schedulable | Windows/Office licensing, cost, upkeep — rebuilds a slice of Email on Acid; still one version unless you run several |
| 3 | **Email on Acid / Litmus API** | Zero infra; dozens of real client/version combos | Paid, per-test metered; external dependency |

## Recommended phased path

**Phase 0 — prevention (DONE).** Word-engine hard rules baked into the builder's
system prompt so most of these bugs never get generated. Cheapest lever, already shipped.

**Phase 1 — on-demand check via the desktop (option 1).** A "Check in Outlook"
button in the builder. Human-triggered, async, reuses today's harness. Components:
- `outlook_check_jobs` table: `{ id, client_id, template_id|html, status, result_png_urls[], findings jsonb, created_at }`.
- `POST /api/email-builder/outlook-check` → enqueues a job, returns its id.
- **Desktop worker** (`scripts/outlook-check-worker.js`, long-running on the
  desktop): polls for `pending` jobs, runs `outlook-preview.sh`, uploads PNGs to
  the existing S3 bucket, writes `done` + screenshot URLs.
- Builder UI: button + poll for result, render screenshots inline in the chat.

**Phase 2 — automated verdict + self-correction.** Run the pixel heuristics on the
render (full-width gray line detection, doubled-hairline detection near section
seams) to produce a structured `findings` list. Feed findings back into the chat
as a system/tool turn so the AI can self-correct: e.g. *"Outlook shows a doubled
line at the Book→TechNote junction — replace that CSS border with the
conditional-comment divider."* This is what makes it a true closed loop.

**Phase 3 (optional) — breadth.** Swap or supplement the desktop worker with an
EOA/Litmus API call (option 3) when coverage across many Outlook versions /
clients matters more than the zero-cost of the desktop.

## Effort & risk

- Phase 1: ~1–2 days (jobs table + endpoint + desktop worker + button/poll UI).
- Phase 2: ~1 day (wire the existing PIL heuristics into a `findings` producer;
  add the feedback turn). Heuristics are approximate — treat as advisory, keep
  the screenshots as ground truth.
- Risks: **desktop availability** (Phase 1 is only as reliable as the desktop
  being up); **single Outlook version** (one machine = one version — covers the
  Word-engine bug class, not every client); **async latency** (~30–60s per render;
  the UI must be non-blocking).

## Explicit non-goals

- Not rebuilding Email on Acid's full device/client fleet.
- Not doing synchronous, in-request checks on Railway (impossible without Outlook).
- Not guaranteeing every client — the target is the Word-engine Outlook class,
  which is where the real, browser-invisible bugs live.
