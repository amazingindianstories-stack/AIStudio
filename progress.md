# Session Progress & Handoff

## 2026-07-15 - CRITICAL security fix: /api/media had no real auth check (fixed)

Security review of the GCP migration surfaced a pre-existing production
vulnerability, independent of the migration itself: `src/app/api/media/[...path]/route.ts`
never called `getSession()` — the only gate was `middleware.ts`'s cheap
cookie-*presence* check (by design just a UX redirect, not real
enforcement; see that file's own docstring), so any request with a
non-empty but invalid `lumina_session` cookie could read **any** object in
the media bucket. Two concrete secrets were reachable this way: the live
Higgsfield MCP OAuth token (`settings/higgsfield-mcp-token.json`) and full
Postgres `pg_dump` snapshots the migration script writes to `migrations/*`
in the same bucket.

Fixed:
- `src/app/api/media/[...path]/route.ts` now calls `getSession()` and
  401s if absent, matching every other authenticated route in this app.
- Added a `settings/`/`migrations/` key-prefix denylist in the same route
  (defense-in-depth: even a signed-in ordinary user shouldn't be able to
  fetch secrets/DB dumps through the "media" route).
- `infra/gcp/bootstrap-media-cdn.sh`'s bucket-wide `storage.objectViewer`
  grant (which would have bypassed the above entirely once Cloud CDN goes
  live, since CDN serves straight from GCS) now carries an IAM condition
  excluding those same two prefixes.

Verified: `npx tsc --noEmit` clean, `npm run build` clean, 228/228 unit
tests passing. This fix applies to the currently-deployed S3-backed
production code path too, not just the in-progress GCP migration — it was
exploitable before this migration started. Recommend treating this as a
priority hotfix independent of when the rest of this session's work ships.

## 2026-07-14 - GCP migration handoff for Claude (UNCOMMITTED, DO NOT PUSH EARLY)

Codex implemented the database/storage migration while your canvas-board and
admin-status work remained in this worktree. No commit or push was made. Please
finish and review your paused Figma/canvas work, then include these GCP changes
in the same reviewed push.

Main code changes:
- GCS is primary storage in `src/lib/storage.ts`; S3 is temporary read fallback.
- `/api/media/*` supports GCS ranges and redirects to `GCP_MEDIA_CDN_URL`.
- `src/lib/gcp-auth.ts` uses Vercel OIDC/WIF without service-account keys.
- `src/lib/db.ts` uses the Cloud SQL Node connector + IAM auth, with Railway
  `DATABASE_URL` retained as rollback.
- All DB call sites now await `getDb()`; schema indexes were added.
- Migration commands: `npm run migrate:postgres:gcp` and
  `npm run migrate:media:gcp` (dry run unless `-- --apply` is passed).
- The Postgres migration script appends the Cloud SQL runtime grants and
  indexes after every import, so the final clean import is repeatable.
- Config/runbooks: `.env.local.example`, `upgrade.md`, and `infra/gcp/`.
- Runtime is pinned to Vercel-supported Node 22.x. Next.js was upgraded to
  15.5.20 and nested PostCSS was forced to the patched direct dependency.

External GCP state changed:
- WIF is limited to exact `aistudio-v1` production/preview subjects.
- The runtime service account has GCS + Cloud SQL roles.
- The canonical bucket is private with uniform access, public-access prevention,
  and a 30-day lifecycle only for `migrations/` snapshots.
- Cloud SQL backups, 14-backup retention, PITR, and IAM auth were enabled.
- Cloud SQL is PostgreSQL 18.4, requires a connector, and has no public
  authorized network. An initial Railway snapshot is imported and its IAM
  runtime read/write test passed; Railway has continued receiving writes, so a
  final maintenance-window import is still mandatory.

Deployment safety gates are already staged in Vercel production/preview:
- `DATABASE_BACKEND=railway`
- `MEDIA_BACKEND=s3`

Do not flip them just because the branch is pushed. Flip the database gate only
after the final snapshot/count check. Flip the media gate only after the S3 copy
and verification report zero missing/different objects. The GCS audit found 228
older flat objects but 508 currently referenced keys are absent at their exact
paths. Vercel's AWS values are Sensitive Environment Variables and the CLI
cannot export them; obtain/rotate a usable read-only AWS key before running
`npm run migrate:media:gcp -- --apply`.

Verification on 2026-07-14: `npx tsc --noEmit --incremental false`, 228 unit
tests, `npm run migrate:postgres:gcp` dry run, and `npm run build` passed.
`npm audit --omit=dev` has 5 remaining moderate findings in the Google Storage
v7 auth stack (`uuid` via `gaxios`/`teeny-request`); npm's suggested fix is a
breaking downgrade to `@google-cloud/storage@5`, so leave it for a deliberate
SDK follow-up instead of applying `--force`.

Before cutover, read the live-status section in `upgrade.md`. Do not remove
Railway/AWS variables until the final copy, row/object verification, deployment,
and rollback window are complete. The CDN script intentionally has not been run
because it needs the final media hostname and DNS access.

## 2026-07-14 — Canvas Board: FigJam-style whiteboard tab (COMPLETE)

**Scope**: Add a full-screen infinite-canvas whiteboard (Canvas Board / Board tab) for spatial storyboarding, scoped per-project, with asset library drag-to-place and full persistence. V1 single-user (no multiplayer).

**Shipped**:
- `src/lib/canvas/` — pure geometry/z-order/history/serialization logic (types.ts, geometry.ts, zorder.ts, history.ts, serialization.ts); all unit-testable via `node:test` (82 passing).
- `src/lib/canvas-store.ts` — scoped Zustand store (active board graph, selection, tool, viewport, undo/redo, autosave lifecycle).
- `src/lib/canvas-db.ts` — Drizzle access for `canvas_boards` table (list, get, create, rename, delete, save data).
- `src/app/api/canvas-boards/` — REST routes (op-switched metadata POST, `[id]` blob GET/PUT, image upload helper).
- `src/components/canvas/` — CanvasView, CanvasSurface (pan/zoom/selection/marquee), CanvasToolbar, StyleInspector, BoardSwitcher, ConnectorLayer, CanvasAssetPanel, per-node renders.
- Schema: `src/lib/schema.ts` new `canvasBoards` pgTable (jsonb data, app-supplied UUID, bigint ms timestamps).
- Modified: `src/lib/store.ts` (+view field), `src/components/Sidebar.tsx` (Board rail icon), `src/app/page.tsx` (conditional view), `src/lib/save-media.ts` (saveCanvasAsset wrapper).
- **Security fixes** (pre-existing paths): `src/lib/storage.ts` MIME allowlist (JPEG/PNG/WebP/GIF only, rejects SVG/stored-XSS), `src/app/api/media/[...path]/route.ts` (nosniff header).

**Architecture decisions** (design.md D-Render through D-Entry):
- Custom DOM/SVG scene graph (not tldraw/canvas raster) — full control over jsonb model + native-DnD asset drop + no commercial watermark.
- Postgres jsonb data (not S3 pointer) — small structured JSON, reuses established pattern.
- Separate `canvas-store.ts` (not global store) — confines high-frequency updates to canvas subscribers.
- REST `[id]` blob route + op-switch metadata — single large document pattern.
- 1500 ms autosave debounce + force-flush on lifecycle edges (switch/unmount/beforeunload).
- Top-level full-screen view (not 4th right-panel tab) — via new Sidebar rail icon.

**Stage 2 fixes** (post-build, direct application, unambiguous):
1. Connector path: straight line → quadratic bezier (ui-spec.md §7 requires curves).
2. Connector stroke: `#000000` → `rgba(255,255,255,0.7)` (matching spec visibility).
3. Zoom bounds: 0.05–8 → 0.1–4 (10%–400%, matching ui-spec.md §2).

**Stage 3 fixes** (code-reviewer + security-reviewer + ui-designer Mode 2):
- CRITICAL: Frame parentId never assigned on drop (visual highlight only) — fixed in moveSelectionBy.
- CRITICAL: ConnectorLayer SVG `width={0} height={0}` disabled all rendering — fixed to `width={1} height={1}` with `overflow:visible`.
- MAJOR: Mid-flight autosave PUT could drop concurrent edits — fixed by checking history reference identity.
- MAJOR: Rapid board-switch could apply stale GET response — fixed with monotonic loadGeneration counter.
- MAJOR: Opacity slider committed history on every tick, flooding undo — fixed with gesture coalescing.
- MAJOR: Line/Arrow tool couldn't be created on empty canvas — fixed by allowing free `{x,y}` connector endpoints.
- MINOR: zoomToFit used hardcoded viewport guess — fixed with ResizeObserver.
- MINOR: saveBoardData returned success for deleted boards — fixed with Drizzle `.returning()` + 404.
- **Security (HIGH)**: image upload accepted SVG with no MIME check, served same-origin no-sniff → stored XSS. Fixed: `splitDataUrl` MIME allowlist (JPEG/PNG/WebP/GIF) + nosniff header (covers canvas AND pre-existing asset/reference paths).
- **Security (MEDIUM)**: ImageNode.src could be arbitrary external URL (referrer/UA leak). Fixed: `validateCanvasState` requires `/api/media/` prefix, drops otherwise.
- **Security (LOW/MEDIUM)**: No size caps on blob/uploads. Fixed: 2MB PUT body cap, 8MB file upload cap.
- **Accessibility**: Sidebar rail buttons lacked aria-labels (fixed in shared renderer), Add image not focusable (button+ref), Shapes popover no accessible name, delete dialog Cancel focus race (double-rAF defer + focus-visible).

**User follow-ups** (deferred, require data-model extension or cosmetic polish):
- Bold + TextAlign for sticky notes (data model extension).
- 3-state arrowhead toggle `none/→/↔` (Connector.kind currently 2-state).
- FrameNode label on-canvas styling polish (cosmetic).
- Delete-board confirm dialog focus ring visibility (cosmetic).

**Evidence**: `.council/canvas-board/spec.md`, `design.md`, `ui-spec.md`, `decisions.md` (D1–D8 decision log + 3 build rounds).

## 2026-07-11 — Gemini Omni Flash video model added via /council (COMPLETE, rebuilt once)

**Scope**: Add Google's Gemini Omni Flash (`gemini-omni-flash-preview`, Interactions API) as a selectable video model, giving it the same NBP-grade reference/prompt scaffolding (`assemblePrompt` + shot-spec) images already get, instead of the flat prompts the Higgsfield/Seedance video paths use. Billing lands on the GCP project (Gemini API key's project by default; Vertex SKU flag-gated).

