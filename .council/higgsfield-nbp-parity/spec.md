# Spec — Close the quality gap vs Higgsfield's Nano Banana Pro

## Problem

Same model (Nano Banana Pro / gemini-3-pro-image), same 3 reference images
(face @img1, outfit @img2, nightclub @img3), same user prompt — but Higgsfield's
output beats ours on:

1. **Subject prioritization / composition** — their subject is large, centered
   in the frame's power zone, tack sharp; ours (esp. output 2) renders the
   subject small and mid-distance in a 21:9 field, face barely resolved.
2. **Sharpness / no-blur** — their image is crisp edge-to-edge on the subject
   (fabric texture, jewelry, phone readable); ours are soft, with smeared
   backgrounds and plasticky skin.
3. **Scene accuracy / cleanliness** — theirs keeps the DJ booth, speaker
   stacks, crowd and red haze from the prompt AND the club reference legible;
   ours either washes everything in red murk (output 2) or drifts from the
   reference scene.

Reference generation rows (Postgres `generations`):
- Ours #1: `31d0523e-a795-42f4-b25d-fa04cdb531f5` (21:9, 2K)
- Ours #2: `3afb7c4a-c210-4b48-b57f-a3d3c3084d27` (21:9, 2K)
- Exact prompt and stored reference images are on those rows.

Terminology note (user said "vertex (?)"): our path is the
`generativelanguage.googleapis.com` endpoint, not Vertex — deliberately, since
Vertex gates 2K/4K (see `src/lib/providers/gemini.ts` header). The gap is not
the endpoint; it's what Higgsfield layers around the same model.

## Goal

(a) Establish, with evidence, what Higgsfield does between the user's prompt
and the NBP call (prompt enhancement, config, post-processing, candidate
selection). (b) Implement the learnable levers in our pipeline. (c) Prove the
improvement with A/B generations using the SAME refs + prompt as the rows above.

## Acceptance criteria

1. A written findings report: what Higgsfield does (verified where possible,
   clearly marked "inferred" where not).
2. Pipeline changes implemented behind our existing architecture (prompt
   assembler / provider / route), not hacks; unit-testable pieces unit-tested.
3. A/B evidence: ≥4 new-pipeline generations vs the 2 baseline images, judged
   on the three axes above (subject size/sharpness measurable via face-crop
   size + Laplacian variance; scene accuracy by inspection). New pipeline must
   clearly win on at least prioritization + sharpness without losing identity
   (face-judge score must not regress).
4. No regression to the existing @slug asset flow or video flow.

## Non-goals

- Switching providers/endpoints (Vertex, Higgsfield-for-everything). We keep
  the direct Gemini path — the point is to learn the technique.
- Matching Higgsfield pixel-for-pixel; "clearly closes the gap" is the bar.
- UI changes beyond (at most) an optional toggle if the design demands one.

## Stated assumptions (Decision Log candidates)

- A probe budget of ~15–25 NBP generations (≈ $3–6 at current pricing) is
  acceptable spend for the A/B evidence. 
- The two baseline rows above are the canonical "before" images.
- The user's Higgsfield result came from Higgsfield's own NBP flow with the
  same three references; we cannot see their internals, only infer + test.
