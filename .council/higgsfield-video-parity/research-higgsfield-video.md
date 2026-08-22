# Research — Higgsfield/Seedance video parity (Phase 2.3)

Author: research agent, 2026-08-17. Same technique as
`.council/higgsfield-nbp-parity/research-higgsfield.md` (2026-07-08, image-side),
applied to video. All MCP probes were READ-ONLY (`show_generations`,
`job_status`, `models_explore`, tool-whitelisted in code) — zero credits
spent, no `generate_*` call made. Evidence dumps live next to this file
(`mcp-*.json`); probe script is `probe-mcp-video.js` (run with `npx tsx`,
executed by the user locally — this sandbox has no egress to
`mcp.higgsfield.ai`).

Goal (per the implementation plan's Phase 2.3): separate **fixable by
engineering** (something our own pipeline can do today) from **access-tier
ceiling** (something only available through Higgsfield's own account/plan).

---

## A. VERIFIED findings

### A1. Seedance via Higgsfield MCP is the same ByteDance model family we already call directly — no secret fine-tune

Every Seedance catalog entry (`seedance1_5`, `seedance_2_0`, `seedance_2_0_mini`,
`seedance_2_5`) reports `provider_name: "Bytedance"` (`mcp-model-seedance*.json`).
1160 of this account's 1200 real video jobs (96.7%) are Seedance; the
remainder are Higgsfield's own in-house `cinematic_studio_*` models (19
jobs) plus a handful of other third-party models (Kling, Grok Video, Wan,
MiniMax — `mcp-history-video-all.json`). This matches the image-side
research's A2 finding for Nano Banana Pro: for the overwhelming majority of
real usage, Higgsfield is a wrapper around the same base model we call
ourselves, not a different or fine-tuned one.

### A2. `generate_audio` — CLAUDE.md's claim is wrong, and it's not a small gap

CLAUDE.md's video-directive section states: *"Higgsfield's MCP Seedance
tools expose no audio parameter."* This is false. Every Seedance catalog
entry documents `generate_audio` as a real, optional boolean parameter,
**defaulting to `true`**:

```
"generate_audio": { "type": "bool", "default": true,
  "description": "Generate native audio for the video. Set false for a silent video." }
```

Real usage: **1159 of 1160 Seedance jobs (99.9%) have `generate_audio: true`**
— including **all 9 of our own historical Lumina-submitted jobs** (identified
by the DOMAIN LOCK / FILMMAKING ONLY / IDENTITY LOCK preamble that
`buildVideoDirective` prepends). Our own `mcpGenerateVideo` in
`providers/higgsfield-mcp.js` never sets `generate_audio` at all — every job
we've ever submitted through this path got audio by Higgsfield's own silent
default, not by our control. The composer's `generateAudio` toggle
(`supportsAudio()` in `config.js`) is wired to the native BytePlus path only;
it's inert on the Higgsfield path.

Practical urgency is low today — Higgsfield is already out of the model
picker (2026-07-30), so no new jobs go through this path — but the CLAUDE.md
claim is a documentation bug regardless, and matters again the moment
Higgsfield is ever re-enabled.

### A3. `bitrate_mode` — a real, catalog-documented lever we never send, and 75% of real usage picks the option we skip

Every Seedance catalog entry (except `seedance1_5`) documents:

```
"bitrate_mode": { "type": "string", "options": ["standard","high"], "default": "standard",
  "description": "'standard' = normal output bitrate; 'high' = higher bitrate output." }
```

Real usage across 1160 Seedance jobs:

| bitrate_mode | count | share |
|---|---|---|
| `"high"` | 869 | 74.9% |
| `"standard"` | 158 | 13.6% |
| unset (mini variant, no such param) | 133 | 11.5% |

Our own `mcpGenerateVideo` never sends `bitrate_mode` — every job we submit
silently gets the catalog default, `"standard"`, the option only 13.6% of
real jobs deliberately choose. Of our own 9 historical jobs, 7 landed on
`"standard"` (the silent default) and only 1 explicitly got `"high"` (and
that one was likely the one job where a Higgsfield staff/website flow
touched it, not our pipeline). **This is the single clearest, lowest-risk,
highest-confidence lever this probe found**: catalog-documented, zero new
UI surface needed (can default to `"high"` outright, or expose it), matches
what real practitioners overwhelmingly choose.

Not yet confirmed whether the raw BytePlus ModelArk API (`providers/seedance.js`'s
native, non-Higgsfield path) also accepts a `bitrate_mode`-equivalent field —
see B2.

### A4. Our default video duration (5s) sits far below where real, higher-performing usage clusters

`DEFAULTS.video.duration` in `config.js` is **5 seconds**. Real Seedance
usage:

| duration (s) | count | share |
|---|---|---|
| 15 (the max for seedance_2_0) | 811 | 69.9% |
| 10 | 108 | 9.3% |
| 8 | 53 | 4.6% |
| 5 (our default) | 43 | 3.7% |
| everything else (4,6,7,9,11–14,30) | 145 | 12.5% |

Duration is user-controlled per generation, so this isn't a bug — but the
account's own highest-volume pattern (and, per the sample winning prompt in
A6, the duration multi-shot staging actually needs room to work) sits at the
15s ceiling, nearly 3× our default. Flagging as a product/defaults question,
not auto-changing it.