**Note on this entry**: the council session that built this feature crashed mid-Stage-4 ("cantigravity") before anything was committed; this is the redo, working from the pre-compaction conversation record. Mid-rebuild, the recreated provider contract (from memory of the lost session) was checked against the live API via `scripts/probe-omni.ts` and found to be wrong in several places — see below.

**Shipped**:
- `src/lib/omni-input.ts` — pure builder, mirrors `providers/gemini.ts`'s `buildParts`: role-labeled group headers → images → identity tiles (14-image cap, tiles yield first, loud error if user images alone exceed the cap) → SCENE/shotInstruction → video-worded FINAL CHECK when identity is locked.
- `src/lib/providers/omni.ts` — the provider. Dual wire path: default `generativelanguage.googleapis.com` with `GOOGLE_API_KEY`; `OMNI_USE_VERTEX=1` for the Vertex SKU (flag-gated — allowlist-gated per Google, and this machine's Vertex creds are dead).
- `src/lib/shot-spec.ts` / `prompt-assembler.ts` — `medium?: "image"|"video"` option (default `"image"`, byte-identical) for video-worded framing/negative codas.
- `src/lib/config.ts`, `store.ts`, `PromptComposer.tsx` — new model entry + `aspectRatiosForModel` (16:9/9:16 only for Omni) wired through the picker and the store's per-model clamping.
- Three route files updated: enqueue guard (`generate/video/route.ts`), task creation (`queue/execute/route.ts`), status polling + inline-base64 video save (`generate/video/status/route.ts`).
- `scripts/probe-omni.ts` — zero-cost validation-error probe matrix (always sends `input: []`, which the API rejects before doing anything) + Vertex readiness check + a `--live` flag for one real generation.

**Contract correction (important for anyone touching this later)**: the API does NOT have a `task` field or a `delivery` field — sending either 400s as an unrecognized parameter. Duration IS a real, enforced request field (`response_format.duration`, a protobuf-Duration string like `"4s"`), not prompt-driven text. The video payload lives at `steps[].content` where `step.type === "model_output"`, not nested under `steps[].model_output.content`. Full detail + how this was discovered: `.council/omni-video/design.md` PROBE VERDICTS section and `decisions.md` D11.

**Cost disclosure**: re-discovering the real contract by hand (outside the shipped probe script) accidentally triggered two additional real, billed ~4s generations before the risk was understood (a non-empty/malformed `input` is accepted and run to completion, not rejected). Combined with the one deliberate live test, this session billed 3 real generations total, not 1. `.council/omni-video/live-test.mp4` is the deliberate one.

**Unit tests**: `npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts src/lib/omni-input.test.ts src/lib/providers/omni.test.ts` — 78/78 passing.

**Evidence**: `.council/omni-video/spec.md` (AC1-AC8), `design.md` (file plan + PROBE VERDICTS), `decisions.md` (D0-D11 decision log), `review-findings.md` (Stage 3 adjudications), `live-test.mp4` (real generated clip).

**User follow-ups**: restore Vertex creds (`gcloud auth application-default login` or a valid service-account key + `GOOGLE_APPLICATION_CREDENTIALS`) and request Omni allowlist access to flip `OMNI_USE_VERTEX=1`; confirm the 10¢/s price in `/admin` against the first real bill; the pre-existing job-ownership gap on video status/execute routes (S3 in decisions.md) is deferred, not fixed, and affects the older video routes equally.

## 2026-07-10 — Higgsfield-NBP parity conclusion & release (COMPLETE)

**Scope**: Determine why Higgsfield outputs appear better than baseline Nano Banana Pro despite using the same endpoint/model, then implement verified techniques via flag-gated levers.

**Research conclusion**: No hidden magic. Higgsfield's edge is deterministic scaffolding (role-aware reference legends + subject-framing language) + reference fidelity (2–4× larger client uploads) + a widened best-of-N judge (composite: identity + prominence + sharpness with floor selection). All measured, captured, and unit-testable.

**Shipped**: Six env-flag features (all default to previous behavior, no automatic changes):
- `PROMPT_SHOT_SPEC=1`: structured instruction assembly (`src/lib/shot-spec.ts`; A/B: 2.4× subject prominence, no identity regression)
- `PROMPT_ROLE_DETECT=1`: fallback role detection for `@imgN` with cross-check WARN
- `JUDGE_COMPOSITE=1`: extended Gemini judge for identity + prominence + sharpness (`src/lib/middleware/face-judge.ts`)
- `POST_CRISPEN=1`: classical sharpen-only delivery pass (~110ms, artifact-free)
- `SUPERSAMPLE=1`: 1-step upsample + lanczos3 downsample (highest prominence, scene risk; flag off by default)
- `NEXT_PUBLIC_REF_MAX_DIM` (default 2048): client ref cap with Vercel budget ladder in PromptComposer

**Unit tests** (first in the repo): `npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts` (Node built-in `node:test`).

**Evidence**: See `.council/higgsfield-nbp-parity/design.md` (contract), `results-ab.md` (16 images: NEW 2.4× prominence, identity ≥ OLD), `decisions.md` (adjudications + design.md fix: commit 849ef9d moved execute logic; design retargeted to queue/execute/route.ts).

---

## Prior sessions (for reference)

### Fable 5 Overview
This session focused on migrating the image generation pipeline from the standard Gemini API (generativelanguage) to the enterprise-grade **Vertex AI `imagen-3.0-capability-001`** endpoint to enable native IP-Adapter support for strict identity locking and scene referencing. 

The goal was to allow the user to tag uploaded images (`@img1`, `@img2`) and have the model perfectly replicate the face, outfit, and location without ethnic drift or style loss.

## What Was Done & The Turnarounds (Bugs & Fixes)

1. **Endpoint Migration & Auth Setup**
   - **Action**: Switched from `generativelanguage.googleapis.com` to `us-central1-aiplatform.googleapis.com` and implemented `google-auth-library` to use Application Default Credentials (ADC).
   - **Turnaround**: The user had to manually authenticate via `gcloud auth application-default login` and configure quota projects because Vertex AI requires strict IAM permissions.

2. **Payload Schema Hell**
   - **Bug**: Initial attempts to use inline `fileData` (multimodal prompting) failed because `imagen-3.0-capability-001` strictly requires the `referenceImages` array in the JSON payload, unlike the standard flash models.
   - **Fix**: Restructured `gemini.ts` to build the `referenceImages` array.
   - **Bug**: Hit repeated 400 INVALID_ARGUMENT errors due to undocumented schema requirements. For example, `subjectType` must be nested inside `subjectImageConfig`, and `bytesBase64Encoded` must be nested properly.
   - **Fix**: Tested the payload directly via standalone `fetch` scripts to deduce the exact schema Google expects.

3. **Reference Count Limits & Aspect Ratios**
   - **Bug**: The API threw an error for exceeding 4 reference images (the middleware had generated 3 face crops + 2 original uploads = 5 images).
   - **Fix**: Capped the array to 4 images max.
   - **Bug**: The API threw *another* error: `"Cannot process more than 2 reference images for non-square aspect-ratio model signatures."` (Because the user requested a 16:9 cinematic frame).
   - **Fix**: Implemented dynamic limits (4 for 1:1, 2 for 16:9).

4. **Reference Type Confusion (The Black Screen)**
   - **Bug**: The system was hardcoding all images as `SUBJECT_TYPE_PERSON`. Vertex AI tried to find a face in the location reference (`@img2`), got confused, ignored the background, and rendered a pure black image.
   - **Turnaround**: Attempted to use `REFERENCE_TYPE_STYLE` for the location. This threw a 400 error because style references require a completely different prompt syntax.
   - **Fix**: Used `SUBJECT_TYPE_DEFAULT` for non-person references. This successfully allowed the model to accept the location image without forcing a face search.

5. **Prompt Bloat & Hallucinations (The Movie Camera)**
   - **Bug**: The generated image featured the character standing next to a massive, literal movie camera on a film set.
   - **Root Cause**: The `prompt-assembler.ts` (originally designed for Higgsfield Nano Banana Pro) was silently wrapping the user's prompt in massive "DOMAIN LOCK" blocks yelling about "filmmaking, lensing, and camera equipment." Vertex AI took this literally and drew film equipment instead of the requested Kolkata street.
   - **Fix**: Completely stripped the prompt bloat. The system now sends the pure, raw user prompt.

6. **Removing Auto-Selection (The Redesign)**
   - **Action**: Per the user's strict instructions, the over-engineered "auto face-crop" middleware was ripped out. The system now takes **exactly** what the user uploads and maps the tags (`@img1`, `@img2`) directly to `[1]` and `[2]` in the prompt text. This aligns perfectly with Vertex AI's IP-Adapter syntax and prevents all previous limit crashes.

---

## Final Goal for Fable 5 (Next Steps)

**Objective**: We need "Higgsfield-level output" no matter what. The user must seamlessly be able to upload images, simply tag them (e.g., `@img1` for face, `@img2` for outfit, `@img3` for location), and get a flawless, photorealistic result.

**Strict Directives for Fable 5**:
1. **No Over-engineering / No Quick Hacks**: The system must be proper, well-built, and architecturally sound. If there is a limit (like Vertex AI's 2-image limit for 16:9), do not just write a quick filter script to drop images. Redesign the architecture to solve the root problem.
2. **Deep Research Required**: Every single line of code, payload structure, or architectural decision MUST be backed up by real Google Cloud / Vertex AI documentation, official SDK references, or robust empirical testing. You must prove *why* a solution will work before implementing it.
3. **Advanced Identity & Scene Preservation**: Since Vertex AI restricts 16:9 images to 2 references, research how to reliably pass 3 visual constraints (Face, Outfit, Location) without degrading quality. This may require researching multi-step generation pipelines, advanced IP-Adapter weighting, or outpainting/inpainting workflows to achieve Higgsfield-level results. 
4. **Seamless UX**: The user should only have to type `@img1` in their prompt. The backend must handle all the complex binding, sizing, and payload construction flawlessly.
