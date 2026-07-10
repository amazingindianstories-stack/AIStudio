# A/B results — higgsfield-nbp-parity

Run: 2026-07-10T07:01:06.239Z · total wall 785s · new-generation spend ≈ 364¢

faceBoxFraction = detected face area / frame area (subject prominence).
faceLaplacianVar = laplacian variance on the FACE crop of the full-res frame (sharpness).
identity = judgeIdentity vs the @img1 face crop (0–100).

| variant | sample | identity | faceBoxFrac | faceLapVar | dims | ms |
|---|---|---|---|---|---|---|
| BASELINE | baseline-1.jpg | 90 | 0.97% | 209.9 | 3168×1344 | 0 |
| BASELINE | baseline-2.jpg | 100 | 12.52% | 811.9 | 3168×1344 | 0 |
| HFCONTROL | hf-control-1.png | 85 | 1.96% | 203.5 | 3168×1344 | 0 |
| HFCONTROL | hf-control-2.png | 98 | 15.92% | 126.2 | 3168×1344 | 0 |
| OLD | old-1 | 95 | 3.33% | 259.2 | 3168×1344 | 26319 |
| OLD | old-2 | 25 | 1.05% | 697.1 | 3168×1344 | 57084 |
| OLD | old-3 | 80 | 1.94% | 80.8 | 3168×1344 | 85834 |
| OLD | old-4 | 20 | 1.41% | 248.7 | 3168×1344 | 114222 |
| NEW | new-1 | 95 | 3.98% | 238.8 | 3168×1344 | 28828 |
| NEW | new-2 | 0 | —% | — | 3168×1344 | 53331 |
| NEW | new-3 | 98 | 0.66% | 412.6 | 3168×1344 | 79733 |
| NEW | new-4 | 95 | 9.46% | 303.1 | 3168×1344 | 115668 |
| NEWSS | newss-1 | 30 | 2.91% | 252.3 | 3168×1344 | 35984 |
| NEWSS | newss-2 | 95 | 3.50% | 7.6 | 3168×1344 | 68902 |
| NEWSS | newss-3 | 98 | 19.22% | 95.2 | 3168×1344 | 102962 |
| NEWSS | newss-4 | 90 | 3.24% | 166.6 | 3168×1344 | 135533 |
| NEWCRISP | crisp-new-1 | 98 | 3.74% | 293.4 | 3168×1344 | 109 |
| NEWCRISP | crisp-new-2 | 0 | —% | — | 3168×1344 | 110 |
| NEWCRISP | crisp-new-3 | 75 | 0.74% | 531.0 | 3168×1344 | 123 |
| NEWCRISP | crisp-new-4 | 15 | 0.43% | 611.3 | 3168×1344 | 116 |
| HFMIMIC | hfmimic-1 | 95 | 2.86% | 783.0 | 3168×1344 | 27818 |
| HFMIMIC | hfmimic-2 | 95 | 1.16% | 217.8 | 3168×1344 | 50337 |
| HFMIMIC | hfmimic-3 | 25 | 1.00% | 271.8 | 3168×1344 | 79697 |
| HFMIMIC | hfmimic-4 | 95 | 1.59% | 243.8 | 3168×1344 | 105129 |

## Per-variant means

| variant | n | identity | faceBoxFrac | faceLapVar |
|---|---|---|---|---|
| BASELINE | 2 | 95.0 | 6.75% | 510.9 |
| HFCONTROL | 2 | 91.5 | 8.94% | 164.9 |
| OLD | 4 | 55.0 | 1.93% | 321.4 |
| NEW | 4 | 72.0 | 4.70% | 318.2 |
| NEWSS | 4 | 78.3 | 7.22% | 130.4 |
| NEWCRISP | 4 | 47.0 | 1.64% | 478.6 |
| HFMIMIC | 4 | 77.5 | 1.65% | 379.1 |

Limitation: refs are the client-starved 1024px stored copies — lever 2 (ref fidelity)
is not A/B-testable from these artifacts (design.md §Probe harness).

## Interpretation (orchestrator, after visual verification of every frame)

**Metric reliability caveats, established by this run:**
- The identity judge is noisy on single calls: the NEWCRISP rows are the SAME
  pixels as NEW (plus a mild sharpen with no visible halos — verified on
  matched face crops of new-4 vs crisp-new-4) yet re-scored 98/0/75/15 vs
  95/0/98/95. Treat identity means as ±15.
- The face detector sometimes locks onto a background dancer (crisp-new-4
  0.43% vs new-4 9.46% — same image), so single faceBoxFrac rows can be wrong;
  means over 4 are directionally useful.
- faceLaplacianVar does not compare across images even on face crops (murky
  baseline-2 scores 812; the visibly sharp hf-control-2 scores 126) — grain
  reads as "sharpness". Useful only for same-image comparisons
  (crispen: 293→611 on identical content = real crisping).

**What the run actually shows (metrics + eyeballing all 20 frames):**
1. NEW (shot-spec) beats OLD on the target axes: subject prominence mean
   4.70% vs 1.93% (2.4×), usable frames 3/4 vs 1/4, identity mean 72 vs 55
   (i.e. no regression, judge noise notwithstanding). new-4 is the best
   like-for-like frame of the run: correct outfit + jewelry, prominent
   subject at the booth, sharp.
2. NEWSS (shot-spec + 4K→2K supersample) has the highest prominence (7.22%,
   matching HFCONTROL's 8.94%) and newss-3 is the most striking frame overall
   — but newss-3 also DROPPED the @img2 outfit (black top instead of brown
   lace). Supersample amplifies the framing push; scene-accuracy risk at
   n=4. Keep OFF by default, use for hero shots with human curation.
3. HFMIMIC (their minimal payload on our endpoint) produced clean, accurate,
   sharp frames — visually indistinguishable in character from the paid
   HFCONTROL images — but with SMALL subjects (1.65%), like hf-control-1.
   Conclusion: Higgsfield's edge is not hidden prompt magic (their shape
   reproduces their look on our key), and our scaffolding was not the main
   composition problem either — the model simply defaults to distant subjects
   at 21:9 unless the prompt pushes prominence (the framing coda does).
4. crispen() is a real, artifact-free micro-contrast gain at ~110ms. Safe as
   an opt-in delivery pass.
5. hf-control-2 / baseline-2 / newss-3 all show: when the subject is large,
   identity+sharpness read well. Subject scale is the master variable —
   exactly what PROMPT_SHOT_SPEC's framing coda targets.

**Acceptance vs spec.md:** ≥4 new-pipeline images generated (16), compared
against both baselines and both HF controls; identity did not regress
(NEW ≥ OLD on mean, floor logic unit-tested); prioritization/sharpness
improved on the target variants. Lever 2 (ref fidelity) implemented but not
A/B-validated — needs the user's original hi-res refs (PROBE_HIRES_DIR).