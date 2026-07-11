# Decision log — Gemini Omni Flash video integration

**D0 — Rebuild after data loss.** The original `.council/omni-video/`
working set (spec, design, decisions, review-findings, probe script, all new
source/test files) was lost before the Stage 4 commit landed — user reports
the client crashed ("cantigravity"). `git status` on resume confirmed a
clean tree with none of these files present. A handful of fragments *did*
survive, bundled into an unrelated commit (`5dfec61 "Finish Codex UI
elements and admin tasks"`, 2026-07-11): the `pricing.ts` Omni row,
`.env.local.example` Omni section, the `CLAUDE.md` provider bullet, the
`medium` param in `shot-spec.ts`/`prompt-assembler.ts` + its test cases in
`shot-spec.test.ts`, and an unfinished comment in `store.ts`'s `setModel`
describing model-aware clamping that the surrounding code doesn't actually
do yet.
Rejected alternative: re-run the full council pipeline (recon → architect →
ui-designer) from zero. Rejected because the spec/design were already
reasoned through and probe-verified in the lost session, and I retain that
content verbatim from the pre-compaction conversation record — re-deriving
it would burn tokens without changing the outcome. Instead: reconstruct
spec.md/design.md directly (content unchanged), verify each surviving
fragment against the design instead of blindly overwriting it, and rebuild
only what's actually missing (all of Phase 1's config/store code, all of
Phase 2, all of Phase 3, the probe script, the two new test files).

**D1 — Model identity.** "Google Omni" = `gemini-omni-flash-preview` via the
Interactions API (`generativelanguage.googleapis.com`), not an Imagen/Veo
product. Confirmed by probe: this key can reach the model.