### A5. Prompt length is NOT the video-side gap — unlike images

The image research (A4/B2 in `research-higgsfield.md`) found the user's
winning Higgsfield image prompts were **10–30× longer** than our baseline.
Video does not replicate this pattern:

| | count | mean chars | median chars |
|---|---|---|---|
| our 9 historical jobs | 9 | 5,237 | — |
| the other 1,151 real jobs | 1,151 | 5,242 | 4,659 |

Our own prompt (user text + `buildVideoDirective`'s scaffolding) is already
in the same length range as real, high-performing manually-authored
prompts. Whatever gap exists on the video side is structural/content, not
volume — which is exactly what Phase 1 (role legend) and Phase 2.1/2.2
(temporal staging, camera vocabulary, expanded AVOID) already targeted, not
a new "make it longer" lever.

### A6. Real winning prompts stage multiple shots in PROSE, not via the structured multi-shot API fields — validates 2.1's approach

The raw job payloads (`mcp-rawjob-*.json`) reveal a full structured
multi-shot surface in the API: `multi_shots` (bool), `multi_shot_mode`
(string), `multi_prompt` (array), `speedramp` (string). **None of it is used
in real practice**: `multi_shots` is `true` in **0 of 1,160** Seedance jobs;
`speedramp` is `"auto"` in all 1,160.

Instead, the account's own most sophisticated real prompt sampled here (a
15s, 1080p, 21:9, `bitrate_mode:"high"` job — full text in
`mcp-history-seedance.json`, job `843f7467-…`) stages three distinct shots
with hard cuts, each carrying its own approximate second count ("SHOT 1 —
ESTABLISHING WIDE — approx. 2 seconds", "SHOT 2 — OTS ON SHIV — approx. 3
seconds", "SHOT 3 — OTS ON SATI — approx. 10 seconds", summing to the
requested 15s) — entirely inside the single `prompt` string, no structured
field involved. It also opens with a per-reference character legend
(`SATI = woman from <<<image_1>>>`, `SHIV = man from <<<image_2>>>`) —
structurally the same pattern Phase 1.3 just added to our own directive —
and closes with a prompt-specific constraints/negative paragraph.

