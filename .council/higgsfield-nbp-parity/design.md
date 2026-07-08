# Design — higgsfield-nbp-parity

Author: architect, 2026-07-08. Contract for implementers + test-engineer.
Grounded in: `spec.md`, `recon.md`, `research-higgsfield.md` (section C levers),
`decisions.md`, `assembled-payload.txt`, and the current code in
`src/lib/prompt-assembler.ts`, `src/lib/providers/gemini.ts`,
`src/app/api/generate/image/route.ts`, `src/lib/middleware/image-prep.ts`,
`src/lib/middleware/face-judge.ts`, `src/lib/mentions.ts`, `src/lib/config.ts`,
`src/components/PromptComposer.tsx`.

---

## Summary

We layer Higgsfield's *verified* techniques around the same Nano Banana Pro call
without switching endpoints: (1) a **deterministic shot-spec assembler** that
adds a role-labeled reference legend, wide-AR subject-framing language, and an
in-prompt NEGATIVE block — all as photography directives, with the raw user
prompt inserted verbatim as `SCENE:`; (2) **higher-fidelity references** (client
cap 1024→2048px with a payload-budget ladder, server `MAX_REF_DIM` already 2048)
so identity tiles cropped from them carry real facial pixel density; (3) a
**widened best-of-N judge** that scores identity + subject prominence + face
sharpness in one extended Gemini call and picks the best candidate *subject to an
identity floor* (so identity never regresses). Two experiments (classical
crisping, 4K→2K supersample) ship OFF behind flags. **Every behavior change is
gated by an env flag defaulting to today's behavior**, so Stage 2 can A/B old vs
new payload shapes against the real API cheaply.

Why deterministic over an LLM "prompt enhancer": the 2026-07 movie-camera
incident proved meta-instruction text gets rendered literally, and an LLM
rewrite risks paraphrasing the user's prompt (forbidden) and adds latency/drift.
The research shows the entire win is *structural* (legend + role labels + framing
+ negative) — all of which are templatable, auditable, and unit-testable without
an API key.

---

## Contradiction to flag (research vs code header)

`src/lib/middleware/image-prep.ts` header claims Higgsfield "render[s] at a
higher pixel budget." Verified research **A3.2** disproves this: 21:9@2k =
3168×1344 on both Higgsfield and our `generativelanguage` endpoint — *no hidden
resolution advantage*. The real input-quality gap is **reference fidelity**
(their uploads were 2–4× larger originals; ours were client-starved to ~1KP),
not render budget. This design acts on ref fidelity (lever 2) and treats the
"higher pixel budget" comment as stale. Implementers **may** correct that comment
while touching the file, but must not add any "render bigger than requested"
behavior on the strength of it. Do not silently reconcile — this is the flagged
discrepancy the task asked for.

---

## Env flags (all default to current behavior)

| Flag | Default | Effect when set |
|---|---|---|
| `PROMPT_SHOT_SPEC` | `"0"` | Assembler emits role-aware group headers + reference legend + wide-AR framing coda + NEGATIVE coda (new `shotInstruction`). Off = today's raw-prompt shape, byte-identical. |
| `PROMPT_ROLE_DETECT` | `"0"` | For `@imgN` uploads whose role can't be inferred from prompt text, run the extended detection schema (adds `role`) as a fallback, and log a cross-check WARN when detection role conflicts with prompt-text role. Only consulted when `PROMPT_SHOT_SPEC=1`. |
| `JUDGE_COMPOSITE` | `"0"` | Best-of-N uses `judgeCandidate` (identity + prominence + sharpness) and identity-floor selection. Off = existing identity-only `judgeIdentity`. |
| `POST_CRISPEN` | `"0"` | Classical same-size unsharp+light-denoise pass on the winning candidate before save (lever 4). |
| `SUPERSAMPLE` | `"0"` | Render one resolution step up, downsample to the requested size on delivery (lever 7). Not to be combined with best-of>1 at 2K (see latency budget). |
| `NEXT_PUBLIC_REF_MAX_DIM` | `"2048"` | Client reference longest-side cap (was hardcoded 1024). |
| `FACE_BEST_OF` | `2` (existing) | Unchanged knob. Default stays 2 (see latency arithmetic). |

Existing flags untouched: `FACE_CROP_MIDDLEWARE`, `MIDDLEWARE_DEBUG`,
`GEMINI_DETECT_MODEL`, `GOOGLE_API_KEY`. `MAX_REF_DIM` stays a module constant
(already 2048) — no change.

