# Design: Gemini Omni Flash video generation

> Rebuilt 2026-07-11 (see spec.md header). The file plan below is unchanged
> in substance from the original session. The PROBE VERDICTS section IS
> changed — the first rebuild pass (below, this same day) carried over
> half-remembered facts from the lost session's notes, and several turned
> out to be wrong when re-measured against the live API. See decisions.md
> D11 for the correction and its cost (two accidental billed generations
> while re-probing). The verdicts below are the ones actually exercised
> against the live endpoint this session and are what the shipped code uses.

## PROBE VERDICTS (binding — overrides public docs AND overrides anything said elsewhere in this repo; re-measured 2026-07-11)

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  (header `x-goog-api-key`, not `?key=`). Poll `GET /v1beta/interactions/{id}`
  with the same header. The response id field is `id` (not `name`).
- Vertex variant: `POST https://aiplatform.googleapis.com/v1beta1/projects/{project}/locations/global/interactions`
  — OAuth2 Bearer only (API keys rejected, per docs — not independently
  re-verified this session, Vertex creds are dead on this machine). Public
  reports + a Google forum staff reply (2026-06-25) say Vertex Omni access is
  allowlist-gated.
- Body is `{model, input, background, response_format}`. There is **no
  `task` field** — sending one 400s with `"Unknown parameter 'task'."` The
  model infers text-to-video vs. reference-to-video purely from whether
  `input` contains image parts.
- There is also **no `delivery` field** (an earlier pass here said
  `"inline"|"uri"` — both wrong; sending it 400s as unknown). Every real
  response observed inlines the video as base64 regardless.
- `input` is an array of items from a large shared `type` enum (Interactions
  is one schema across several Google agent products — function_call,
  model_output, thought, document, etc. all appear in the enum). Only two
  item shapes matter for us: `{type:"text", text}` and `{type:"image",
  mime_type, data}` — **snake_case `mime_type`**, camelCase `mimeType` 400s
  with "Did you mean 'mime_type'?".
- `response_format` is optional; when provided: `{type:"video",
  aspect_ratio, duration}`. `aspect_ratio` enum is exactly `"16:9"|"9:16"`
  (confirmed via the exact supported-values list in a validation error).
  `duration` **is a real, enforced request field** — a protobuf-Duration
  string like `"4s"` (a bare number, or a string missing the trailing "s",
  both 400). This reverses an earlier pass's claim that duration was
  prompt-driven text — it is not; response_format.duration is authoritative.
  `resolution` is NOT accepted anywhere (top-level or under
  response_format) — omit it entirely.
- `background:true` — live-confirmed this session (not just a probe) to
  make the create call return immediately with an id to poll; the real live
  test below saw 5 `in_progress` polls before `completed`.
- Statuses actually observed: `in_progress`, `completed`. The rest of the
  documented Interactions status enum (`failed|cancelled|incomplete|
  budget_exceeded|requires_action`) is carried over from Google's shared
  Interactions status set, not independently reproduced this session —
  `mapOmniStatus` still handles all of them, with an unknown-status fallback
  to "running" as the safety net either way.
- Video payload (measured on a real completed interaction): `steps[]` is an
  array of turn-like items each with its own `type` (e.g. `"thought"`,
  `"model_output"`) — **not** nested under a `step.model_output.content`
  wrapper as an earlier pass assumed. The `"model_output"` step carries a
  `content` array; the video entry is `{type:"video", mime_type, data}`
  (base64), e.g. `video/mp4`.
- Live-measured cost signal: three ~4s clips this session (two accidental,
  one deliberate) each totalled ~58,700 tokens (~57,900 video
  output tokens) — consistent with treating this as a flat-ish per-second
  product rather than needing token-level billing logic.

## Key insight from recon

Today's video paths (Seedance/Higgsfield) bypass the NBP prompt system
entirely — flat reference roles, hardcoded identity preambles, no role
headers/tiles/legend. The Omni path closes this gap by reusing the image
path's machinery: `assemblePrompt()` (`prompt-assembler.ts`) + shot-spec,
consumed by a new pure builder that mirrors `gemini.ts`'s `buildParts`
(header → images → tiles-under-budget → SCENE → FINAL CHECK), retargeted to
Interactions content parts instead of Gemini generateContent parts.

## File plan

### Phase 1 — pure builder + config/pricing/UI
- **`src/lib/omni-input.ts`** (NEW, pure): `buildOmniInput(assembled:
  AssembledPrompt) → OmniContentPart[]`; per group: header text →
  images → identity tiles under a 14-image budget (tiles yield first; over
  cap on user images THROWS loudly, never silently drops — same contract as
  `gemini.ts`); then `shotInstruction ?? "SCENE: " + instruction`; a FINAL
  CHECK part worded for video ("...in every frame of the video") when
  identity groups exist. `OMNI_MAX_IMAGES = 14`. No `omniTaskFor()`/`task`
  concept — the real API has no task field (see PROBE VERDICTS); the model
  infers text-to-video vs. reference-to-video from whether `input` contains
  image parts. No duration handling here either — duration is a real
  request param (`response_format.duration`), owned by
  `providers/omni.ts`'s `buildOmniPayload`, not prompt text.
