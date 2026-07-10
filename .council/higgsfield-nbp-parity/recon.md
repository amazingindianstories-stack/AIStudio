# Recon — what actually happened in the baseline generations

Baseline rows: `31d0523e` (ours #1), `3afb7c4a` (ours #2). Both: model
"Nano Banana Pro" (direct generativelanguage, NOT Vertex), 21:9, "2K"
(actual output 3168×1344), 3 refs, prompt as in spec.md. costCents=42 each.

## Facts established

1. **Best-of-2 DID run in production.** 2K image = 21¢; rows billed 42¢ →
   two candidates were generated and the face-judge picked one. So the gap is
   NOT "we forgot best-of-N". (FACE_BEST_OF is unset in prod → default 2.)
   judgeFace exists only when identity tiles were produced → face detection
   classified @img1 (character sheet) as a person in prod and tiles were sent.
   (My local probe showed "no tiles" only because GOOGLE_API_KEY is empty
   locally — Vercel-sensitive env vars can't be pulled.)

2. **References were starved to ~1KP before the model saw them.** Stored refs:
   sheet 1024×572, club 1024×534, outfit 681×1024. The client downscales
   uploads (commit 44a4b2b) to dodge Vercel's 4.5MB body limit. The face panel
   inside the 1024-wide sheet is ~350px; the identity tile cropped from it
   carries little detail. Higgsfield received the user's originals (likely
   2–4× larger). Server-side cap is 2048px (MAX_REF_DIM) — the client cap is
   the binding constraint.

3. **Ref/tag mismatch in the baseline inputs**: stored order is
   @img1=character sheet, @img2=NIGHTCLUB, @img3=OUTFIT — but the prompt says
   "outfit from @img2 … nightclub from @img3". The model coped semantically,
   but every group header told it "reproduce this subject exactly; if a
   person, the same individual…" for a LOCATION and an OUTFIT too — generic,
   role-less binding for @imgN uploads (role-labeled headers exist only for
   @slug assets with kinds).

4. **Instruction = raw user prompt** (by design, after the movie-camera
   incident). No composition/framing/quality language is added. At 21:9 the
   model tends to render the subject small/mid-distance (ours #2), and
   nothing in the payload pushes subject prominence.

5. **Prior verified R&D** (header of src/lib/middleware/image-prep.ts, from
   probing Higgsfield's stored generation params via their MCP): Higgsfield
   does NO prompt rewriting (verbatim pass-through), DOES resize refs
   (`…_resize.jpg`), and renders at a HIGHER PIXEL BUDGET. Their advantage is
   therefore in inputs quality + render budget + (possibly) selection/post,
   not secret prompt magic.

6. **Output measurement**: whole-frame Laplacian variance does NOT track the
   perceived gap (the murky baseline-2 scores highest due to grain). Any A/B
   sharpness metric must be computed on the subject/face region, and/or an
   LLM judge should rank composition/subject-sharpness explicitly.

## Control generations (2026-07-10, 2 paid runs, user-approved)

`hf-control-1.png` / `hf-control-2.png` — Higgsfield `nano_banana_pro` at
21:9/2k, jobs `1ea32472…` / `84ade7fc…`, fed the SAME starved 1024px stored
refs (imported via `media_import_url` from our public media proxy) and the
SAME raw prompt (with `@imgN` → `<<<image_N>>>` binding, their observed
convention). Results:

7. **Dimensions 3168×1344 — identical to ours.** Re-confirms research A3.2:
   no hidden render-budget advantage.
8. **Both controls are dramatically better composed than our baselines
   despite identical refs and prompt**: subject prominent (roughly
   one-half to two-thirds frame height, near the DJ booth/speakers as
   prompted), face crisp, clean red-haze grading, correct outfit and
   nightclub. 2/2 vs our 0/2 (small sample, but the delta is stark).
   This means ref starvation is NOT the main driver of the composition gap,
   and "their originals were bigger" cannot be the whole story either.
   The remaining payload difference is ours vs theirs:
   - theirs: ONE text part — the prompt with inline `<<<image_N>>>`
     bindings — plus the 3 refs. Nothing else.
   - ours: `SCENE:`-prefixed instruction + per-group role-less REFERENCE
     headers + identity tiles (face crops) + FINAL CHECK text part.
   Hypothesis for Stage 2: our extra scaffolding (generic headers, flat
   face tiles, FINAL CHECK) dilutes/derails composition at wide ARs; their
   minimal inline-binding shape leaves the model free to compose. The A/B
   MUST include an "HF-mimic minimal payload" variant (probe-side only:
   single text part with inline bindings, refs in order, no tiles) alongside
   the design.md shot-spec variant.
9. **media_upload / media_import_url failures are a stale-token trap**: the
   MCP returns generic "Something went wrong" tool errors that actually wrap
   a 401 (`structuredContent.errorCode: 401`) — `.higgsfield-mcp-token.json`
   stores no `obtained_at`, so a days-old `access_token` looks fresh.
   Local probes must refresh first. (Node 26 undici also cannot read this
   server's aborted SSE streams at all — curl `--http1.1 -N` tolerating exit
   18/56 is the working local transport.)

## Candidate levers (for the architect, pending research-agent findings)

- L1 Raise/remove the client ref downscale (bigger refs → denser tiles):
  either raise the cap toward 2048px + JPEG quality tuning within the 4.5MB
  budget, or upload refs out-of-band (e.g. client → storage direct, send
  URLs) to escape the body limit entirely.
- L2 Render at 4K and deliver downsampled (supersampling for sharpness);
  measure cost delta (4K = 28¢ vs 2K 21¢ per candidate).
- L3 Role-aware binding for @imgN uploads: we already run detection per
  upload; classify person/outfit/location/style and emit the same role rules
  the @slug asset path uses; optionally cross-check against what the prompt
  text claims each tag is.
- L4 Composition nudge for wide ARs phrased as photography language (never
  meta-instruction blocks) — must be A/B'd against literal-rendering drift.
- L5 Widen the best-of judge beyond identity: subject-region sharpness +
  scene-compliance so murky/soft candidates lose even when the face matches.
- L6 Optional post sharpen/clarity pass on delivery — only if research shows
  Higgsfield does post-processing.