---

## File plan

Implementers may touch ONLY these files.

### New files

1. **`src/lib/shot-spec.ts`** — pure, server-safe, no API calls, no `sharp`.
   All deterministic text assembly for lever 1/5/6. Unit-testable without keys.
   Exports: `RefRole`, `LegendEntry`, `parseRefRoles`, `roleRule`, `roleHeader`,
   `buildReferenceLegend`, `buildFramingCoda`, `NEGATIVE_CODA`,
   `buildShotInstruction` (exact signatures below).

2. **`.council/higgsfield-nbp-parity/probe-ab.ts`** — Stage 2 A/B harness
   (lever 5). Reuses `assemblePrompt` + `generateImageGemini` + `judgeIdentity`,
   toggling env flags in-process; computes objective per-image metrics
   (identity, face-box fraction, face-region Laplacian variance) and writes a
   results table. Modeled on `scripts/ab-face-eval.ts`. ≤25 generated images.

3. **`src/lib/shot-spec.test.ts`** and **`src/lib/select-candidate.test.ts`** —
   unit tests using Node's built-in `node:test` + `node:assert` (run via
   `npx tsx --test`; no new dependency — `tsx` is already a devDependency and
   the repo is on Node 26). See test plan.

### Modified files

4. **`src/lib/prompt-assembler.ts`**
   - `assemblePrompt` gains an optional 4th arg `opts?: { aspectRatio?: string }`
     (backward compatible — existing 3-arg callers `ab-face-eval.ts`,
     `probe-payload.ts` keep working).
   - `AssembledPrompt` gains optional `shotInstruction?: string`.
   - When `PROMPT_SHOT_SPEC==="1"`: resolve a `RefRole` per group (from
     `asset.kind` for `@slug`; from `parseRefRoles`/person-detection for `@imgN`
     and `SUBJECT`), emit **role-aware** `group.header` via `roleHeader`, build a
     legend via `buildReferenceLegend`, and set
     `shotInstruction = buildShotInstruction({ rawPrompt: prompt, legend, aspectRatio })`.
   - When flag off: unchanged — same headers, `instruction`, `judgeFace`,
     `shotInstruction` left `undefined`. The dead `assetLines` array stays as-is.
   - `instruction` remains the raw prompt in BOTH modes (never overwritten).

5. **`src/lib/providers/gemini.ts`**
   - `buildParts`: use `assembled.shotInstruction` verbatim when present; else the
     current `groups.length ? \`SCENE: ${instruction}\` : instruction`.
     (`shotInstruction` already contains its own `SCENE:` — do not double-prefix.)
   - No change to image budgeting, retries, model id, or the FINAL CHECK part.

6. **`src/app/api/generate/image/route.ts`**
   - Direct-Gemini branch: pass `{ aspectRatio }` to `assemblePrompt`.
   - Best-of-N: when `JUDGE_COMPOSITE==="1"`, score via `judgeCandidate` and pick
     via `selectBestCandidate` (identity floor); else keep `judgeIdentity`.
   - After a winner is chosen: if `POST_CRISPEN==="1"`, run `crispen()` before
     `saveBase64`. If `SUPERSAMPLE==="1"`, render one step up and downsample
     (see data flow).
   - **Higgsfield branch (line ~93) is NOT changed** — it still calls the 3-arg
     `assemblePrompt` and reads `assembled.instruction` (raw). HF verbatim
     pass-through is preserved. Do not pass `aspectRatio` there.

7. **`src/lib/middleware/face-judge.ts`**
   - Add `judgeCandidate(refFace, candidate): Promise<CandidateScore | null>` —
     extends the SAME single Gemini call's JSON schema to
     `{identity, prominence, sharpness}` (0–100 each). No extra calls.
   - Add pure `selectBestCandidate(scores, slack): number`.
   - `judgeIdentity` unchanged (still used when `JUDGE_COMPOSITE` off).

