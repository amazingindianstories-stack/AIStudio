# Spec: Precomputed Thumbnail + Blur-Placeholder Pipeline

## Background

A prior change (already shipped on `main`, commit `ea0d680`) added an on-the-fly
resize to `GET /api/media/[...path]` (`?w=` param, sharp, webp, immutable
caching) and wired grid/feed/canvas/asset thumbnails to request small widths
instead of full-resolution originals. That fixed the worst of it, but it has
a structural ceiling discussed with the user:

- The resize runs as **metered Vercel Function compute** on every cache miss.
  On the Pro plan, function compute (Active CPU / Provisioned Memory) has **no
  included free allocation** — it's billed from the first invocation, against
  the $20/mo credit and then on-demand. Full-res originals cost more in
  bandwidth; on-the-fly resize trades that for metered compute cost instead of
  eliminating the cost.
- Because `/api/media` requires a session cookie on every request, Vercel's
  shared edge cache generally won't cache the response across different
  users/sessions — so the same object at the same width can get re-resized
  more often than a truly cacheable asset would.
- There is currently **no image preview while a thumbnail loads** — grid/feed
  cards go straight from a loading skeleton to the full image with no
  perceived-load smoothing (no blur-up / LQIP), which is part of what "smooth
  experience" is asking for.

## Problem

The user asked for "a professional grade optimization solution which aims for
long term load minimization and efficiency and a smooth experience for the
user" as the natural next step beyond the on-the-fly resize.

## Desired behavior

Move thumbnail generation off the hot request path entirely: generate a small
thumbnail variant and a tiny blur placeholder **once, when an image generation
succeeds** (write time), store them, and have the client prefer the stored
variant — falling back to the existing on-the-fly `?w=` resize only when a
precomputed thumbnail isn't available yet (not-yet-backfilled rows, or a
generation whose thumbnail step failed). This is the same shape as the
existing `saveAvatarImage` resize-at-write pattern in `save-media.ts` — no new
dependency, sharp is already installed.

Additionally, render the blur placeholder as an instant paint that
cross-fades to the loaded thumbnail, removing the blank-then-pop flash on
grid/feed cards.

## Acceptance criteria

1. `generations` table gains two nullable columns: `thumbnailUrl` (small
   webp variant, stored object) and `blurDataUrl` (tiny inline base64
   placeholder, no storage round-trip needed to render it). Schema change
   lives in `src/lib/schema.ts`; applying it to Postgres is `npm run
   db:push` — **a production schema/data migration, run by the user, not by
   the council** (see Non-goals / Rollout below).
2. When an image generation (`kind: "image"`) succeeds — both the
   Higgsfield-MCP path and the Gemini/NBP path in
   `src/app/api/queue/execute/route.ts` converge on a single `url` before
   `done` is built — the route best-effort generates a ≤480px-longest-side
   webp thumbnail (quality ~75, matching the on-the-fly route's existing
   constants) plus a ~16px blur placeholder, uploads the thumbnail under a
   `thumbnails/` key prefix, and stores both on the row.
3. Thumbnail/blur generation failure must **never** fail, slow down past a
   trivial best-effort budget, or change the status of the parent generation
   request — matches the existing codebase convention of best-effort
   secondary steps with silent graceful fallback (e.g. `saveFromUrl` fallback
   in the video status route). A failed/skipped thumbnail just means the
   client falls back to on-the-fly resize for that item.
4. `GenerationItem` (`src/lib/types.ts`) and its DB mapping
   (`src/lib/store-db.ts` `rowToItem`/`itemToValues`) carry the two new
   optional fields end to end; API responses (`/api/history`,
   `/api/generate/image`, `/api/queue/execute`, `/api/generate/video/status`)
   include them without any route-specific special-casing beyond what
   `GenerationItem` already flows through.
5. `scripts/backfill-thumbnails.ts`: an idempotent, re-runnable script
   (follows the existing `scripts/` dotenv-loading convention) that finds
   `generations` rows with `kind = 'image'`, `status = 'succeeded'`, and
   `thumbnailUrl IS NULL`, generates + stores thumbnail/blur for each with
   bounded concurrency (4, matching the existing
   `MAX_CONCURRENT_CANVAS_IMAGES` precedent in `ImageNode.tsx`), logs
   progress, and continues past individual row failures rather than aborting
   the run. Safe to run repeatedly (already-backfilled rows are skipped).
