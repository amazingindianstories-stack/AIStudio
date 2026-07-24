# Decision Log: Thumbnail + Blur-Placeholder Pipeline

Every judgment made on the user's behalf during this council run, so it can be
vetoed after the fact.

## D1 — Scope: images only, not video/assets/canvas nodes

**Decision:** Precompute thumbnails only for `kind: "image"` generations.
Video, `assets.images[]`, and canvas board node persistence are explicit
non-goals.
**Alternative rejected:** Extracting a real poster frame from video via an
ffmpeg-class dependency.
**Why:** Real (non-mock) videos have no `poster` at all today (verified by
grep — `poster:` is only ever assigned in the mock path), so "add a video
thumbnail" would mean introducing a new binary dependency with real risk on
Vercel's serverless FS, cold start, and the existing 60s `maxDuration`
budget. That's a separate, probe-worthy initiative per this repo's own
working conventions ("back provider/payload changes with a probe"), not
something to bundle into this pass. Assets and canvas nodes stay on the
already-shipped on-the-fly `?w=` resize because they're lower-volume, mutate
more often, and (for canvas) touching them would mean changing the
documented node-persistence data model in `.council/canvas-board*/design.md`.

## D2 — Will not run `db:push` or the backfill script against production

**Decision:** The council implements and tests the code but does **not**
execute `npm run db:push` or `scripts/backfill-thumbnails.ts` against the
real database.
**Alternative rejected:** Running the migration automatically as part of
"shipping."
**Why:** Per `.env.local`, `DATABASE_URL` points at the real production
Postgres — there is no local dev database. A schema push and a bulk backfill
across existing rows are both data-migration-class actions on shared
infrastructure, which this pipeline's own escalation rules (and this
assistant's standing safety practice) carve out as things to interrupt the
user for rather than do autonomously. The PR/report instead lists the exact
manual sequence: `db:push` → deploy → optional backfill.

## D3 — Thumbnail/blur size + quality defaults

**Decision:** Stored thumbnail: ≤480px longest side, webp quality 75.
Blur placeholder: ≤16px longest side, webp quality 30, inlined as base64.
Storage key: `thumbnails/<generation-id>.webp`. Backfill concurrency: 4.
**Alternative rejected:** A larger/second thumbnail size for the feed
surface (`ConversationPanel` requests 1200px on the old on-the-fly path);
storing the blur as its own object instead of inline.
**Why:** 480/q75 matches the already-shipped on-the-fly route's constants,
so the two code paths produce visually consistent output. A second size was
rejected as gold-plating beyond what the request asked for — the feed
displaying a 480px thumbnail slightly upscaled is an accepted, explicitly
logged trade-off (full-res is still used in the lightbox). Concurrency 4
matches the existing `MAX_CONCURRENT_CANVAS_IMAGES` precedent already in the
codebase (`ImageNode.tsx`), for consistency rather than picking a new number.
Inlining the blur avoids a network request for something whose entire point
is instant paint.

## D4 — Design gate: approved with one correction

**Decision:** `design.md` and `ui-spec.md` are approved as submitted, sent
back to the implementer with one correction: `BlurImage.tsx` must use a
**named** export (`export function BlurImage`) not a default export, to
match every other component in this codebase (`MediaCard`, `PromptComposer`,
`ConversationPanel`, `AssetLibrary`, `ImageNode`, etc. are all named
exports).
**Why no full round-trip to the architect:** this is a one-line stylistic
nit, not a structural or correctness defect — bouncing the whole design back
for it would cost a full architect round-trip for no real gain. Every
acceptance criterion in `spec.md` is satisfied, the file plan is minimal and
every addition (`BlurImage.tsx` as a new shared component) is justified, and
the trade-offs (feed upscale, added hot-path latency, inline blur payload
size) are sound and explicitly reasoned rather than hand-waved.

## D5 — Blur-up motion timing: 300ms ease-out, deliberate deviation from ImageNode's 150ms

**Decision:** Accept the ui-designer's cross-fade spec (300ms ease-out,
`blur(16px)` + `scale(1.1)` background layer) as-is, including its deviation
from the existing `ImageNode.tsx` reference pattern (150ms).
**Alternative rejected:** Reusing ImageNode's exact 150ms timing for
consistency with the one other place this codebase animates image load.
**Why:** ImageNode fades in over an empty spinner (nothing meaningful to
reveal, so speed is the only goal); this feature fades in over an actual
low-res preview of the same image, where a slightly longer, decelerating
fade reads as "pulling into focus" and better hides the resolution seam.
The justification is explicit and codebase-grounded, not a stylistic
preference — accepted without a review round.

## D6 — Added hot-path latency from the write-time hook is accepted, not optimized further

**Decision:** The queue/execute hook synchronously reads back the just-saved
image bytes and runs sharp before returning the response (~100–400ms worst
case per the design's own estimate), rather than passing the in-memory
Gemini buffer through to avoid a re-read, or deferring thumbnail generation
to a fire-and-forget step after the response is sent.
**Alternative rejected:** Passing the Gemini branch's in-memory `base64`
directly (saves one storage read on that branch only); making the whole hook
async/non-blocking.
**Why:** The unified hook (one code path for both provider branches) is
simpler and less error-prone than two divergent paths, and the added
latency is a rounding error against the existing 30–60s NBP generation time
and the 60s `maxDuration` budget. The design explicitly flags the
faster alternative as a noted, not-built follow-up if this ever proves
material — the right amount of design-for-the-future here, not more.

## D7 — Static UI review instead of a live rendered review

**Decision:** Stage 3's ui-designer review was a static/code review against
`ui-spec.md`, not a live rendered check.
**Alternative rejected:** Starting `npm run dev` and visually inspecting the
running app.
**Why:** The schema migration (`db:push`) has deliberately not been run
against the real production Postgres (see the Rollout constraint / D2). Any
attempt to run the dev server against that live, un-migrated database would
fire queries referencing columns that don't exist yet. The static review
confirmed 8 of 10 acceptance-checklist items with high confidence and flagged
2 (frosted-edge appearance, zero-flash cache-hit behavior) as needing an
actual render to fully close out — logged as a follow-up for after the
migration runs, not treated as a blocker now.

## D8 — Rebutted finding: unrelated `package.json`/storyboard script change

**Decision:** The code-reviewer's finding that `package.json`'s new
`sync:shiv-sati-storyboard` script entry and `scripts/sync-shiv-sati-storyboard.ts`
were scope creep is rebutted, not fixed.
**Why:** Both were already present as uncommitted/untracked changes in the
working tree before this session (and before the earlier, separate thumbnail
optimization done earlier today) started — verified against the session's
initial `git status`. They are excluded from this feature's commit, same as
they were excluded from the earlier commit today.

## D9 — Hover-zoom regression on the degraded path: fixed directly, not routed through another implementer round

**Decision:** Code review's one real, traced finding (hover-zoom transition
lost on the no-`blurDataUrl` path in `BlurImage.tsx`) was fixed directly by
this orchestrator rather than sent back through a full implementer round.
**Why:** The fix was a single, well-understood, contained change (restore
one Tailwind class) with an obvious correct answer already stated by the
reviewer. Re-verified immediately after (`tsc --noEmit` clean, both new test
files 18/18 green) — no ambiguity or design judgment involved that would
benefit from a fresh implementer pass.