8. **`src/lib/middleware/image-prep.ts`**
   - Add `crispen(mimeType, base64): Promise<PreppedImage>` (classical sharpen +
     light denoise; fail-open). Called only when `POST_CRISPEN=1`.
   - Add `detectReferenceRole(mimeType, base64): Promise<RefRole | null>`, used
     only when `PROMPT_ROLE_DETECT=1`. It extends the detection prompt to also
     return `"role"`. It is an ADDITIVE function (its own call); `identityCrops`
     and `detectIdentityBoxes` are otherwise unchanged.
   - Optionally fix the stale "higher pixel budget" header comment (doc only).
   - `MAX_REF_DIM` stays 2048.

9. **`src/components/PromptComposer.tsx`**
   - `downscaleImage`: `MAX_DIM` reads `NEXT_PUBLIC_REF_MAX_DIM` (default 2048).
   - `addImageFiles`: batch payload-budget ladder — encode all refs, sum bytes,
     step quality/dimension down until under the Vercel budget (algorithm below).

**Explicitly not touched:** `src/app/api/generate/video/route.ts` (its
`prepReference` use is unrelated), `src/lib/mentions.ts` (role parsing lives in
the new `shot-spec.ts` to keep `mentions.ts` a stable shared client/server util),
`src/lib/config.ts`, the @slug asset DB path, the Higgsfield MCP provider.

---

## Interfaces

### `src/lib/shot-spec.ts` (new, pure)

```ts
export type RefRole = "person" | "outfit" | "location" | "style" | "prop" | "object";

export interface LegendEntry {
  tag: string;        // "@img1" | "@priya" | "SUBJECT"
  role: RefRole;
  isPerson: boolean;  // drives identity language in the legend line
}

/** Deterministic role inference from prompt prose. For each @imgN / @slug tag
 *  occurrence, scan a small word window around the mention for role keywords
 *  (outfit|dress|garment|wearing|lehenga|saree|suit…; location|nightclub|club|
 *  place|background|room|set|environment…; style|aesthetic|grade|palette…;
 *  face|identity|person|character|portrait|likeness…). First match wins.
 *  Tags with no inferable role are OMITTED from the map (caller falls back).
 *  Pure; no API. Case-insensitive. */
export function parseRefRoles(prompt: string): Map<string, RefRole>;

/** The reproduction rule sentence for a role (reuses the KIND_RULE wording
 *  already proven in prompt-assembler.ts for character/outfit/location/style/prop). */
export function roleRule(role: RefRole): string;

/** Role-aware group header (replaces the generic "@imgN — REFERENCE (reproduce
 *  this subject exactly; if a person…)" for uploads). Example person header:
 *  "@img1 — FACE/IDENTITY reference (N images): reproduce this exact individual …". */
export function roleHeader(tag: string, role: RefRole, imageCount: number): string;

/** "REFERENCES:\n@img1 = the exact face/identity of the subject …\n@img2 = …"
 *  Returns null for an empty list. */
export function buildReferenceLegend(entries: LegendEntry[]): string | null;

/** Wide-AR subject-framing coda (photography language only). Non-null ONLY for
 *  "16:9" and "21:9"; null for square/portrait ARs. */
export function buildFramingCoda(aspectRatio: string): string | null;

/** In-prompt NEGATIVE block, photography-phrased. Constant. */
export const NEGATIVE_CODA: string;

/** Compose the final structured instruction. rawPrompt is inserted VERBATIM.
 *  Layout:
 *    <legend?>\n\n
 *    SCENE: <rawPrompt>\n\n
 *    <framingCoda?>\n
 *    AVOID: <NEGATIVE_CODA>
 *  buildShotInstruction owns the "SCENE:" prefix so gemini.buildParts must not
 *  re-add it. */
export function buildShotInstruction(args: {
  rawPrompt: string;
  legend: string | null;
  aspectRatio: string;
}): string;
```

Non-negotiable: `buildShotInstruction` must contain `rawPrompt` as a contiguous,
unmodified substring. A unit test asserts `result.includes(rawPrompt)`.

### `src/lib/prompt-assembler.ts` (changed)

```ts
export interface AssembledPrompt {
  instruction: string;          // UNCHANGED: always the raw prompt
  shotInstruction?: string;     // NEW: structured text, only when PROMPT_SHOT_SPEC=1
  groups: AssembledGroup[];
  judgeFace?: AssembledImage;
}

export async function assemblePrompt(
  prompt: string,
  assets: Asset[],
  uploads: string[],
  opts?: { aspectRatio?: string },   // NEW, optional, default {} → "1:1"
): Promise<AssembledPrompt>;
```

### `src/lib/middleware/face-judge.ts` (changed)

