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

- **Image**: `POST /api/generate/image` — synchronous; the route awaits the provider, persists the result, returns the finished item. `maxDuration = 60` (Vercel limit; high-res NBP takes 30–60s).
- **Video**: `POST /api/generate/video` creates a provider task and returns a `queued` item; the client polls `GET /api/generate/video/status?id=...`, which advances the task and downloads the result when done.

Both routes: create a `GenerationItem` row up front (`status: running/queued`), compute cost from the `pricing` table, persist uploaded reference images, then update the row on success/failure. Failures return the failed item as JSON (HTTP 200), not an error status.

### Providers (`src/lib/providers/`)

- `gemini.ts` — **Nano Banana Pro (`gemini-3-pro-image`) via `generativelanguage.googleapis.com`, deliberately NOT Vertex AI.** The file header documents measured probes: Vertex silently gates 2K/4K to 1K; generativelanguage honors them. Don't "upgrade" to Vertex without re-reading that header. Hard limit: 14 images per prompt — user images are never silently dropped; the code errors loudly and only identity tiles yield.
- `higgsfield-mcp.ts` — Higgsfield via its official MCP (Soul photoreal image + Seedance 2.0 multi-reference video). Auth is OAuth: token file locally, `HIGGSFIELD_MCP_REFRESH_TOKEN`/`HIGGSFIELD_MCP_CLIENT_ID` env vars when hosted (token also persisted to S3 for serverless). Flow: media_upload → media_confirm → generate → job_status poll.
- `seedance.ts` — BytePlus ModelArk direct. Note: BytePlus blocks photorealistic faces and this cannot be disabled; Higgsfield Soul is the workaround for realistic faces.
- `omni.ts` — Gemini Omni Flash (`gemini-omni-flash-preview`) video via Google's Interactions API; default wire path generativelanguage with GOOGLE_API_KEY, `OMNI_USE_VERTEX=1` switches to Vertex (OAuth/ADC, allowlist-gated); probe-measured contract in the file header (AR 16:9/9:16 only via `response_format.aspect_ratio`, resolution not controllable, duration a real enforced request field — a protobuf-Duration string like `"4s"` under `response_format.duration`, not prompt text; there is no `task` or `delivery` field, unlike what the docs/most video APIs imply — re-probe before trusting memory here, see the file header and `.council/omni-video/decisions.md` D11); unlike the older video paths it consumes the full `assemblePrompt`/shot-spec system via `src/lib/omni-input.ts`.
- Models offered in the UI are declared in `src/lib/config.ts` (`MODELS`); routes dispatch on model name (`isHiggsfieldModel`, `/nano banana/i`).

### Identity/consistency system (@tags → structured prompt)

This is the most engineered part of the app; the design decisions were measured in bake-offs, not assumed:

1. `src/lib/mentions.ts` parses `@imgN` (ad-hoc uploads) and `@slug` (saved assets from the `assets` table) out of the prompt.
2. `src/lib/prompt-assembler.ts` builds an `AssembledPrompt`: a text instruction with the SCENE kept literal, plus per-tag **groups** of reference images with role headers (CHARACTER/OUTFIT/LOCATION/...), plus **identity tiles** (face crops sent as extra images — Gemini ingests each image as a flat ~258-token tile, so tiles carry the facial detail).
3. For locked faces, the image route runs **best-of-N** (`FACE_BEST_OF`, default 2, max 4): parallel generations, each scored by `src/lib/middleware/face-judge.ts` against the reference face, best one kept, cost billed per candidate. Best-of-N is the proven identity lever; single-pass tricks and face-fix second passes were both disproven (see `gemini.ts` header).

### Auth & data

- Custom auth, admin-managed users (no self-signup): HMAC-signed stateless cookie `lumina_session` (`src/lib/auth.ts`). `src/middleware.ts` is only a cheap edge presence-check for redirects/401s; **real enforcement is `getSession()`/`requireUser()`/`requireAdmin()` inside route handlers.**
- Postgres via Drizzle (`src/lib/schema.ts`): users, projects, folders, generations, assets, pricing, activity_logs. Timestamps are **bigint ms** (`Date.now()`), IDs are app-supplied `crypto.randomUUID()`. Data access lives in `src/lib/*-db.ts` (store-db = generations, assets-db, projects-db, pricing-db).
- Per-user cost attribution: every generation stores `costCents` (from the admin-editable `pricing` table) and `userId`; `/admin` dashboard reads these plus `activity_logs`.

