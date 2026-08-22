# Style drift + video quality parity — implementation plan

Triggered by a real observed case: a 21:9 2K Nano Banana Pro storyboard (4-panel, "Ulluman_2D" project) generated with a face reference plus several additional reference images, showing visible style drift both within the image and reported in video too.

This plan has two parts: (A) a root-cause diagnosis and fix for the style-drift defect specifically, grounded in how the reference-role code actually behaves today; (B) the broader video-quality-parity roadmap already discussed, folded in and sequenced around the fix.

---

## Part A — Style drift: diagnosis

### A1. What the screenshots show

Five reference images attached: one is clearly a character/face portrait, the others look like mood/location/style boards (one sepia-toned, one dark/night). The prompt panel shows a short instruction ("Create one single 2×2 storyboard image containing four continuous cinematic frames, no text anywhere in the image.") — no visible `@img1`/`@img2`-style tagging distinguishing which reference is for what.

### A2. Image path root cause (`prompt-assembler.js`)

When references are uploaded **without explicit `@imgN` tags**, the assembler doesn't run per-image role classification on each one — it makes ONE decision for the whole batch:

```
} else {
  const images = await readAll(uploads);
  ...
  const tiles = await faceCrops(images, "SUBJECT");
  if (hasVisiblePeople(prompt) || tiles.length > 0) {
    await pushLegacySubject(images, tiles);   // <- ALL images treated as
  }                                             //    "multiple angles of
  ...                                           //    the SAME person"
```

This branch exists for a real, common case (a few selfies of one person, no tags needed) — but it means: if **any** face is detected anywhere in the uploaded batch, or the prompt text implies a person at all, **every image in that batch** — including ones meant purely as style/mood/location references — gets folded into a single "SUBJECT — these are all reference angles of the same person" group. The style board never gets its `KIND_RULE.style` treatment ("match this exact visual style — same rendering, palette, grain and lighting") at all; it gets told to contribute to a face identity it isn't a photo of. That's a direct, mechanical explanation for style drift: the actual style reference's content is being misused, not ignored.

This is untagged-upload-specific. If the artist writes `@img1` for the face and `@img2 in this exact style` (or similar) for the mood board, `resolveUploadRole` picks up "style" from the keyword scan and the correct `roleHeader`/`KIND_RULE.style` text gets attached to that image specifically. The bug is really a **silent fallback that only shows up when references are mixed and untagged** — which is exactly the workflow in the screenshot.

### A3. Video path root cause (`video-directive.js`)

This is structurally weaker than the image path, by design. There is **no per-reference role distinction at all** in the video directive — `styleLock()` and `identityLock()` both address the *entire* reference set as one undifferentiated group:

> "the reference images define the visual style of this shot... Reproduce their medium and rendering exactly"
> "the reference images define the exact, fixed appearance of the people and elements they show"

Disambiguation depends entirely on the user manually writing provider-specific tags (`<<<image_1>>>`/`[image 1]`) into their own prompt text, in order. The code comment explains why there's no vision-based role classification here: it would cost a real API call against the same rate-limited Gemini key the spend-gate protects, and "the model can already see the reference." That's a reasonable cost tradeoff, but it means: attach a photoreal face portrait alongside a painterly mood board with no explicit tagging, and the model receives two contradictory "follow the reference style" signals with no structured way to know which one should win. Video is more exposed to this than images, not less — and it matches the report of drift being visible in video too.

### A4. Fix proposals

**Near-term (UX, no model-shape change, ships fast):** Make reference tagging feel required, not optional, in the composer. When 2+ references are attached and the prompt contains no `@img` tags at all, surface an inline nudge ("Tag your references so each one is used correctly — try `@img1` for the face, `@img2 for the exact style`") before submit, rather than silently guessing. This alone would have caught the exact case in the screenshot.

**Real fix (image path):** Stop making one decision for the whole untagged batch. Run `detectReferenceRole` (or the existing face-detection signal) **per image** even in the untagged multi-upload branch, instead of only on `images[0]` and only when the *first* image reads as non-person. Concretely: for each untagged upload, classify individually; group images that read as "person" into the SUBJECT treatment, and route anything that reads as style/location/prop into its own labeled group with the matching `KIND_RULE`. This removes the "one face anywhere poisons the whole batch" failure mode without requiring the user to change behavior.