```ts
export interface CandidateScore {
  identity: number;    // 0–100, same forensic rubric as judgeIdentity
  prominence: number;  // 0–100: how large/near/centered the subject's face is
  sharpness: number;   // 0–100: crispness of the subject's FACE region (not whole frame)
}

/** One extended Gemini-2.5-flash call. Returns null on any failure (fail-open,
 *  same as judgeIdentity). */
export async function judgeCandidate(
  refFace: JudgeImage,
  candidate: JudgeImage,
): Promise<CandidateScore | null>;

/** Pure selector. Among candidates whose identity is within `slack` of the max
 *  identity (the identity FLOOR — guarantees identity never regresses vs the
 *  identity-only picker), choose the highest composite = prominence + sharpness.
 *  Ties break toward higher identity, then lower index. Nulls score as -1 and
 *  are only picked if all are null. Returns the winning index. */
export function selectBestCandidate(
  scores: Array<CandidateScore | null>,
  slack?: number,   // default 8
): number;
```

### `src/lib/middleware/image-prep.ts` (added)

```ts
/** Classical same-size "crisping" pass approximating the observed Topaz recipe
 *  (sharpen ~0.3–0.5, denoise ~0.1–0.2, no face_enhancement, NO repaint).
 *  Uses sharp.median(1) (light denoise) then sharp.sharpen({sigma:~1, m1, m2}).
 *  Never resizes. Fail-open → returns the input unchanged on error. */
export async function crispen(mimeType: string, base64: string): Promise<PreppedImage>;

/** Extended-schema role classifier for an upload (person/outfit/location/style/
 *  prop/object). Used ONLY as the PROMPT_ROLE_DETECT fallback. Returns null when
 *  unavailable (no key / HTTP error / parse fail). */
export async function detectReferenceRole(mimeType: string, base64: string): Promise<RefRole | null>;
```

### `src/app/api/generate/image/route.ts` (delivery post-processing)

`SUPERSAMPLE`: `resolutionToImageSize` returns the requested size `R`. When
`SUPERSAMPLE=1` and `R !== "4K"`, request the next step up (`1K→2K`, `2K→4K`),
then downsample the delivered image to `R`'s pixel dimensions with
`sharp(...).resize({ ..., fit:"inside", kernel:"lanczos3" })` before `saveBase64`.
Billing uses the *rendered* size (higher), consistent with the existing
"bill what actually ran" pattern.

### Client (`PromptComposer.tsx`) budget ladder

Vercel body limit 4.5MB; base64 inflates ~1.33×, so the raw-bytes budget across
all refs is ~3.38MB. Target ≤ **3.0MB** total encoded to leave headroom for the
prompt JSON. Algorithm in `addImageFiles`:

1. Encode every ref at `dim=NEXT_PUBLIC_REF_MAX_DIM(2048)`, JPEG `q=0.85`.
2. Sum encoded bytes. If ≤ 3.0MB → done.
3. Else re-encode all at `q=0.7`. If ≤ 3.0MB → done.
4. Else re-encode all at `dim=1536, q=0.8`. If ≤ 3.0MB → done.
5. Else `dim=1024, q=0.8` (the current behavior — guaranteed floor that always fit).

Byte size is measured from the dataURL length (`(len*3)/4` for base64). This
guarantees the request never exceeds the limit while keeping typical 1–3 ref
uploads at full 2048px fidelity — the density that identity tiles are cropped
from.

---

## Data flow

### Direct Nano Banana Pro path (image route → gemini)

1. Route reads body → `assemblePrompt(prompt, assets, uploads, { aspectRatio })`.
2. Assembler builds groups exactly as today (readAll → prepReference cap 2048;
   faceCrops → identity tiles). **If `PROMPT_SHOT_SPEC=1`:** for each group it
   resolves a `RefRole` (precedence: `parseRefRoles(prompt)` → if
   `PROMPT_ROLE_DETECT=1` and still unknown, `detectReferenceRole` → if
   person-detected/`identity`, `person` → else `object`; `@slug` roles come
   straight from `asset.kind`), rewrites `group.header` via `roleHeader`, builds
   `legend`, and sets `shotInstruction`. `instruction` stays raw. `SUBJECT`
   (untagged uploads) → role `person`.
3. `generateImageGemini` → `buildParts` uses `shotInstruction` if present, else
   the current shape. Images/tiles budgeting, MAX_IMAGES=14, retries unchanged.
