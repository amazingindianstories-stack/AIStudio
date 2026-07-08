# Research — what Higgsfield actually layers around Nano Banana Pro

Author: research agent, 2026-07-08. All MCP probes were READ-ONLY
(`tools/list`, `models_explore`, `show_generations`, `job_status`,
`list_workspaces`); zero credits spent. Evidence dumps live next to this file
(`mcp-*.json`); probe scripts are `probe-mcp-*.ts` (run with `npx tsx`).

---

## A. VERIFIED findings

### A1. The full `generate_image` MCP surface — there is no secret knob

`tools/list` returned 72 tools (full dump: `mcp-tools-full.json`).
`generate_image`'s input schema is only:

```
params: {
  model:        string   (required)
  prompt:       string
  count:        integer  1–4, default 1        ← we never use this
  aspect_ratio: string
  medias:       [{ value: media_id|job_id, role: string }]
  get_cost:     boolean  (preflight, no job)
  ...additionalProperties (per-model params from the catalog)
}
```

The per-model catalog (`models_explore get nano_banana_pro`,
`mcp-model-nano_banana_pro.json`) adds exactly ONE parameter for NBP:
`resolution: 1k|2k|4k` (default 1k), media role `image`, aspect ratios
1:1 … 21:9. **No prompt-enhance flag, no negative_prompt, no seed, no
style/quality knobs, no upscale option exists for NBP.** (`enhance_prompt`,
`seed`, `style`, `color_preset` exist only on Higgsfield's own
`soul_cinematic`; camera params only on `cinematic_studio_image`. See A4.)

### A2. Higgsfield does NOT rewrite NBP prompts — proven from stored jobs

We paginated the account's real generation history (800 image jobs back to
2026-06-23, `mcp-history-all.json`) and pulled raw FNF payloads
(`job_status {raw_data:true}` → `mcp-rawjob-*.json`):

- `params.prompt` stored server-side is **verbatim** what was typed — this
  includes jobs our own Lumina pipeline submitted through the MCP on
  2026-07-03 (e.g. job `2c617016-1f6d-41cf-9af2-8d19018656d1`, whose stored
  prompt begins with our own "DOMAIN LOCK — FILMMAKING ONLY…" preamble,
  unchanged).
- Raw payloads have `meta: null`, `debug: null`, `result_json: null` — no
  hidden "final prompt" field, no enhancement trace.
- Website "Nano Banana Pro" = `job_set_type: "nano_banana_2"`,
  `display_name: "Nano Banana Pro"` (same Google model family; MCP id
  `nano_banana_pro` lands in the same history). Google is listed as
  provider in the catalog.