**Real fix (video path):** Extend `buildVideoDirective`'s `refCount` model to accept a lightweight per-reference role hint (reusing the same role inference already built for images — `parseRefRoles`/`resolveUploadRole` — rather than a new vision call, so it stays free). When roles are known, emit a short per-reference legend before the style/identity locks (mirroring `shot-spec.js`'s `buildReferenceLegend`) so `styleLock` can say "match the style of the STYLE-tagged reference specifically" instead of "match the references' style" as an undifferentiated group. When no roles are resolvable (today's behavior), fall back to the current generic wording — byte-identical for existing untagged-single-reference callers, so this is additive, not a rewrite.

This item — giving video the same role-aware reference legend images already have — was already flagged as the top-priority gap in the parity research from earlier in this conversation (video scaffolding is "reasoned, not measured"; this is the concrete first thing to measure and fix).

---

## Part B — Full implementation plan

### Phase 1 — Style-drift fix (do first: it's an active, observed defect)

| # | Item | Effort | Files |
|---|---|---|---|
| 1.1 | Composer nudge: warn when 2+ untagged references are attached | S | `PromptComposer.jsx` |
| 1.2 | Per-image role classification for untagged multi-upload batches | M | `prompt-assembler.js`, `shot-spec.js` (reuse `detectReferenceRole`) |
| 1.3 | Role-aware reference legend for the video directive | M–L | `video-directive.js`, `omni-input.js` (already has it via shot-spec — confirm parity), `providers/seedance.js`, `providers/higgsfield-mcp.js` |
| 1.4 | Unit tests pinning both fixes against the exact failure mode (mixed untagged batch, face + style board) | S | `prompt-assembler.test.js`, new `video-directive.test.js` cases |

### Phase 2 — Close the measured/reasoned gap for video (from earlier research)

| # | Item | Effort | Notes |
|---|---|---|---|
| 2.1 | Temporal-staging + motion vocabulary pass on `video-directive.js`, mirroring `shot-spec.js`'s rigor | M | Structured shot language: staged movement markers, explicit camera vocabulary when the prompt doesn't already supply it |
| 2.2 | In-prompt negative block for video-specific failure modes, expanded beyond identity/wardrobe drift to cover **style/grade drift across frames** — directly relevant given this defect | S | `VIDEO_NEGATIVE_CODA` equivalent in `video-directive.js` |
| 2.3 | Live Higgsfield MCP job-history probe for Seedance jobs (same technique as `research-higgsfield.md`), to separate "fixable by engineering" from "access-tier ceiling" | S (probe is free) | Needs `hf:login` credentials |

### Phase 3 — Structural quality levers (from earlier research)

| # | Item | Effort | Notes |
|---|---|---|---|
| 3.1 | Thread `seed` through provider payloads + persist on `generations` row + "regenerate with same seed" UI action | M | `gemini.js`, `kling.js`, `seedance.js`, `omni.js`, `schema.js`, `store.js` |
| 3.2 | Extend best-of-N + `judgeCandidate`-style scoring to video (frame-extracted judge) | L | New scoring path; video candidates cost more, so likely N=2 default, flag-gated |
| 3.3 | Multi-shot chaining using `return_last_frame`/first-frame continuation (already supported by BytePlus's API, unused today) | M | `providers/seedance.js`, new composer UX for "continue this shot" |
| 3.4 | Turn `ab-face-eval.js` into a committed-fixture regression harness (`npm run eval:regression`), gated in CI | M | Reuses existing `judgeCandidate` — mostly wiring, not new capability |
| 3.5 | Lightweight "flag this generation" signal (separate from favorite), captured with prompt/model/references/scores, feeding 3.4's fixture set over time | S | `schema.js`, `store.js`, small UI addition |

### Suggested sequencing

Phase 1 first — it's the only phase fixing something users are actively hitting today, and 1.3 doubles as the foundation 2.1 needs anyway (temporal-staging work is pointless if reference roles are still ambiguous underneath it). Phase 2 next, since it directly targets the recurring Higgsfield/Dreamina comparison with the same rigor that already worked for images. Phase 3 is the durable infrastructure layer — highest total leverage, but each item stands alone and can slot in around Phase 1/2 work rather than blocking it.

---

## Open question before starting

1.3 (video reference-role legend) is the piece with the most design surface — it touches both Seedance call sites and needs to stay backward-compatible with `SEEDANCE_LEGACY_DIRECTIVE=1`. Want me to start there, or start with 1.1/1.2 (the smaller, faster image-path fix) first and land something shippable today while 1.3 gets designed properly?
