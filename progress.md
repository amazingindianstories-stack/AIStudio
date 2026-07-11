# Session Progress & Handoff

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
