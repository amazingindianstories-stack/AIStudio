# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Lumina Studio** — an internal AI image/video generation app (Next.js 15 App Router, React 19, TypeScript, Tailwind, Zustand). Users type prompts with `@tag` references (uploads `@img1` or saved assets `@priya`), pick a model, and get images (Nano Banana Pro / Higgsfield) or videos (Seedance 2.0 via Higgsfield MCP or BytePlus Ark).

## Commands

```bash
npm run dev            # local dev server
npm run build          # production build (also the de-facto typecheck)
npm run lint           # next lint
npm run db:push        # push src/lib/schema.ts to Postgres (drizzle-kit)
npm run db:seed        # idempotent seed: bucket, admin user, pricing rows
npm run hf:login       # one-time Higgsfield MCP OAuth (writes .higgsfield-mcp-token.json)
npx tsx scripts/<x>.ts # ad-hoc/debug scripts (no test framework exists)
```

Environment: copy `.env.local.example` → `.env.local`. `MOCK_GENERATION=1` runs the whole app without real API calls. `scripts/` load `.env.local` explicitly via dotenv.

## Architecture

### Generation flow (the core path)

- **Image**: `POST /api/generate/image` only *enqueues* (persists references + inserts a `queued` row). The client polls `GET /api/queue/status`, and at position 0 posts `/api/queue/execute`, which awaits the provider inside that one request and returns the finished item. That execute route carries `maxDuration = 300`: a high-res NBP render is 30–60s, but best-of-N fans out N of them plus judge calls, and under Fluid compute concurrent jobs share an instance. **60s here was the old Hobby ceiling, not this project's** — it is Pro with a 300s `functionDefaultTimeout`, and the self-imposed 60s cap was killing jobs under load (see the header comment on the route). If the invocation is killed anyway, the row is stranded in `running` until `reapStaleRunningImages` (`store-db.ts`) fails it — that reaper's threshold must always stay above this `maxDuration`.
- **Video**: `POST /api/generate/video` creates a provider task and returns a `queued` item; the client polls `GET /api/generate/video/status?id=...`, which advances the task and downloads the result when done.

Both routes: create a `GenerationItem` row up front (`status: running/queued`), compute cost from the `pricing` table, persist uploaded reference images, then update the row on success/failure. Failures return the failed item as JSON (HTTP 200), not an error status.

### Gemini spend-rate throttle (`src/lib/spend-window.ts`)

Google caps Gemini API **spend** on a rolling 10-minute window — separate from RPM/TPM — returning `429 RESOURCE_EXHAUSTED` when crossed ($10/10min on Tier 1, $200 on Tier 2/3). Best-of-N makes the app its own worst offender: N parallel renders per job × `MAX_CONCURRENT` jobs.

**Retrying cannot fix this** — the window is 10 minutes and an invocation lives at most 300s, so a saturated window outlives any in-request backoff. `getQueuePosition` therefore performs *admission control*: a job that concurrency would admit is still held (reported as position 1, with `heldForBudget`/`heldReason`/`retryAfterMs`) until the window has room. The client shows it as a normal pending item with a caption and paces its next poll off `retryAfterMs`. Backoff in `gemini.ts` still handles momentary spikes; this handles sustained load.

- Gates **images and Omni video only** — Omni runs on the same `GOOGLE_API_KEY`. Higgsfield/BytePlus must never be held behind a Google budget they don't consume.
- Rows that failed with a 429 are excluded from the window (they were rejected, so they cost nothing) — otherwise one storm suppresses the queue for a further 10 minutes on spend that never happened.
- **`GEMINI_SPEND_LIMIT_CENTS` is in *estimator* cents, not dollars.** Costs come from the admin-editable `pricing` table, whose seeds are explicitly placeholders and which under-read real Gemini cost by ~4×: the burst that tripped a real $10 limit on 2026-07-28 scores only ~231 cents here. Default 150 is derived from that incident, not from Tier 1's nominal $10 — don't "correct" it upward. Raise to ~3000 on Tier 2; `0` disables the gate.
- Forward-progress invariant: an empty window always admits, so a job priced above the whole budget can't be held forever.

### Providers (`src/lib/providers/`)