Higgsfield's own prompt guide corroborates: no auto-enhancement is described;
the guide teaches USERS to write structured prompts
(https://higgsfield.ai/nano-banana-pro-prompt-guide).

### A3. What Higgsfield's platform DOES add (all verified)

1. **Batch candidates + human curation.** Website jobs carry
   `batch_size: 1|2|4` (our histogram over 800 jobs: 597×1, 175×2, 20×4);
   pairs/quads share identical `createdAt`. MCP `count` maxes at 4. The user
   generates multiples and picks — human best-of-N.
2. **Explicit pixel budget per job.** Every job stores concrete
   `width/height`: 21:9 @ 2k = **3168×1344**, @ 4k = 6336×2688 — identical to
   what our generativelanguage endpoint returns. **No hidden resolution
   advantage.**
3. **Reference preprocessing.** Uploaded refs appear in `input_images[]` as
   `…_resize.jpg` CloudFront URLs — Higgsfield normalizes/resizes uploads, and
   users can chain a previous job (`type: nano_banana_2_job`) as a reference
   at full output resolution (3168×1344 refs, vs our 1024px-starved uploads —
   see recon.md fact 2).
4. **`<<<image_N>>>` prompt-to-reference binding** (we already mirror this in
   `toHiggsfieldTags`). Confirmed in ~all reference-carrying website jobs.
5. **A separate, user-invoked Topaz enhancement stage.** Tool `upscale_image`
   (ByteDance) plus catalog models `topaz_image` and `topaz_image_generative`
   (`mcp-model-topaz_image*.json`):
   - `topaz_image`: variant `Standard V2 | Low Resolution V2 | CGI |
     High Fidelity V2 | Text Refine`, `sharpen 0–1`, `denoise 0–1`,
     `face_enhancement` + creativity/strength 0–1, arbitrary output size.
   - `topaz_image_generative`: variant `Standard MAX | Redefine | Recovery |
     Recovery V2`, `autoprompt` (auto-generates a guiding prompt from the
     image!), `creativity 1–6`, `texture 1–5`.
   - **This account used it 7 times on NBP outputs** — including SAME-SIZE
     passes (3168×1344 → 3168×1344, sharpen 0.3–0.5, denoise 0.1–0.2,
     Standard V2): a pure "crisping" pass, not an upscale.
   - Partnership is public: Higgsfield "Upscale" is powered by Topaz Labs
     (PetaPixel 2025-08-06:
     https://petapixel.com/2025/08/06/higgsfield-ai-brings-topazs-industry-leading-photo-and-video-upscaling-to-the-web/ ;
     https://higgsfield.ai/upscale). Their upscaler is Topaz/ByteDance — not
     Magnific (correcting the earlier memory note).
6. **Preset interception.** generate_* can return a "looks like preset X"
   notice (we already decline via `declined_preset_id`). There is also a
   hidden NBP variant `nano_banana_2_shots` (display name "Nano Banana Pro",
   media role `image_references`, aspect `auto`) — the "Shots" feature that
   wraps NBP with Higgsfield-authored shot/preset prompts. Presets are
   Higgsfield-side prompt text, not model config.

### A4. How the user's WINNING Higgsfield prompts differ from our baseline

The history is a goldmine: the same human gets Higgsfield-quality results by
writing **structured shot specifications**, e.g. the 7-reference boat scene
(job `372c73e4-12e6-4c44-b304-4a6cc0ca9aa5`, 21:9/2k):

- opens with a **legend** mapping every `<<<image_N>>>` to a role
  ("= Naisha character reference", "= final … environment", "= exact
  character blocking map only");
- explicit **blocking + scale** commands ("Keep the boat medium-sized in
  frame, not huge", "correct head size", "not pasted");
- explicit **lighting integration** ("Match the warm sunset lighting from
  <<<image_4>>> on their skin…");
- a long **NEGATIVE PROMPT** paragraph (in-prompt text — remember: the API
  has no negative_prompt param, and it demonstrably works well enough);
- camera/film-stock language on environment prompts ("ARRI Alexa 35, Cooke
  anamorphic, 2.39:1, soft highlight rolloff, open shadows, gentle film
  grain").

Versus our baseline instruction (see `assembled-payload.txt`): one breathless
sentence, "She stands near a DJ booth in the corner…", zero framing/shot-size
language, subject placed "in the corner" of a 21:9 canvas — the model did
exactly what was asked and made a wide environmental shot with a small,
under-resolved face.

Note: the user's actual Higgsfield club generation is **not** in this
account's 800-job history (searched: "THIS EXACT FACE", "DJ booth", "onyx",
"silhouettes of dancers" — 0 hits). It was made elsewhere (other account) or
pre-2026-06-23. `higgsfield.png` here is 1920×815 (screen-res re-save), so we
cannot verify whether THAT image got a Topaz pass. Recovery path: Higgsfield
result filenames embed the job id (`hf_YYYYMMDD_HHMMSS_<jobid>.png`) — if the
user still has the original download, `job_status` on that id yields the
exact submitted params.

### A5. Google-side facts (docs)

- **candidateCount > 1 is rejected by Gemini 3 models** (400 error) — API
  best-of-N must be parallel requests
  (https://ai.google.dev/gemini-api/docs/gemini-3).
- Official reference-image guidance for gemini-3-pro-image: up to **6 object
  references, 5 character-consistency images, 3 style references**; the model
  runs default-on "thinking", generating interim images to refine composition
  (https://ai.google.dev/gemini-api/docs/image-generation).
- Google's own prompt template = **Subject / Composition / Action / Location /
  Style**, plus camera-angle + lighting refinement
  (https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/).
- Google's stated limitation: the model "can still struggle with **small
  faces**, accurate spelling, and fine details" — i.e. a small subject in a
  21:9 field is expected to have a mushy face; the fix is making the face
  bigger in frame, not more identity text.
- Higgsfield's prompt guide mirrors this and adds: numeric aspect ratios in
  the prompt, lens/aperture language "to enforce realistic volumetric
  depth", command-style syntax, negative constraints
  (https://higgsfield.ai/nano-banana-pro-prompt-guide).

---

## B. INFERRED (likely, not proven)

1. **The comparison image was probably curated and possibly Topaz-crisped.**
   The user's habitual Higgsfield workflow (batch 2–4, rapid retries at
   12:08:00/:01/:10, 7 Topaz passes incl. same-size sharpen) means their
   "one" Higgsfield image is typically the best of several, sometimes
   post-sharpened. Confidence: high for curation, medium for Topaz on this
   specific image.
2. **Prompt style is the dominant composition/scene factor.** Same model,
   same pixels, verbatim prompt pass-through on both paths → the remaining
   deltas are prompt content, reference fidelity, and selection. The user's
   Higgsfield prompts are 10–30× longer and art-directed; our pipeline sends
   the raw short prompt plus identity boilerplate that contains **zero**
   composition language. Confidence: high.
3. **Reference input quality mattered.** Higgsfield fed ~3MP refs (or
   full-res chained job outputs); our client downscale starved refs to ~1KP
   (recon.md fact 2), so identity tiles carry less facial detail — soft,
   plasticky faces follow. Confidence: high (mechanism verified, magnitude
   untested).
4. **`nano_banana_2_shots` / presets inject Higgsfield-authored shot language**
   (framing, lens, lighting) when users pick a "Shot". If the user's club
   image came from a Shots/preset flow, the composition boost was literally
   extra prompt text. Confidence: medium (schema + preset notice verified;
   usage in that image unknown).
5. **No system prompt channel.** MCP exposes none, and stored payloads show
   none; the website most likely calls the same job service (`fnf`) with the
   same param shape. Confidence: medium-high.

---

## C. Ranked levers for OUR pipeline

Axes: P = subject prioritization/composition, S = sharpness/no-blur,
A = scene accuracy/cleanliness. (H/M/L = expected impact.)

1. **Composition-aware prompt assembly** (P:H, S:M, A:H).
   Assemble the instruction as a shot spec, Google/Higgsfield style:
   reference legend ("image 1 = face of X — reproduce exactly"), then
   Subject → shot size/framing ("medium-wide shot, she fills the left third,
   waist-up, face clearly resolved"), Action, Location (from the club ref),
   Lighting, Style ("cinematic nightlife photography, 35mm, f/2, crisp focus
   on her face"), then a NEGATIVE PROMPT block ("no murky red wash over the
   whole frame, no soft/plastic skin, no tiny distant subject…"). At wide ARs
   ALWAYS emit explicit subject-size language — this is the direct antidote to
   the small-face weakness Google itself documents. Keep it photography
   language (recon.md L4 caution) and keep the user's literal content intact.

2. **Fix reference fidelity** (S:H for faces, P:–, A:M).
   Undo the ~1KP client downscale (raise cap to 2048px within the 4.5MB body
   budget, or upload out-of-band); send the face tile from the highest-res
   source available. Higgsfield's inputs were 3MP+; ours were 0.5–1MP.
   (= recon.md L1; this research confirms Higgsfield resizes but from larger
   originals, and chains full-res job outputs as refs.)

3. **Widen best-of-N judging beyond identity** (P:H, S:H, A:M).
   We already run best-of-2; Higgsfield's edge is the human picking on
   composition+sharpness. Score candidates on face-crop size (subject
   prominence) + face-region Laplacian (NOT whole-frame — recon.md fact 6) +
   identity; consider N=3–4 for hero shots (candidateCount>1 is banned, so
   parallel requests; ~21¢ per 2K candidate).

4. **Optional same-size "crisping" pass** (S:H, P:0, A:0 — must not repaint).
   Replicate the user's observed Topaz recipe: same-resolution enhance,
   sharpen ≈0.3–0.5, denoise ≈0.1–0.2, face_enhancement off. Cheapest
   faithful approximation: classical unsharp-mask/clarity on the subject, or
   call Higgsfield's `topaz_image` via MCP for hero exports (extra credits,
   external dependency). This is post-processing — it cannot fix composition,
   so rank it below 1–3. Avoid generative variants (Redefine/creativity>1)
   which repaint and can drift identity.

5. **In-prompt negative prompt block** (A:M, P:L, S:L).
   Verified user practice on the same model; costs nothing. Target the known
   failure ("red murk over everything") with motivated-lighting language:
   "red haze as atmosphere near the DJ booth; overall scene stays legible; no
   monochrome red wash".

6. **Role-aware reference headers** (A:M, P:L, S:L).
   The user's Higgsfield prompts label refs by ROLE (character / environment
   / prop / blocking map). Our baseline sent "reproduce this subject exactly;
   if a person…" for a nightclub and an outfit (recon.md fact 3). Emit
   person/outfit/location-specific headers (= recon.md L3), and keep
   character refs within Google's documented 5-character / 6-object budget.

7. **2K + supersample instead of native 4K** (S:M).
   The user's own pattern: generate 2K, Topaz to 6336×2688 when needed. Our
   L2 equivalent (render 4K, deliver downsampled) is worth A/B'ing, but is
   secondary to 1–4.

Non-levers (disproven): secret Higgsfield prompt rewriting (A2), hidden model
params (A1), a resolution advantage (A3.2), Magnific-style proprietary
upscaler (it's Topaz/ByteDance, A3.5), server-side auto-enhance for NBP
(`enhance_prompt` exists only for soul_cinematic).

---

## Evidence index

| File | What it proves |
|---|---|
| `mcp-tools-full.json` | full 72-tool schema dump (generate_image: count 1–4, no other knobs) |
| `mcp-model-nano_banana_pro.json`, `mcp-model-nano_banana_2.json` | NBP catalog: resolution only |
| `mcp-model-topaz_image*.json` | Topaz enhance/upscale param surface |
| `mcp-model-soul_cinematic.json` | where enhance_prompt/seed/style actually live |
| `mcp-models-image.json` | all 30 image models incl. `nano_banana_2_shots`, `image_auto` |
| `mcp-history-all.json` | 800 stored jobs: verbatim prompts, batch_size, width/height, `_resize.jpg` refs, Topaz usage |
| `mcp-rawjob-*.json` | raw FNF payloads: `meta/debug/result_json: null`, no hidden prompt |
| `probe-mcp-schema.ts` … `probe-mcp-models.ts` | reproducible read-only probes |