4. Best-of-N (only when `judgeFace` exists, i.e. a person ref produced tiles —
   note `assembled-payload.txt` shows `judgeFace:false` because the local probe
   had no `GOOGLE_API_KEY`; in prod with a key, tiles+judgeFace exist per recon
   fact 1). `bestOf = min(4, max(1, FACE_BEST_OF||2))` parallel generations via
   `Promise.allSettled`.
5. Scoring: `JUDGE_COMPOSITE=0` → `judgeIdentity` per candidate + argmax (today).
   `JUDGE_COMPOSITE=1` → `judgeCandidate` per candidate (parallel) →
   `selectBestCandidate(scores, 8)`.
6. Winner: if `POST_CRISPEN=1`, `crispen()`; if `SUPERSAMPLE=1`, already rendered
   one step up → downsample. `saveBase64` → persist item.

### Error paths (all fail-open, preserving today's guarantees)

- Detection / role classification unavailable → no tiles / role falls back to
  `person` (if identity) or `object`; generation still proceeds.
- `parseRefRoles` finds nothing → generic per-role fallback; never throws.
- All best-of candidates rejected → rethrow first rejection (unchanged).
- `judgeCandidate` returns null for all → `selectBestCandidate` returns index 0
  (first successful candidate) — same graceful degradation as today's null-score
  argmax.
- `crispen` / supersample downsample error → return the original winning bytes.
- Client budget ladder exhausts to 1024 → guaranteed under limit (current
  behavior is the floor, so no regression risk).

### PROMPT_ROLE_DETECT cross-check

When both a prompt-text role and a detection role exist and **conflict**, the
prompt-text role WINS (it is the user's explicit binding contract and matches how
they wrote the SCENE), and a `console.log("[shot-spec] WARN role mismatch …")` is
emitted. This surfaces the baseline data bug (recon fact 3: stored `@img2` is the
nightclub image while the prompt says "outfit from @img2") to humans without
silently "fixing" a user upload-ordering mistake. No behavior branches on the
warning.

---

## Latency budget (hard constraint: `maxDuration = 60s`)

Wall-clock for the direct path with best-of-N:

- Pre-generation (in `assemblePrompt`): `prepReference` (sharp, ~sub-second) +
  identity detection, currently **sequential per ref** at `thinkingBudget:0`
  (~3s each). 3 refs ≈ **~9–12s**.
- Generation: `bestOf` requests run in **parallel** (`Promise.allSettled`), so
  wall time ≈ the **slowest single** 2K generation ≈ **30–50s** (independent of
  N). One transient-retry inside `generateImageGemini` adds ≤2s.
- Judging: N calls in **parallel**, gemini-2.5-flash ≈ **~3–5s**.
- **Worst case at N=2, 2K:** ~12 + 50 + 2 + 5 ≈ **~69s → over budget in the tail.**

Consequences and mitigations baked into this design:

1. **Keep `FACE_BEST_OF` default at 2 and best-of at 2K.** Raising N does NOT
   grow generation wall time (parallel) but increases tail-latency risk (more
   parallel calls → higher chance one is slow/rate-limited, and `allSettled`
   waits for all). N up to 4 remains available via the knob for hero shots on a
   deployment with a higher `maxDuration`.
2. **`SUPERSAMPLE` (4K render) must not be combined with best-of>1.** A single 4K
   render alone approaches the 60s ceiling. Guidance documented; operationally
   set `FACE_BEST_OF=1` when `SUPERSAMPLE=1`.
3. The pre-generation detection sequence is the compressible slack. It is
   **out of scope** to parallelize here (pre-existing behavior), but flagged as
   the first optimization if the tail proves fatal in Stage 2 — parallelizing the
   per-ref detection reclaims ~6–8s.

The A/B **probe harness runs offline** (no 60s limit), so it can measure N=4 and
4K freely; the 60s constraint binds only the production route.

---

## Probe harness (`.council/higgsfield-nbp-parity/probe-ab.ts`)

Purpose: prove new-shape beats old-shape on prioritization + sharpness without
losing identity, using the SAME refs + prompt as the baseline rows.

