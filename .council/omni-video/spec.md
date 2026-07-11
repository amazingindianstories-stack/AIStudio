# Spec: Gemini Omni Flash video generation ("Google Omni")

> Rebuilt 2026-07-11 after the original `.council/omni-video/` working set was
> lost (client crash — "cantigravity" — before the Stage 4 commit landed).
> Content below is unchanged from the original approved spec; reconstructed
> from the pre-compaction conversation record, not re-derived. See
> `decisions.md` decision D0 for the rebuild note.

## Problem

Lumina's video models (Higgsfield Seedance 2.0, Seedance 2.0 Mini) bypass the
NBP-grade prompt/reference system entirely — flat reference roles, no shot-spec
scaffolding, no identity tiles. The user wants Google's new **Gemini Omni
Flash** (`gemini-omni-flash-preview`, Interactions API) added as a selectable
video model, built with the same rigor as the Nano Banana Pro image path:
full `assemblePrompt()` + shot-spec reference scaffolding, param parity with
the existing video routes, billing on the GCP project, and a real generation
test as proof.

## Desired behavior

- A new video model, "Gemini Omni Flash", appears in the model picker
  alongside the existing two Higgsfield video models.
- Selecting it constrains aspect ratio to what the model actually supports
  (16:9 / 9:16 — probed, not assumed) and duration/resolution to its real
  contract.
- Prompts sent to Omni are assembled via the same `assemblePrompt()` used by
  Nano Banana Pro: role-labeled reference groups, identity tiles, shot-spec
  framing coda and in-prompt NEGATIVE block — not a flat hand-rolled string.
- Generation billing lands on the GCP project the API key belongs to (Vertex
  SKU preferred if reachable, else the Gemini API SKU — both bill to GCP).
- Failure states (moderation block, provider error, storage failure) surface
  as a failed `GenerationItem`, consistent with the rest of the app.
- A live end-to-end generation (queued → completed → playable video) is run
  once as proof, not just unit tests.

## Acceptance criteria

- **AC1**: A real (non-mocked) generation through the app produces a
  playable video file, served through `/api/media/...`, referenced from a
  completed `GenerationItem`.
- **AC2**: The assembled prompt sent to Omni for a request containing @tag
  references shows role-labeled groups (CHARACTER/OUTFIT/LOCATION/...) and, for
  a locked face, identity tiles — provably reusing `assemblePrompt()`, not a
  parallel hand-rolled prompt path.
- **AC3**: Requesting an aspect ratio or resolution Omni doesn't support is
  rejected before any network call, with a clear 400 message (mirrors the
  existing Seedance Mini guard).
- **AC4**: Cost is computed via the existing `pricing` table
  (`computeCostCents`, no special-casing) and billed per second of requested
  duration.
- **AC5**: Adding the video framing/negative scaffolding to `shot-spec.ts` /
  `prompt-assembler.ts` does not change a single byte of existing (image,
  default-medium) output — all pre-existing shot-spec/prompt-assembler tests
  keep passing untouched.
- **AC6**: Provider status polling maps every documented Interactions API
  status (`in_progress|completed|failed|cancelled|incomplete|
  budget_exceeded|requires_action`) to the app's `running|succeeded|failed`
  states with no unhandled case falling through silently.
- **AC7**: `OMNI_USE_VERTEX=1` switches the wire path to Vertex AI (OAuth2,
  GoogleAuth) with zero behavior change to prompt assembly or the route
  layer — purely a transport swap, flag-gated because Vertex Omni access is
  allowlist-gated and this machine's Vertex creds are currently dead.
- **AC8**: `MOCK_GENERATION=1` continues to work unmodified — the mock branch
  short-circuits before any Omni-specific dispatch code runs.

## Non-goals

- Conversational video editing (`previous_interaction_id` chaining).
- Video-upload-as-input editing (`task: edit`).
- Audio control.
- Best-of-N for video (no judge pass — video generation is priced and timed
  too high for parallel candidates; may revisit later).
- Migrating Nano Banana Pro images to Vertex (counter-indicated by the
  measured findings already documented in `gemini.ts`'s file header).
