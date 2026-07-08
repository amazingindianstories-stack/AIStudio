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