- Loads the baseline prompt (the `PROMPT` constant from `probe-payload.ts`) and
  `ref-1.jpg…ref-3.jpg` from the council dir as data URLs. Verifies
  `GOOGLE_API_KEY` is present in `.env.local` (per decisions.md #7); if empty,
  prints a clear message and exits 0 without spending (do not block silently).
- For each variant it sets env flags in-process, calls `assemblePrompt(...,{aspectRatio:"21:9"})`
  then `generateImageGemini`, and records objective metrics per image:
  - **identity** via `judgeIdentity(refFace, candidate)` (existing judge; refFace
    from `identityCrops` on ref-1, as `ab-face-eval.ts` does).
  - **faceBoxFraction** — the harness makes its own gemini-2.5-flash face-box
    detection call on the generated frame; fraction = `((xmax-xmin)/1000) *
    ((ymax-ymin)/1000)`. (Prominence proxy — recon: subject size.)
  - **faceLaplacianVar** — crop the detected face box with `sharp.extract`,
    `.greyscale().convolve({width:3,height:3,kernel:[0,1,0,1,-4,1,0,1,0]}).raw()`,
    compute the variance of the resulting pixels. **Face-region only**, never the
    whole frame (recon fact 6: whole-frame Laplacian rewards murky grain).
- Writes `results-ab.md` (table: variant, sample, identity, faceBoxFraction,
  faceLaplacianVar, dims, ms) + `results-ab.json`, and saves each JPEG.

**Sample plan (≤25 images):**

| Variant | Flags | Samples |
|---|---|---|
| OLD | all off (today's shape) | 4 |
| NEW | `PROMPT_SHOT_SPEC=1`, `JUDGE_COMPOSITE=1` | 4 |
| NEW+crispen | + `POST_CRISPEN=1` | 4 |
| NEW+supersample | `PROMPT_SHOT_SPEC=1` + `SUPERSAMPLE=1` (4K→2K) | 4 |

= **16 generated images** (budget headroom ~9). The 2 existing baseline rows
(`baseline-1.jpg`, `baseline-2.jpg`) are scored with the same metrics for
reference at **zero** new spend. Report per-variant means; success = NEW's
faceBoxFraction and faceLaplacianVar clearly exceed OLD's while identity mean ≥
OLD's.

**Known limitation (must be stated in the report):** the saved `ref-*.jpg` are
the *already client-starved 1024px* stored references (recon fact 2); the
original high-res uploads were never persisted server-side. Therefore lever 2
(reference fidelity) **cannot be A/B'd from these artifacts** — the harness
measures levers 1/3/4/7 at fixed 1024px fidelity. Validating lever 2 requires the
user to re-supply original-resolution references (drop them in as
`ref-hi-1.jpg…`); the harness accepts an optional `PROBE_HIRES_DIR` to run the
same OLD/NEW comparison at 2048px. If not supplied, report lever 2 as
"implemented, not yet A/B-validated."

---

## Test plan

Framework: `node:test` + `node:assert/strict`, run with `npx tsx --test
src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts` (no new dependency;
Node 26 + existing `tsx`). All unit tests run **without** `GOOGLE_API_KEY`.

### `shot-spec.test.ts` (pure)
- `parseRefRoles` on the baseline prompt → `@img1:person, @img2:outfit,
  @img3:location` (the exact prompt from `assembled-payload.txt`).
- `parseRefRoles` returns an empty/omitted entry for a tag with no role keyword.
- `parseRefRoles` is case-insensitive and window-bounded (a keyword far from the
  tag does not bind).
- `buildShotInstruction` **contains the rawPrompt verbatim** (substring assert) —
  the core "never paraphrased/dropped" guarantee.
- `buildFramingCoda("21:9")` and `("16:9")` non-null; `("1:1")`, `("9:16")`,
  `("3:4")` null.
- `buildShotInstruction` output contains `SCENE:` exactly once and the legend +
  `AVOID:` block when provided.
- `roleHeader("@img2","outfit",1)` mentions "outfit" and not person/face language.

### `select-candidate.test.ts` (pure)
- Identity floor honored: `[{id:90,pr:10,sh:10},{id:85,pr:99,sh:99}]`, slack 8 →
  picks index 1 (85 within 8 of 90, wins on composite).
- Floor excludes: `[{id:90,…low},{id:70,…high}]`, slack 8 → picks index 0
  (70 outside floor). **Guards identity regression.**
- All-null → returns 0.
- Mixed null + scored → ignores nulls; picks best eligible.
- Tie on composite → higher identity, then lower index.

### Route / integration (manual + probe)
- No new integration test framework. The probe harness is the integration proof.
- Sanity: with all flags off, `assemblePrompt` output equals today's (a golden
  snapshot test in `shot-spec.test.ts` may assert `shotInstruction===undefined`
  and headers unchanged when `PROMPT_SHOT_SPEC` unset).

---

## Trade-offs (decisions someone could reasonably make differently)

1. **Deterministic template vs LLM-structured shot spec.** Chosen: deterministic.
   LLM structuring would adapt phrasing per prompt but adds a call (latency),
   risks paraphrasing the user's words (spec-forbidden), risks the movie-camera
   literal-rendering failure, and is non-reproducible for A/B. The research shows
   the win is structural, which templates capture fully.
2. **Client 2048 + budget ladder vs out-of-band ref upload.** Chosen: raise the
   cap + budget ladder. Out-of-band (client→storage→URLs) escapes the 4.5MB limit
   entirely but adds signed-URL/CORS/lifecycle/failure surface for a case that
   2048px + ladder already covers for typical 1–3 ref uploads. Revisit only if
   users routinely need many high-res refs.
3. **One extended judge call vs separate metric calls / local pixel metrics in
   the hot path.** Chosen: extend the single judge call. Adding per-candidate
   detection + Laplacian in the route would blow the 60s budget. The *objective*
   pixel metrics live in the offline probe, which validates that the LLM judge's
   prominence/sharpness track reality.
4. **Identity-floor selection vs weighted sum.** Chosen: floor. A weighted sum
   could silently trade identity for sharpness; the floor makes "identity must
   not regress" (a hard acceptance criterion) structurally guaranteed.
5. **Prompt-text role primary, detection role optional.** Chosen: prompt-text
   first. In the common case (and the baseline) the user states roles in prose;
   detection adds latency/cost and can't read intent. Detection is an opt-in
   fallback + cross-check, not the default.
6. **Role legend AND role-aware headers (some redundancy).** Kept both: the
   legend gives the model an up-front map (the winning Higgsfield pattern), the
   headers bind at each image site. Both are cheap text; research says the legend
   is exactly what wins.

---

## Out of scope

- Switching endpoints (Vertex/Higgsfield-for-everything) — decisions.md #1.
- Parallelizing per-ref detection in `assemblePrompt` (flagged as the latency
  fallback if Stage 2 shows the tail exceeds 60s; not done pre-emptively).
- Real Topaz/`upscale_image` MCP integration for hero exports — `crispen` is the
  classical local approximation only.
- Persisting original-resolution uploads server-side (would enable retroactive
  lever-2 A/B) — a storage-lifecycle change beyond this feature.
- Any UI beyond the client ref-cap change (no new toggles; flags are env-only).
- Changing the video route, the @slug asset authoring flow, or the Higgsfield
  provider path.
- Fixing the `/api/media/**` public-access observation (decisions.md #5).

## Risks

1. **60s tail (highest risk).** Best-of-N + detection + judge can approach the
   Vercel ceiling. Mitigated: default N=2 at 2K, parallel gen+judge, SUPERSAMPLE
   excluded from best-of, and a named fallback (parallelize detection) if Stage 2
   measurements exceed budget. The probe surfaces real per-image `ms`.
2. **Shot-spec text rendered literally (movie-camera repeat).** Mitigated:
   photography-only phrasing bound to references, no meta/domain-lock blocks,
   raw prompt verbatim, and the whole shape flag-gated + A/B-validated before any
   default flip.
3. **Lever 2 not A/B-verifiable from saved refs** (they're pre-starved).
   Mitigated: documented; harness supports an optional hi-res dir; the client fix
   is a monotonic fidelity improvement regardless.
4. **Composite judge picks a worse-identity frame.** Mitigated by the identity
   floor + a unit test proving exclusion beyond `slack`.
5. **Role misinference / baseline ref-order bug.** Mitigated: conservative
   keyword windows (omit when unsure), prompt-text precedence, and a logged
   cross-check WARN that exposes upload-order mistakes without silent correction.
6. **Stale header claim ("higher pixel budget") misleads a future implementer.**
   Mitigated: flagged in its own section above; no behavior derived from it.
7. **Client budget ladder still too big with many refs.** Mitigated: ladder
   floors at today's 1024px/q0.8, which already fit — worst case equals current
   behavior, never worse.