**D2 — Dual wire path.** Gemini API (`x-goog-api-key`) is the default,
proven-working path; Vertex is flag-gated behind `OMNI_USE_VERTEX=1`.
Rejected: Vertex-only (user asked for "GCP credits" and Vertex-first), because
Vertex Omni access is allowlist-gated per public reports and this machine's
Vertex credentials are currently dead (`gcloud` token expired, `gcp-sa-key.json`
empty) — shipping Vertex-only would mean the feature doesn't work today. Both
paths bill to GCP (the Gemini API key's billing account is a GCP project too),
so "consume GCP credits" is satisfied either way; Vertex remains the easy flip
once creds are restored.

**D3 — No best-of-N for video.** Unlike the image path's identity-locked
best-of-N, Omni does a single generation per request. Video generation is
priced and timed too high for N parallel candidates to be practical; may
revisit if identity fidelity turns out to be a problem in practice.

**D4 — Default price 10¢/second, admin-editable.** Matches the measured cost
order of magnitude; sits in the same admin-editable `pricing` table as every
other model, so it's a starting point, not a hardcoded constant.

**D5 — Live generation test authorized.** The user explicitly said "you can
gen test too" — real spend (~$0.40–1) for end-to-end proof is in scope,
run once per council pass (not repeatedly for every code tweak).

**D6 — `OMNI_MAX_IMAGES` exported.** Test-engineer needed this constant
directly; kept as a named export on `omni-input.ts` rather than duplicating
the literal `14` in the test file.

**D7 — `extractOmniVideo` is async, not pure.** The design initially listed it
under "pure helpers" alongside `mapOmniStatus`/`buildOmniEndpoint`/
`buildOmniPayload`, but it must fetch `output_video.uri` when
`delivery:"uri"`. Adjudicated: keep it async, tests stub `global.fetch`
rather than forcing artificial purity that would require a second
network-aware wrapper doing the same job.

**D8 — ui-designer visual review skipped.** The user-facing diff is two
lines (a new model-picker entry, an AR-picker option list swap) — well
under the threshold where a rendered-UI review earns its cost. Substituted
with a manual mock-mode wiring check instead.

**D9 — Probe verdicts override public docs.** Where the Interactions API's
public documentation and the measured validation-error probe disagreed
(field placement, `delivery` enum spelling, presence of a duration param),
the probe wins — recorded in the design's PROBE VERDICTS section and in the
provider file's header comment, same convention as `gemini.ts`.

**D10 — Security adjudications (from the original Stage 3 review, being
re-applied during rebuild):**
- S1 (host allowlist) — FIX: `assertGoogleHost()` refuses to attach
  credentials to any host that isn't `googleapis.com` or `*.googleapis.com`,
  guarding the `output_video.uri` download path against a malicious/rebound
  URI attaching the API key or bearer token to an arbitrary host.
- S2 (API key must not appear in URLs) — FIX: all requests use the
  `x-goog-api-key` header, never a `?key=` query string (which would land in
  logs/proxies).
- S3 (job-ownership gap on video status/execute routes — `item.userId` is
  never checked against the session user, only cookie presence) — DEFER:
  pre-existing gap that predates this feature and affects the Higgsfield/
  Seedance video routes equally; flagged as an independent follow-up, not
  blocking this ship.

**D11 — Contract re-probed and corrected mid-rebuild; two accidental billed
generations disclosed.** The D0 rebuild initially recreated the provider
code from memory of the lost session's "measured" contract (a `task` field,
a `delivery` field, prompt-driven duration). The zero-cost probe matrix
(`scripts/probe-omni.ts`) immediately contradicted this — the live API 400s
on `task` and `delivery` as unrecognized parameters. Rather than trust
stale memory over the live endpoint, the contract was re-derived from
scratch via validation-error probing (see design.md's PROBE VERDICTS,
re-measured 2026-07-11). Real corrections: no `task` field (the model
infers reference-vs-text video from `input`'s image parts); no `delivery`
field; `response_format.duration` is a real, enforced request param (a
protobuf-Duration string like `"4s"`), not prompt text; the video payload
lives at `steps[].content` where `step.type === "model_output"`, not
`steps[].model_output.content`.
Cost disclosure: two of the ad-hoc rediscovery probes were NOT
validation-safe — sending `input: "not an array"` and `input: [{type:
"text", text:"a candle flame flickering"}]` (both outside the shipped
probe script, run directly against the endpoint while exploring the schema
by hand) were accepted and ran to real, billed completion (~58k tokens
each, consistent with ~4s clips) before their risk was understood. This is
flagged here rather than folded quietly into the "expected" live-test spend
authorized by D5 — it was unplanned, and the user should know the actual
number of billed generations this session is 3 (2 accidental + 1
deliberate, the one captured as `.council/omni-video/live-test.mp4`), not 1.
Once the accepted-but-malformed-input risk was understood, all further
probing kept `input: []` (which the API always rejects before doing
anything) until the single deliberate live test.

**D12 — Discovered a concurrently-running, independent process editing the
same repo; deliberately did not depend on or interfere with its work.**
Mid-Stage-3, `git status` showed `src/lib/providers/gemini.ts`,
`src/lib/shot-spec.ts`, `src/lib/middleware/image-prep.ts`,
`src/components/DetailModal.tsx`, `src/components/HistoryPanel.tsx` modified,
plus two new test files (`gemini-parts.test.ts`, `prompt-assembler.test.ts`)
that this session did not create. `ps aux` confirmed a live OpenAI Codex CLI
process (and the Codex desktop app) running against this machine at the
same time, apparently building an unrelated "zero-cast policy" feature
(explicit no-people-in-frame contract + camera-direction handling for
location-only scenes). None of this overlaps this feature's own new files
(`omni-input.ts`, `providers/omni.ts`, the three video routes, `config.ts`'s
Omni-specific additions, `store.ts`'s per-model clamp fix), and the shared
files it touched (`shot-spec.ts`, `shot-spec.test.ts`) currently contain
both features' additions side by side without conflict — all 78 tests pass
together. Decision: do not add a dependency on the concurrent work (see
review-findings.md finding #5 — deferred `buildCastPolicy` parity for this
reason specifically) and do not commit until the user is aware a second
process is live in this working tree, since a commit right now would sweep
an unrelated, possibly-still-in-progress feature into this feature's commit
under this session's authorship. Flagged to the user directly rather than
either commit-and-hope or silently wait.