6. `MediaCard.tsx` and `ConversationPanel.tsx` (the two highest-traffic
   surfaces) prefer `item.thumbnailUrl` for the displayed `<img>`/video
   `poster` when present, falling back to the existing on-the-fly
   `thumbUrl(item.url, N)` helper when absent. Both render `item.blurDataUrl`
   (when present) as a blurred background placeholder that cross-fades to the
   loaded thumbnail on `onLoad` — no layout shift, no blank-frame flash.
7. `CanvasAssetPanel`'s asset-browser tile prefers `item.thumbnailUrl` (same
   fallback rule) for `GenerationItem`-sourced tiles only (not `Asset`-sourced
   tiles — see Non-goals).
8. The existing on-the-fly `?w=` resize route and its immutable caching
   headers are unmodified and remain the fallback path for: assets, canvas
   board nodes, not-yet-backfilled rows, and any thumbnail-generation
   failure.
9. `npm run build` (typecheck) passes. A new unit test file
   (`node:test`/`node:assert`, no new test framework, matching
   `src/lib/shot-spec.test.ts` etc.) covers the pure thumbnail-generation
   function: given an image buffer, returns a smaller webp buffer and a
   valid tiny base64 blur data URL; oversized/corrupt input fails closed
   without throwing past the caller's try/catch.

## Non-goals (explicit, to hold the line on scope)

- **No video poster/thumbnail frame extraction.** Real (non-mock) video
  generations have no `poster` at all today (verified: `poster:` is only ever
  assigned in the mock path). Extracting a real video frame would need a new
  binary dependency (ffmpeg-class tool) with real risk on Vercel's
  serverless FS, cold start, and the existing 60s `maxDuration` budget — that
  deserves its own probe-backed initiative per this repo's working
  conventions, not a bundled add-on here. Video cards keep today's behavior
  (poster only in mock mode; otherwise the browser's native no-poster
  behavior with `preload="metadata"`).
- **No precomputed thumbnails for `assets.images[]`.** Assets are lower
  volume and mutate more often (images added/reordered/removed via the asset
  editor) than generations; the on-the-fly resize already shipped is a good
  fit there and stays unchanged.
- **No change to the Canvas Board node/persistence data model**
  (`src/lib/canvas/types.ts`, `serialization.ts`, `history.ts`). Threading a
  precomputed thumbnail through placed canvas image nodes would mean
  changing what a node persists, touching the documented data-model
  invariants in `.council/canvas-board*/design.md`. Canvas nodes (`ImageNode`)
  keep using the on-the-fly resize.
- **No `MEDIA_BACKEND`/`DATABASE_BACKEND` flip, no signed-URL auth model
  change, no real CDN wiring in front of the bucket.** These are already
  separately tracked, staged-but-not-flipped initiatives with their own
  open blockers (see `progress.md`) — out of scope for this change and not
  to be conflated with it.
- **No adoption of `next/image`.**
- **No changes to pricing/cost or `FACE_BEST_OF`/best-of-N generation
  logic.**

## Rollout / sequencing constraint (important — not a normal merge)

Adding nullable columns to `schema.ts` without running `npm run db:push`
against the real Postgres instance first will make `itemToValues` insert
columns that don't exist yet, which would break **every** generation with a
raw SQL error the moment this ships. This is a genuine data/schema migration
against production Postgres (per this repo's `.env.local`, there is no local
dev database — `DATABASE_URL` points at the real instance). Per this
council's own escalation rule (data migrations are an explicit interrupt
case) and this assistant's standing safety practice, **the council will not
run `db:push` or the backfill script against the live database.** The code
ships on a feature branch with clear instructions for the user to run, in
order: (1) `npm run db:push`, (2) deploy, (3) optionally
`npx tsx scripts/backfill-thumbnails.ts` for existing rows. New generations
after step 1 get thumbnails automatically regardless of whether the backfill
is ever run.

## Assumptions logged as defaults (request was directional, not prescriptive)

- Thumbnail target: 480px longest side, webp quality 75 — matches the
  on-the-fly route's existing constants, so visual output is consistent
  between the two code paths.
- Blur placeholder: ~16px longest side, low quality, inlined as a base64
  data URL stored directly in the row (renders with zero extra network
  request).
- Thumbnail storage key: `thumbnails/<generation-id>.webp`.
- Backfill concurrency: 4 (existing precedent in this codebase).