- `gemini.ts` — **Nano Banana Pro (`gemini-3-pro-image`) via `generativelanguage.googleapis.com`, deliberately NOT Vertex AI.** The file header documents measured probes: Vertex silently gates 2K/4K to 1K; generativelanguage honors them. Don't "upgrade" to Vertex without re-reading that header. Hard limit: 14 images per prompt — user images are never silently dropped; the code errors loudly and only identity tiles yield.
- `higgsfield-mcp.ts` — Higgsfield via its official MCP (Soul photoreal image + Seedance 2.0 multi-reference video). Auth is OAuth: token file locally, `HIGGSFIELD_MCP_REFRESH_TOKEN`/`HIGGSFIELD_MCP_CLIENT_ID` env vars when hosted (token also persisted to S3 for serverless). Flow: media_upload → media_confirm → generate → job_status poll.
- `seedance.ts` — BytePlus ModelArk direct. Note: BytePlus blocks photorealistic faces and this cannot be disabled; Higgsfield Soul is the workaround for realistic faces. **Audio**: `generate_audio` is a top-level boolean on the create-task payload and is the only audio control any video path here has — Higgsfield's MCP Seedance tools expose no audio parameter and Omni's Interactions request has no audio field, so `supportsAudio()` in `config.ts` must keep matching `higgsfield` *before* `seedance` (the Higgsfield model names contain "seedance" too). Defaults off; audio is billed on top of the video and the `Seedance 2.0` pricing row does not model it. The setting is persisted on `generations.generate_audio` rather than passed through, because `/api/generate/video` only enqueues and `/api/queue/execute` is what submits — the row is the only thing carrying it between the two requests. `scripts/probe-seedance-audio.ts` verifies the round trip end to end but **makes a real billed generation**, so it is never run automatically.
- `kling.ts` — **Kling image models via the KlingAI Open Platform** (`Kling Image 3.0` = `kling-v3`, `Kling Image 2.1` = `kling-v2-1`). Contract read from the docs and verified live on 2026-07-30; `scripts/probe-kling-image.ts` re-verifies it (free by default, `--generate` makes one real billed image). Key points, all of which have bitten or would have:
  - **Auth is a single API Key** as `Authorization: Bearer <KLING_API>`. The AccessKey/SecretKey → per-request HS256 JWT that most write-ups describe is explicitly *legacy* in Kling's own docs. Don't reintroduce the JWT dance.
  - Host `https://api-singapore.klingai.com` (`KLING_API_HOST` overrides) — Kling documents this as the endpoint for servers outside China; `api.klingai.com` is the older address. Both answered our key.
  - **`POST /v1/images/generations` takes ONE reference image** (`image` is a scalar). Multi-reference is a *different* endpoint, `POST /v1/images/omni-image`, with an `image_list[]` and only `kling-v3-omni`/`kling-image-o1` — neither wired up. So >1 resolved `@tag` is a loud error naming Nano Banana Pro as the multi-reference path, never a silent drop of the extras. Kling Image 3.0's "free multi-reference images" blurb refers to that other endpoint; the capability map's "Multi-image to Image" row is `—` for `kling-v3`, and that is what governs.
  - **Prompt cap is 2500 characters, enforced.** Prompts here reach 18 kB, so this fires on long shot-spec prompts — it errors with both numbers rather than truncating away scene detail.
  - **`aspect_ratio` is ignored in image-to-image** (probe-measured; undocumented). With one 800×600 reference, requesting `1:1` and `21:9` both returned 1168×864 — *byte-identical* dimensions following the reference. Text-to-image does honour it. Because `generations.aspectRatio` is what `packColumns` lays the library grid out from, the route **measures the returned image** and stores `nearestKlingAspectRatio(w,h)`; storing the requested ratio would both mislabel the card and give it the wrong shape in the masonry. Nearest-by-*log*-distance, because Kling also rounds text-to-image output to pixel multiples (16:9 → 2720×1536 = 1.771, so an exact match never hits) and ratio error is multiplicative.
  - 1K/2K only — 4K is `kling-v3-omni`. Requesting 4K errors rather than returning 2K under a 4K label.
  - Never sends `negative_prompt` (unsupported whenever `image` is set), nor `image_reference`/`image_fidelity`/`human_fidelity` (endpoint doc scopes them to v1/v1-5; the capability map disagrees for v2-1 — omitting is the safe reading, probe before adding), nor `element_list` (needs Kling's Element Library).
  - References are re-encoded by `prepKlingReference`: Kling accepts **jpg/png only** and this app allows WebP. It also enforces Kling's ≥300px and 1:2.5–2.5:1 limits, erroring rather than upscaling or cropping the user's reference.
  - **Kling is the only provider here that reports its own billing.** The finished task carries `final_unit_deduction`, and 1 Unit = $0.0035, so `/api/queue/execute` replaces the enqueue-time estimate with `klingUnitsToCents(...)`. Measured: 2.1 text-to-image billed 4 units, 3.0 and 2.1-with-reference billed 8 — all exactly matching the published list price.
  - Pricing is **flat across 1K/2K** (`IMAGE_RESOLUTION_FLAT` in `pricing.ts`), unlike every other image model, and 2.1 charges **double for image-to-image** (the `Kling Image 2.1 · image-to-image` row, which *replaces* the base rate — unlike the audio rows, which are surcharges).
- `omni.ts` — Gemini Omni Flash (`gemini-omni-flash-preview`) video via Google's Interactions API; default wire path generativelanguage with GOOGLE_API_KEY, `OMNI_USE_VERTEX=1` switches to Vertex (OAuth/ADC, allowlist-gated); probe-measured contract in the file header (AR 16:9/9:16 only via `response_format.aspect_ratio`, resolution not controllable, duration a real enforced request field — a protobuf-Duration string like `"4s"` under `response_format.duration`, not prompt text; there is no `task` or `delivery` field, unlike what the docs/most video APIs imply — re-probe before trusting memory here, see the file header and `.council/omni-video/decisions.md` D11); unlike the older video paths it consumes the full `assemblePrompt`/shot-spec system via `src/lib/omni-input.ts`.
- Models offered in the UI are declared in `src/lib/config.ts` (`MODELS`); routes dispatch on model name (`isHiggsfieldModel`, `isKlingModel`, `/nano banana/i`).

**Higgsfield is out of the UI (2026-07-30) but still in the backend.** Only the two `MODELS` picker entries were removed; `providers/higgsfield-mcp.ts`, `isHiggsfieldModel`, the pricing rows, the admin token card and the status check all remain, so historical generations still render with their model name and the route dispatch still works. Deleting the backend is a separate step.

Two things broke when those entries were removed, both worth knowing before removing any other model:
- **`DEFAULTS.video.model` still named `"Higgsfield Seedance 2.0"`.** `restoreComposerDraft` validates the persisted model against `MODELS` and falls back to `DEFAULTS`, so a default that isn't in the list leaves the composer on a model the picker cannot display — and still routes to that provider. Now `"Seedance 2.0"`, pinned by `defaultsAreOfferedModels` in `config.test.ts`.
- **The Seedance hint said "use Higgsfield for those"** — advice pointing at an option the user could no longer select. Model `hint` text must not name other models unless they're in the picker.

### Video shot directive (`src/lib/video-directive.ts`)

Single source of the identity/style scaffolding for **both** Seedance paths (native BytePlus + Higgsfield MCP). They previously carried separate hand-written directives that had already drifted; don't reintroduce a provider-local one.

It owns the **whole** assembly — scaffolding, then the user's prompt verbatim, then a closing precedence rule — because the precedence rule must land *after* the prompt, which the old `DIRECTIVE + prompt` shape made impossible.

Three faults it fixes (reported 2026-07-28):
- **Style was assumed photoreal.** Both old directives locked identity but never told the model to follow the reference's *style*, and the identity wording was photoreal vocabulary ("keep moles, scars, freckles", "do not smooth or idealize") that actively fights an anime/cel-shaded/painterly reference. Style now follows the reference explicitly; the skin-texture clause appears only when the prompt indicates photographic work. **No vision call is used to classify style** — it would spend on the same rate-limited key `spend-window.ts` protects, and the model can already see the reference.
- **Our cinematography overrode the user's.** "Keep the subject in sharp foreground focus" is a depth-of-field decision that contradicted any prompt asking for deep focus or a rack focus — while the same directive also said "execute exactly as written", so the model got two conflicting instructions. Defaults are now dropped when `hasCameraDirection` fires, *and* the default block carries its own "apply ONLY where the PROMPT does not specify" conditional so a missed regex degrades to a deferring default rather than a contradiction.
- **Precedence was unstated.** A closing rule now names the exact dimensions (style, medium, framing, focus, camera movement, pacing, staging) on which the prompt outranks us.

Identity lock is *retained* — it's the measured lever — but scoped to identity, not composition. Regex detection is deliberately asymmetric: a false negative keeps today's defaults, a false positive only drops guidance; bare "framing"/"blocking" are excluded as measured false positives.

**Not bake-off measured.** The inherited identity wording was; this restructuring is reasoned. `SEEDANCE_LEGACY_DIRECTIVE=1` restores the previous directives on both paths without a deploy.

### Identity/consistency system (@tags → structured prompt)

This is the most engineered part of the app; the design decisions were measured in bake-offs, not assumed:

1. `src/lib/mentions.ts` parses `@imgN` (ad-hoc uploads) and `@slug` (saved assets from the `assets` table) out of the prompt.
2. `src/lib/prompt-assembler.ts` builds an `AssembledPrompt`: a text instruction with the SCENE kept literal, plus per-tag **groups** of reference images with role headers (CHARACTER/OUTFIT/LOCATION/...), plus **identity tiles** (face crops sent as extra images — Gemini ingests each image as a flat ~258-token tile, so tiles carry the facial detail).
3. For locked faces, the image route runs **best-of-N** (`FACE_BEST_OF`, default 2, max 4): parallel generations, each scored by `src/lib/middleware/face-judge.ts` against the reference face, best one kept, cost billed per candidate. Best-of-N is the proven identity lever; single-pass tricks and face-fix second passes were both disproven (see `gemini.ts` header).

### Auth & data

- Custom auth, admin-managed users (no self-signup): HMAC-signed stateless cookie `lumina_session` (`src/lib/auth.ts`). `src/middleware.ts` is only a cheap edge presence-check for redirects/401s; **real enforcement is `getSession()`/`requireUser()`/`requireAdmin()` inside route handlers.** `GET /api/media/[...path]` did NOT follow this pattern until 2026-07-15 (CRITICAL fix — see Media storage below); if you add a new route, check it calls `getSession()` explicitly, don't assume `middleware.ts` covers it.
- Postgres via Drizzle (`src/lib/schema.ts`): users, projects, folders, generations, assets, pricing, activity_logs, canvas_boards. Timestamps are **bigint ms** (`Date.now()`), IDs are app-supplied `crypto.randomUUID()`. Data access lives in `src/lib/*-db.ts` (store-db = generations, assets-db, projects-db, pricing-db, canvas-db) via `getDb()` in `src/lib/db.ts` — never a module-level client, so the backend switch below works everywhere.
- Per-user cost attribution: every generation stores `costCents` (from the admin-editable `pricing` table) and `userId`; `/admin` dashboard reads these plus `activity_logs`.
- **DB backend switch**: `DATABASE_BACKEND` env var — `railway` (default, `postgres` driver via `DATABASE_URL`) or `cloud-sql` (`@google-cloud/cloud-sql-connector` + IAM auth via `pg.Pool`, no static password). `getDb()` in `src/lib/db.ts` lazily picks and caches whichever backend is active; GCP infra lives in `infra/gcp/` and `upgrade.md`. Currently staged but **not flipped** in Vercel (`DATABASE_BACKEND=railway` in both production and preview) pending a final maintenance-window cutover — see `progress.md`.

### Media storage

- **Backend switch**: `MEDIA_BACKEND` env var — `s3` (default, `@aws-sdk/client-s3`, bucket from `AWS_S3_BUCKET_NAME`) or `gcs` (`@google-cloud/storage`, WIF/OIDC auth via `src/lib/gcp-auth.ts`, no service-account keys). **Production runs `gcs`** — confirmed 2026-07-29 from a live signing error, correcting an earlier claim here that both environments were on `s3`. `src/lib/storage.ts` exposes `checkStorageConnectivity()` for a backend-agnostic reachability probe, used by the admin Status tab. `src/lib/save-media.ts` is the app-facing wrapper (its function signatures are kept stable across storage backend migrations). Currently staged but **not flipped** (`MEDIA_BACKEND=s3` in both production and preview) — the GCS object audit still has a discrepancy to resolve first (see `progress.md`).
- Objects are served through the `GET /api/media/[...path]` proxy route, not directly from the bucket. Provider result URLs expire, so results are always downloaded and re-stored.
- **Handing an object to an external provider** (BytePlus fetching a `video_url`) needs a URL with no session. `storage.signStoredRef` tries, in order: the public CDN if `GCP_MEDIA_CDN_URL` is set, then a cloud presigned URL, then `/api/media-grant` — an HMAC-signed, short-TTL, single-object grant (`src/lib/media-grant.ts`). The fallback is load-bearing, not defensive: **GCS under Workload Identity Federation has no signing key**, so `file.getSignedUrl()` cannot work at all there, which is precisely how video-to-video first failed in production. The grant route is exempted in `src/middleware.ts` (its 401 would otherwise fire first) but is not unauthenticated — the object path comes out of the signature, never the querystring, and the `settings/`/`migrations/` denylist is enforced at both mint and verify.
- **This route requires an authenticated session** (`getSession()`, 401 if absent) and denies any key under the `settings/` or `migrations/` prefixes (secrets / DB dump snapshots that share the bucket with user media) — both added 2026-07-15 after a CRITICAL finding that the route previously had no auth check at all. If you add a GCS/S3 IAM grant for this bucket (e.g. for CDN), it must carry the same prefix exclusion — see the comment in `infra/gcp/bootstrap-media-cdn.sh`.

### Frontend

Single-page app: `src/app/page.tsx` composes the panels; all client state is one Zustand store (`src/lib/store.ts`). Right panel has Project | History | Favorites tabs; projects/folders organize generations. Reference images are downscaled client-side before upload to fit Vercel's 4.5MB payload limit — keep that in mind when touching upload paths.

### Library feed: scoped server queries, not a client-filtered window

Every asset view (All assets, a project, a folder, Unsorted, Favourites, each with a kind/search filter) is a **scope**, and each scope is answered by its own indexed query. Before 2026-07-29 there was one global `items` array — `/api/history` had no WHERE clause at all, returned global history 20 rows at a time, and every view filtered that window client-side. Consequences, all reported as separate bugs but all this one cause: an old project rendered empty with every folder counting `0` until the user had scroll-paged through all newer history; search only matched loaded rows; the chat thread for an old project was blank.

- `src/lib/store-db.ts` — `queryHistory(filter, cursor, limit)` and `countHistory`/`countScope`. **Pagination is a row-value keyset** (`(created_at, id) < (…)`), never an offset: offsets re-scan everything before them and shift under the concurrent inserts this table constantly gets. The trailing `id` is load-bearing — `createdAt` is a ms bigint and batch generation writes several rows in one millisecond, so a cursor on `createdAt` alone skips or repeats rows at page boundaries.
- Favourites order by `favorited_at`, everything else by `created_at`. `scripts/optimize-history-indexes.ts` backfills `favorited_at` for legacy favourites precisely so it can carry a keyset — a NULL there falls outside the row comparison and would strand those rows forever.
- `src/lib/history-query.ts` — the one filter⇄querystring parser, shared by the feed route, the counts route and the client. `folderId=none` means "in the project, in no folder" and must stay distinguishable from an absent `folderId` ("any folder").
- `src/lib/feed-scope.ts` — pure scope logic (`scopeKey`, `scopeToQuery`, `matchesScope`, `compareInScope`). `matchesScope` must stay equivalent to `filterConditions` in `store-db.ts`: stricter and a finished generation vanishes until reload, looser and a row appears that a refetch removes. Unit tests in `feed-scope.test.ts`.
- Store: `items` is the **active scope's** page, not a global pool. Scope changes are driven by one subscription at the bottom of `store.ts` (search debounced 300ms), each read is sequence-guarded so a slow reply can't paint over a newer one, and scopes are LRU-cached (`src/lib/feed-cache.ts`) so re-entry is instant with background revalidation. Rows live in several pools at once, so mutations go through `patchEverywhere`/`dropEverywhere` — updating only `items` gets silently reverted by a stale cache entry on the next tab switch.
- **Never call `putFeedCache` while iterating the cache.** It deletes and re-inserts the key to maintain LRU order, and a JS `Map` iterator visits entries added during iteration — so the key is revisited forever. That shipped once and hung the tab a few seconds after every Generate, because `patchEverywhere` runs on each poll tick of an in-flight job. `patchCached`/`dropCached` iterate a snapshot of the keys and write with a plain `Map.set` (which preserves order); patching is not a "use" for LRU purposes anyway. Regression tests in `feed-cache.test.ts` all carry timeouts, so a reintroduced loop fails the run instead of hanging it.

**The grid's scroll container has two different parents**, and it must size correctly under both: `HistoryPanel` renders it as a child of a flex *column* (where `flex-1` sizes it), `ProjectPanel` as a stretched item of a flex *row* (where `flex-1` means nothing and `h-full` is what works). `AssetGrid`'s root therefore carries both. Carrying only `flex-1` left it at `height: auto` under `ProjectPanel`, so the scroller — `h-full` of an auto height, i.e. auto — grew with its content instead of scrolling, and the asset list could not be scrolled at all. It only showed once content exceeded the panel height, so it read as "broken on some machines" (reported 2026-07-29 from a second monitor).
- `ConversationPanel` reads its own `threadItems` pool (project-scoped); `CanvasAssetPanel` uses the standalone `useHistoryQuery` hook. Neither may go back to filtering the shared feed — that is what coupled them to the right panel's scroll position.

**Indexes are not created by `db:push`** (a plain `CREATE INDEX` locks the table against writes). Run `npm run db:optimize` — `CREATE INDEX CONCURRENTLY` plus the `favorited_at` backfill, safe to re-run; applied to production 2026-07-29. `scripts/probe-history-query.ts` and `scripts/probe-history-counts.ts` are read-only verification probes (keyset walks with no duplicates/skips, LIKE-escaping, per-folder counts, `EXPLAIN`).

Do **not** expect every feed query to use a keyset index — measured on production at 895 rows, the planner picks them selectively and that is correct:

| query | plan |
|---|---|
| selective project (44/895 ≈ 5%) | `generations_project_keyset_idx`, index scan, no sort |
| favourites | `generations_favorite_keyset_idx`, index scan, no sort |
| non-selective project (369/895 ≈ 41%) | old `generations_created_at_idx` + Incremental Sort |
| global feed | old `generations_created_at_idx` + Incremental Sort |

The incremental sort is nearly free because `created_at` is close to unique, so its presorted groups hold ~1 row; a narrower index beats a wider composite one at that point. The composite indexes earn their keep as the table grows and any one project becomes a smaller fraction of it. **Correctness does not depend on which index is chosen** — no-skip/no-duplicate pagination and bounded work per page come from the row-value predicate plus `LIMIT`, not from the index (a mid-table cursor reads ~25 buffers regardless of depth). Total added index size: ~208 kB.

### Why the asset grid must not re-layout on scroll

Reported as "it keeps rearranging while I scroll" and fixed 2026-07-29. Four separate causes compounded, so re-introducing any one of them brings the symptom back:

1. `MediaCard` had framer-motion's `layout` prop — every card FLIP-animated to any new position, so each appended page set the whole grid in motion. Hover lift is now a CSS transform for the same reason (`whileHover` animated `y`, an inline style a layout pass has to honour).
2. `ProjectPanel` used a balanced CSS multi-column masonry (`columns-… [column-fill:_balance]`). Column balancing is global: appending a page redistributes *every* card. `src/components/AssetGrid.tsx` is now the single grid for both panels.

   **Layout has to satisfy two properties at once, and each obvious answer only gives one.** Balanced CSS masonry fills the gaps but reshuffles on append. A uniform CSS grid is append-stable but leaves dead space, because a grid row is as tall as its tallest card — with 21:9 and 9:16 side by side that band is very visible (reported 2026-07-29, after the grid shipped). The answer is `packColumns` in `AssetGrid.tsx`: greedy shortest-column masonry computed in JS from each card's aspect ratio. It fills gaps *and* each placement depends only on the items before it, so appending cannot move what is already placed. Heights come from the aspect ratio, never from measuring the DOM, which keeps it deterministic and free of a measure→paint→measure loop. Re-packing does occur on column-count changes (panel resize, zoom) and on a prepend — both direct consequences of a user action, not movement under a passive scroll. Append-stability is pinned by `src/lib/pack-columns.test.ts`; it is the property a screenshot cannot verify.
3. `AnimatePresence mode="popLayout"` absolutely-positions exiting children and animates siblings into the gap — right for a short list, wrong for a grid being appended to.
4. `contentVisibility: auto` with a flat `containIntrinsicSize: "200px"`. It is now `auto 240px`; the `auto` keyword makes the browser remember each card's real height, without which the scroller's height changed as cards left the rendering window.

Also: the infinite-scroll sentinel lives *outside* the grid (as a grid child it claims a cell and reflows the last row), and live arrivals are **buffered** into `pendingItems` while the user is scrolled away from the top, surfaced as a "N new items" pill instead of being inserted above the viewport. `setFeedPinned` is called per scroll event and must keep its no-op-when-unchanged guard.

### Canvas Board (FigJam-style whiteboard tab)

A full-screen infinite-canvas whiteboard for spatial storyboarding, launched from a new "Board" rail icon in `Sidebar.tsx`. Users drag assets from their library onto the canvas or create shapes/text/frames/connectors freehand; board state persists to a new `canvas_boards` Postgres table with full graph (nodes, connectors, viewport) stored as `jsonb data`. Single-user v1 (no real-time multiplayer — see D4 in `.council/canvas-board/decisions.md`).

**Code organization:**
- `src/lib/canvas/` — pure, unit-testable logic (types.ts, geometry.ts, zorder.ts, history.ts, serialization.ts); no `"use client"` or side effects.
- `src/lib/canvas-store.ts` — Zustand store for active board (scoped separately from global `store.ts` to contain high-frequency pan/drag/selection updates).
- `src/lib/canvas-db.ts` — Drizzle data access for `canvas_boards` table (list, get one, create, rename, delete, save data).
- `src/app/api/canvas-boards/` — REST routes: list/create/rename/delete via op-switched POST, get board with data blob via GET `[id]`, autosave via PUT `[id]`, image upload helper via POST `[id]/upload`.
- `src/components/canvas/` — CanvasView (top-level mount/autosave lifecycle), CanvasSurface (pan/zoom/pointer/marquee), CanvasToolbar (tool palette + zoom controls), StyleInspector (floating property panel), BoardSwitcher (dropdown), ConnectorLayer (SVG overlay for connectors + marquee), CanvasAssetPanel, per-node renders (ShapeNode, TextNode, StickyNode, FrameNode, ImageNode).

**Persistence model:** Board metadata in `canvas_boards` table; full graph (nodes, connectors, viewport) as `jsonb data` (same convention as `generations.referenceImages`). Autosave is 1500 ms debounced PUT, force-flushed on board switch, view switch, unmount, `beforeunload` (via `keepalive` fetch). Reload restores nodes/positions/z-order/viewport faithfully via `validateCanvasState` (array order = z-order; child coords absolute; connector endpoints stored as `{nodeId, anchor}` never coordinates — see design.md's Data model for the two key invariants and their reasoning).

**Scope & non-goals:** v1 supports shapes (rect/ellipse/triangle/diamond), text, sticky notes, frames (labeled containers with parentId membership), connectors (with bezier curves + attached endpoints), image nodes from asset library (drag or click-to-place), undo/redo, grouping (shared groupId), layer ordering. No real-time multiplayer (D4), no Figma design-tool primitives (pen/bezier, booleans, components, auto-layout), no rotation, no on-canvas video playback. Desktop pointer + keyboard only; 1024px min width (overlay on narrower).

**Two security fixes to pre-existing paths** (not canvas-specific but shipping in this change):
- `src/lib/storage.ts` `splitDataUrl` now allowlists JPEG/PNG/WebP/GIF MIME types only and throws on SVG or anything else — closes a stored-XSS vector in the canvas image-upload path AND the pre-existing asset/reference-image upload paths.
- `src/app/api/media/[...path]/route.ts` now sets `X-Content-Type-Options: nosniff` header as defense-in-depth.

**v2 additions (2026-07-16): asset scoping, keyboard/mouse parity, connector editing**
- `CanvasAssetPanel.tsx` — asset scope is a picker over every real project (`AssetScope = string`, `"all" | projectId`), not a binary This/All toggle; "This project" is pinned first, then every other project by name, then "All projects". Choice persists to `localStorage`, revalidated against live `projects` on load (stale/deleted project ids fall back to `projectId ?? "all"`).
- Figma-standard keyboard shortcuts (tool switches, `Cmd/Ctrl+D` duplicate, `Cmd/Ctrl+G`/`Shift+G` group/ungroup, bracket layer-order, arrow-key nudge, `Cmd/Ctrl+C/V` copy/paste within-board) — guarded so shortcuts don't fire while a text field has focus.
- Mouse interactions: alt-drag duplicates the selection in place, shift-drag constrains movement, right-click opens `CanvasContextMenu.tsx` (Duplicate/Copy/Delete/layer-order/group — the same actions the store already had with no prior UI entry point; shared logic factored into `src/lib/canvas/selection-actions.ts` so the context menu and any future toolbar can't drift apart).
- Connector endpoints are now draggable (re-attach to a different node or detach to a free point) — the automatic bezier-bow curve computation itself is unchanged; this is endpoint re-targeting, not manual curve/control-point editing (see D4 in `canvas-board-v2/decisions.md` for why that's the deliberate line).
- Gesture-coalescing note: multi-tick gestures (like alt-drag) call a `keepGestureAlive()` store primitive on every pointermove once duplication has fired, to stop the ~400ms `GESTURE_IDLE_MS` idle timer from splitting one drag into two undo steps.

**Full design rationale & decision log:** `.council/canvas-board/spec.md` (acceptance criteria 1–11), `design.md` (architecture trade-offs + 6 binding decisions + data model), `ui-spec.md` (visual contract + responsive bounds), `decisions.md` (D1–D8: design gate, build, Stage 2/3 fixes); v2 additions in `.council/canvas-board-v2/` (spec/design/ui-spec/decisions D1–D8).

### Admin dashboard: totals come from SQL, never from an array's length

Same lesson as the library feed, learned separately and later (2026-07-30). `/api/admin/data` used to ship the newest **500** generation rows with full prompt text, and the Overview computed every figure from that array in the browser. So each figure silently meant "over the newest 500" rather than over the table:

| symptom | measured on production, 916 rows |
|---|---|
| `Generations` tile | frozen at **500** since the table crossed 500 |
| `Total spend` tile | **$152.74** against **$257.18** actual — 41% missing |
| by-model / by-kind / per-day charts | last 500 only |
| Logs search + model dropdown | matched only loaded rows |
| payload on dashboard open | **2,273 kB**, of which 2,044 kB (95%) was prompt text |

Prompts here average 3.8 kB and reach 21 kB (shot-by-shot video prompts), which is why the log dominated the payload. The internal tell was that the **Users** tab was already SQL-aggregated and therefore disagreed with the Overview.

- `src/lib/admin-stats.ts` — `readAdminStats()`: `count(*)`/`sum()`/`GROUP BY` for totals, by-kind, by-model, per-day, and the DISTINCT model list. Day buckets are `to_char(... at time zone 'utc')` **deliberately UTC**, matching the `toISOString().slice(0,10)` the client used, so the chart's buckets didn't shift when this moved server-side. `byKind` returns explicit zeros in fixed order so pie slices don't reorder (and recolour) as the mix changes.
- `src/lib/admin-logs.ts` + `GET /api/admin/logs` — the browsable log: server-side filtering, the same row-value keyset as the feed (`(created_at, id) <`, reusing `generations_created_keyset_idx`), and `left(prompt, PROMPT_PREVIEW_CHARS)` **in SQL** so the bulk never leaves Postgres. Truncating is exactly *why* search had to move server-side: matching a truncated prompt in the browser would quietly only search its first 300 characters. `promptTruncated` is a `length() >` flag so the cell can show "…" rather than imply the prompt ended.
- CSV export is a server download (`?format=csv`) covering every row matching the filter with **full** prompts, capped at `MAX_CSV_ROWS`; it used to export only the loaded window.
- `src/lib/admin-activity.ts` + `GET /api/admin/activity` — the audit trail, paged the same way (2026-07-31). It was the last flat newest-500 window: `activity_logs` holds **1,174 rows**, so 674 events were simply unreachable, and the action dropdown only offered actions occurring inside that window. The action list now comes from a SQL `DISTINCT` and is sent on the **first page only** — it doesn't change as you page, and it's the one part of the response that scans beyond the page. `detail` is returned whole rather than truncated like prompts: every writer stores a small object and the one that could be large already slices the prompt to 120 chars at the call site.
- `/api/admin/data` now returns **no list rows at all** — just users, `stats`, pricing. **2,273 kB → 8.8 kB on open (259×)**; the log is +49 kB and activity +15 kB, both only on the Logs tab. What's left is bounded by user and pricing-row count, so the route no longer grows with usage. Keep it that way.
- `readHistory()` in `store-db.ts` and `readActivity()` in `activity.ts` were both deleted when the admin route stopped calling them — the alternative is an unused second way to read the same table that will drift.
- **A cursor belongs to the result set it came from.** Both tabs clear `nextCursor` *before* a filter refetch, not after it resolves. Without that, clicking "Load more" while a filter change is in flight pages the **previous** filter and concatenates two different queries' rows — the sequence guard cannot catch it, because the filter changed before `loadMore` started rather than during it. It surfaced as `Showing 100 of 84 events` with a button reading `Load -16 more`, and it shipped in the 2026-07-30 log work; caught by driving the rendered page, not by any test.

`scripts/probe-admin-payload.ts` is the read-only verification for **both** lists (totals vs independent `count(*)`/`sum()`, a full keyset walk of each asserting no skips or duplicates, filter narrowing, ILIKE-escaping, the action list matching `count(distinct action)` and being sent once rather than per page, payload accounting, and it prints the before/after numbers). Filter-parser unit tests in `admin-logs.test.ts` and `admin-activity.test.ts`.

### Admin API status page

A "Status" tab in `AdminDashboard.tsx` (admin-only, via `adminOrNull()`) health-checks every external dependency in parallel on tab-open and on manual Refresh — no auto-polling (checks hit paid/rate-limited APIs). Registry + check functions live in `src/lib/status-checks.ts`, exposed via `GET /api/admin/status`; each check races a 5s timeout so one hung dependency can't block the page.

Checks: Gemini/NBP, Higgsfield MCP, BytePlus/Seedance, Omni Flash (all env-var/config-presence checks, not live generations — no cost incurred), Postgres (`getDb()` + `select 1`), Media Storage (`checkStorageConnectivity()`, backend-agnostic across S3/GCS).

**Hard safety constraint**: the Higgsfield check calls only `loadToken()`/`isFresh()` (reads the cached token file/env, does no network round-trip) — it must never attempt a refresh-token exchange, because Higgsfield refresh tokens are single-use and reuse revokes the whole token family with no automated recovery. Don't "improve" this check to validate the token against the live API without re-reading `.council/admin-status-page/decisions.md` D0.

**Evidence**: `.council/admin-status-page/spec.md` (acceptance criteria 1–10), `design.md`, `ui-spec.md`, `decisions.md` (D0 safety constraint, D1–D6 scope/design-gate/review adjudication).

### Deployment

Vercel is the primary target (hence per-route `maxDuration`, payload limits, env-var token auth, read-only FS assumptions). The project is on **Pro with fluid compute + elastic concurrency**, `functionDefaultTimeout: 300` — so concurrent invocations share an instance and contend for CPU, which is why burst load slows individual jobs. A `Dockerfile` (Next standalone output) exists for container deploys.

### pyserver/

Optional local Python service (SDXL + InstantID on Apple MPS) for fully-local face-locked generation. Separate from the Node app; see `pyserver/README.md`.

### Higgsfield–NBP parity (flag-gated enhancements)

Research (July 2026) found Higgsfield's edge over baseline NBP was not hidden API magic, but deterministic scaffolding (role-aware reference headers, subject-framing language, reference fidelity via higher client upscale cap) plus a widened best-of-N judge (identity + prominence + sharpness composite). All behaviors ship **off by default** and are env-flag gated; deploy Stage 2 can A/B old vs new cheaply.

- **`PROMPT_SHOT_SPEC=1`**: `assemblePrompt` emits a structured instruction with a reference legend, role-labeled image headers, wide-AR framing coda, and an in-prompt NEGATIVE block, keeping the raw user prompt verbatim. Implemented in `src/lib/shot-spec.ts` (pure, unit-testable).
- **`PROMPT_ROLE_DETECT=1`**: Fallback role classifier for `@imgN` uploads using extended Gemini detection. Only consulted when `PROMPT_SHOT_SPEC=1`. Non-blocking cross-check WARN surfaces upload-order mismatches.
- **`JUDGE_COMPOSITE=1`**: Best-of-N judge scores identity + prominence + sharpness in one Gemini call and selects by composite subject to an identity floor (guarantees identity never regresses). `selectBestCandidate` in `src/lib/middleware/face-judge.ts`.
- **`POST_CRISPEN=1`**: Classical sharpen-only delivery pass (no artifacts, ~110ms per image).
- **`SUPERSAMPLE=1`**: Render one resolution step up, downsample to requested size. Measured highest prominence but 1-of-4 scene-accuracy risk (outfit dropped); flag off by default, use for hero shots only. Operationally: combining it with `FACE_BEST_OF>1` is expensive and slow — it was previously unsafe against the 60s cap, which is now 300s, but it still multiplies the parallel-render count that trips Gemini's spend-based 429.
- **`NEXT_PUBLIC_REF_MAX_DIM` (default `2048`)**: Client reference longest-side cap (was hardcoded 1024). `PromptComposer.tsx` includes a budget ladder (2048/q0.85 → q0.7 → 1536/q0.8 → 1024/q0.8) to stay under Vercel's 4.5MB body limit with high-fidelity refs.

Unit tests: `npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts src/lib/omni-input.test.ts src/lib/providers/omni.test.ts src/lib/providers/gemini.test.ts src/lib/providers/kling.test.ts src/lib/spend-window.test.ts src/lib/video-directive.test.ts src/lib/feed-scope.test.ts src/lib/config.test.ts src/lib/pack-columns.test.ts src/lib/feed-cache.test.ts src/lib/pricing.test.ts src/lib/mentions.test.ts src/lib/media-grant.test.ts src/lib/admin-logs.test.ts src/lib/admin-activity.test.ts` (Node built-in `node:test` + `node:assert`; no new dependency). For full evidence and per-image metrics, see `.council/higgsfield-nbp-parity/`; for the Omni video integration, see `.council/omni-video/`.

## Working conventions

- No over-engineering and no quick hacks: when a provider limit bites (image caps, aspect-ratio rules), solve the root problem architecturally rather than silently filtering/dropping user inputs.
- Back provider/payload changes with official docs or an empirical probe script (`scripts/` has many examples); several provider schemas here were deduced by testing because docs were wrong or missing.
- `progress.md` holds session handoff notes; comments at the top of `gemini.ts` and `prompt-assembler.ts` record measured decisions — read them before changing generation behavior.