- **`src/lib/omni-input.test.ts`** (NEW): node:test.
- **`src/lib/config.ts`**: MODELS entry `{id:"gemini-omni-flash",
  name:"Gemini Omni Flash", kind:"video", badge:"NEW", hint:"..."}`;
  NEW `aspectRatiosForModel(model, kind)` helper (`/omni/i` →
  `["16:9","9:16"]`, else falls back to `ASPECT_RATIOS[kind]`);
  `/omni/i` branches added to the existing `durationsForModel` ([4,6,8]) and
  `resolutionsForModel` (`["720p"]` — the only resolution Omni actually
  returns per probe, exposed as a single non-choice for UI consistency with
  other models' resolution picker).
- **`src/lib/pricing.ts`**: DEFAULT_PRICING row `{model:"Gemini Omni Flash",
  unitCostCents:10, unit:"per_second", notes:"..."}` — already present on
  disk from the partial pre-crash commit; keep as-is.
- **`src/lib/store.ts`**: `setModel` must clamp `aspectRatio` via
  `aspectRatiosForModel(model, s.mode)` and `duration`/`resolution` via
  `durationsForModel`/`resolutionsForModel` — BY MEMBERSHIP, not a
  `Math.min`-style bound (Omni's durations `[4,6,8]` don't contain today's
  default `5s`; a min-clamp would silently leave 5s selected and the enqueue
  guard would 400 on an untouched-defaults happy path). NOTE: the on-disk
  `setModel` currently clamps against the generic `DURATIONS`/`RESOLUTIONS[s.mode]`/
  `ASPECT_RATIOS[s.mode]` globals, not the per-model helpers, despite a
  comment claiming model-aware behavior — this is the bug to fix (finish the
  work the comment describes).
- **`src/components/PromptComposer.tsx`**: AR picker options must come from
  `aspectRatiosForModel(s.model, s.mode)` instead of the raw
  `ASPECT_RATIOS[s.mode]` import.
- **`src/lib/shot-spec.ts` + `src/lib/prompt-assembler.ts`**: optional
  `medium?: "image"|"video"` (default `"image"`, byte-identical to prior
  output — AC5). Video framing coda uses motion/frame language; video AVOID
  list (`VIDEO_NEGATIVE_CODA`) targets temporal artifacts (identity/wardrobe
  drift between frames, flicker, morphing). Already present on disk from the
  pre-crash commit — verify against this design, don't re-derive.

### Phase 2 — Provider
- **`src/lib/providers/omni.ts`** (NEW): `isOmniModel` (`/omni/i`),
  `createOmniVideoTask`, `getOmniVideoStatus`, plus pure/testable helpers
  `mapOmniStatus`, `buildOmniEndpoint({vertex, project?})`,
  `buildOmniPayload(input, aspectRatio, duration)` (no `task` param — the
  field doesn't exist; see PROBE VERDICTS), `extractOmniVideo` (async — the
  `output_video.uri` download path is unexercised defense-in-depth, since no
  real response has needed it), and `assertGoogleHost()` (credentials only
  attached to a `googleapis.com` / `*.googleapis.com` host — else throw).
  - Wire path: default generativelanguage + `x-goog-api-key` header;
    `OMNI_USE_VERTEX=1` → Vertex URL + Bearer token via the exact GoogleAuth
    pattern already in `vertex-imagen.ts:33-56`.
  - Model id: `process.env.OMNI_MODEL || "gemini-omni-flash-preview"`.
  - Payload has NO resolution field and NO `delivery` field (neither
    exists); `duration` is formatted as a protobuf-Duration string (`"4s"`)
    under `response_format`.
  - Status map (AC6): `completed`→succeeded; `in_progress`→running;
    `failed|cancelled|budget_exceeded|incomplete|requires_action`→failed
    with surfaced message; unknown→running (route-level timeout is
    backstop).
  - Invalid AR throws before any network call.
- **`src/lib/providers/omni.test.ts`** (NEW): network-free, stubs
  `global.fetch` for the uri-download path; includes a negative host case
  (non-googleapis.com host → zero fetch calls, throws).

### Phase 3 — Route wiring
- **`src/app/api/generate/video/route.ts`**: Omni enqueue guard (AR /
  resolution / duration validated via the config helpers, 400 with a clear
  message — mirrors the existing Seedance Mini guard).
- **`src/app/api/queue/execute/route.ts`** `submitVideo`: new Omni branch
  before the `isHiggsfieldModel` branch —
  `assemblePrompt(prompt, await readAssets(), base.referenceImages ?? [],
  {aspectRatio, medium:"video"})` → `buildOmniInput` →
  `createOmniVideoTask` → taskId. Mock branch stays first and untouched
  (AC8).
- **`src/app/api/generate/video/status/route.ts`**: three-way branch —
  `isOmniModel` → `getOmniVideoStatus`; on succeeded, store via
  `saveBase64(base64, ext, id)` (ext from mime type: `webm` → `"webm"` else
  `"mp4"`); storage failure is a terminal failed item, not a silent
  swallow; failed → error + `moderationBlocked`; else keep polling.

### Phase 4 — Env, docs, ship
- `.env.local.example`: OMNI section — already present on disk from the
  pre-crash commit; verify, don't duplicate.
- CLAUDE.md: provider bullet — already present on disk; verify test-command
  line includes the new test files.
- `progress.md`: dated handoff entry.
- New feature branch, commit (no push without approval).

## Verification
1. `npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts src/lib/omni-input.test.ts src/lib/providers/omni.test.ts` — all green.
2. `npm run build` (de-facto typecheck) green.
3. `npm run db:seed` — Omni pricing row insert (onConflictDoNothing; may
   already exist from a prior partial run).
4. `npx tsx scripts/probe-omni.ts` — zero-cost validation matrix + Vertex
   readiness (re-confirms the PROBE VERDICTS above still hold).
5. Live test (authorized, ~$0.5–1): `probe-omni.ts --live`, or one in-app
   generation with an @tag reference — queued → completed playable mp4 via
   `/api/media/...` (AC1); log shows assembled groups (AC2); costCents =
   10 × duration (AC4).