### Media storage

S3 bucket via `@aws-sdk/client-s3` (`src/lib/storage.ts`, bucket from `AWS_S3_BUCKET_NAME`); `src/lib/save-media.ts` is the app-facing wrapper (its function signatures are kept stable across storage backend migrations). Objects are served through the `GET /api/media/[...path]` proxy route, not directly from the bucket. Provider result URLs expire, so results are always downloaded and re-stored.

### Frontend

Single-page app: `src/app/page.tsx` composes the panels; all client state is one Zustand store (`src/lib/store.ts`). Right panel has Project | History | Favorites tabs; projects/folders organize generations. Reference images are downscaled client-side before upload to fit Vercel's 4.5MB payload limit — keep that in mind when touching upload paths.

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

**Full design rationale & decision log:** `.council/canvas-board/spec.md` (acceptance criteria 1–11), `design.md` (architecture trade-offs + 6 binding decisions + data model), `ui-spec.md` (visual contract + responsive bounds), `decisions.md` (D1–D8: design gate, build, Stage 2/3 fixes).

### Deployment

Vercel is the primary target (hence `maxDuration = 60`, payload limits, env-var token auth, read-only FS assumptions). A `Dockerfile` (Next standalone output) exists for container deploys.

### pyserver/

Optional local Python service (SDXL + InstantID on Apple MPS) for fully-local face-locked generation. Separate from the Node app; see `pyserver/README.md`.

### Higgsfield–NBP parity (flag-gated enhancements)

Research (July 2026) found Higgsfield's edge over baseline NBP was not hidden API magic, but deterministic scaffolding (role-aware reference headers, subject-framing language, reference fidelity via higher client upscale cap) plus a widened best-of-N judge (identity + prominence + sharpness composite). All behaviors ship **off by default** and are env-flag gated; deploy Stage 2 can A/B old vs new cheaply.

- **`PROMPT_SHOT_SPEC=1`**: `assemblePrompt` emits a structured instruction with a reference legend, role-labeled image headers, wide-AR framing coda, and an in-prompt NEGATIVE block, keeping the raw user prompt verbatim. Implemented in `src/lib/shot-spec.ts` (pure, unit-testable).
- **`PROMPT_ROLE_DETECT=1`**: Fallback role classifier for `@imgN` uploads using extended Gemini detection. Only consulted when `PROMPT_SHOT_SPEC=1`. Non-blocking cross-check WARN surfaces upload-order mismatches.
- **`JUDGE_COMPOSITE=1`**: Best-of-N judge scores identity + prominence + sharpness in one Gemini call and selects by composite subject to an identity floor (guarantees identity never regresses). `selectBestCandidate` in `src/lib/middleware/face-judge.ts`.
- **`POST_CRISPEN=1`**: Classical sharpen-only delivery pass (no artifacts, ~110ms per image).
- **`SUPERSAMPLE=1`**: Render one resolution step up, downsample to requested size. Measured highest prominence but 1-of-4 scene-accuracy risk (outfit dropped); flag off by default, use for hero shots only. Operationally: do not combine with `FACE_BEST_OF>1` (60s ceiling).
- **`NEXT_PUBLIC_REF_MAX_DIM` (default `2048`)**: Client reference longest-side cap (was hardcoded 1024). `PromptComposer.tsx` includes a budget ladder (2048/q0.85 → q0.7 → 1536/q0.8 → 1024/q0.8) to stay under Vercel's 4.5MB body limit with high-fidelity refs.

Unit tests: `npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts src/lib/omni-input.test.ts src/lib/providers/omni.test.ts` (Node built-in `node:test` + `node:assert`; no new dependency). For full evidence and per-image metrics, see `.council/higgsfield-nbp-parity/`; for the Omni video integration, see `.council/omni-video/`.

## Working conventions

- No over-engineering and no quick hacks: when a provider limit bites (image caps, aspect-ratio rules), solve the root problem architecturally rather than silently filtering/dropping user inputs.
- Back provider/payload changes with official docs or an empirical probe script (`scripts/` has many examples); several provider schemas here were deduced by testing because docs were wrong or missing.
- `progress.md` holds session handoff notes; comments at the top of `gemini.ts` and `prompt-assembler.ts` record measured decisions — read them before changing generation behavior.