This is a direct, real-world validation of two decisions already made this
phase: `video-directive.js`'s per-reference role legend (1.3) mirrors what
real winning prompts already do by hand, and `TEMPORAL_STAGING`'s
self-conditional design (2.1 — "apply ONLY where the PROMPT does not
already stage the action over time... follow the PROMPT's own pacing
instead") is the right call, not the structured `multi_shots` API that zero
real jobs actually use.

### A7. Two Seedance variants exist via Higgsfield MCP that our own `MODEL_IDS` map doesn't know about

`seedance1_5` ("Seedance 1.5 Pro") and `seedance_2_5` ("Seedance 2.5") both
appear in the live catalog and in real job history (1 job each in this
account's history — low volume, but real). `providers/higgsfield-mcp.js`'s
`MODEL_IDS` only maps `"Higgsfield Seedance 2.0"` → `seedance_2_0` and
`"Higgsfield Seedance 2.0 Mini"` → `seedance_2_0_mini`. Moot while Higgsfield
is out of the model picker (2026-07-30); worth remembering if it's ever
re-enabled — note that our own native `providers/seedance.js` already
supports 2.5 directly against BytePlus (`SEEDANCE_MODEL_25`), so this is a
Higgsfield-MCP-path-only gap, not a capability gap overall.

### A8. Higgsfield's "Elements" system is conceptually the same thing our `@slug` saved assets already do

`reference_elements` (Higgsfield's reusable character/prop/environment
references, injected via `<<<element_id>>>` placeholders — see
`show_reference_elements` in `mcp-tools-full.json`) is used in 94 of 1,160
jobs (8%). This is the same idea as this app's own `assets` table /
`@priya`-style saved references. Not a gap — confirms our identity/asset
model is already aligned with how the platform's power users work.

### A9. Post-processing upscale/enhance exists but is barely used on video (unlike images)

`topaz_video`, `bytedance_video_upscale`, `video_upscale` all exist in the
video model catalog, mirroring the image-side Topaz finding (A3.5 in the
original research). Real usage: **2 jobs total** across the whole 1,200-job
video history. Low-confidence, low-priority — do not chase this before
items 1–3 below.

---

## B. INFERRED / needs confirmation

### B1. This account previously had (and currently does not have) a Higgsfield "unlimited" plan tier

Every Seedance catalog entry carries an `unlim` block, and **currently
reports `"available": false, "remaining": null"`** for this account. Yet the
full video history contains **83 `seedance_unlimited` and 40
`seedance_mini_unlimited` jobs** — a materially different model id, only
explainable by the account having had an active "unlimited" subscription
perk at some point that funded those 123 generations. This is a genuine
**access-tier ceiling**, not an engineering gap — it's a billing/plan
question for whoever owns the Higgsfield account relationship, not something
this codebase can work around. Confidence: high on "the perk existed and is
gone"; unconfirmed on why (expired trial, unrenewed plan, promotional
window).

### B2. Whether `bitrate_mode` exists on the raw BytePlus ModelArk API (independent of Higgsfield) is unconfirmed

A3's finding is proven for the **Higgsfield MCP path** (catalog + 1,160 real
jobs). It is **not yet verified** whether `providers/seedance.js`'s native,
direct-to-BytePlus path (`ARK_API_HOST`, no Higgsfield involved) accepts an
equivalent field — the ModelArk docs page
(`https://console.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1520757`)
is client-rendered and returns an empty shell to a plain fetch (same issue
already documented in CLAUDE.md for the Kling docs — needs Claude-in-Chrome
or a real, billed probe to resolve). Wiring `bitrate_mode` into the
Higgsfield MCP path is safe to do without this; wiring it into the native
BytePlus path should wait for one of those two verifications, per this
codebase's own working convention ("back provider/payload changes with
official docs or an empirical probe script").

---

## C. Ranked levers (fixable-by-engineering, prioritized)

1. **Send `bitrate_mode: "high"` on the Higgsfield MCP path** (A3). Catalog-documented, zero new UI required, matches 75% of real usage vs. the 13.6% who'd pick our current silent default. Lowest risk, highest confidence item in this probe. **S effort.**
2. **Wire the composer's `generateAudio` toggle through to `mcpGenerateVideo`, and correct the CLAUDE.md claim that Higgsfield exposes no audio parameter** (A2). Low urgency while Higgsfield is out of the UI, but a real correctness/documentation bug either way. **S effort.**
3. **Reconsider `DEFAULTS.video.duration` (5s) against real usage clustering at 15s** (A4) — a product decision, not an auto-fix; flagging rather than changing unprompted.
4. **Do not build against `multi_shots`/`multi_prompt`** (A6) — zero real usage across 1,160 jobs; the prose-staging approach 2.1 already took is what real winning prompts actually do.
5. **Verify `bitrate_mode` on the native BytePlus path before extending item 1 there** (B2) — live docs read or a real probe, not assumed from the Higgsfield catalog alone.

Non-levers / not worth chasing: a hidden/fine-tuned Seedance model (A1,
disproven — same as the image research's finding), post-processing upscale
on video (A9, 2 real jobs total), the structured multi-shot API (A6, zero
real jobs).

---

## Evidence index

| File | What it proves |
|---|---|
| `mcp-models-video.json` | full 20-model video catalog on this account |
| `mcp-model-seedance_2_0.json`, `-seedance_2_0_mini.json`, `-seedance1_5.json`, `-seedance_2_5.json` | per-model param schemas: `bitrate_mode`, `generate_audio`, `mode`, `genre`, `unlim` |
| `mcp-history-video-all.json` | 1,200 real video jobs, all models, full params |
| `mcp-history-seedance.json` | 1,160 of those filtered to Seedance |
| `mcp-rawjob-*.json` (5 files) | raw FNF payloads: full param shape including `multi_shots`/`multi_prompt`/`speedramp`/`reference_elements`, actual pixel `width`/`height` |
| `probe-mcp-video.js` | reproducible read-only probe (tool-whitelisted in code) |
