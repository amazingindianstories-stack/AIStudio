# Review Findings: Thumbnail + Blur-Placeholder Pipeline

Three parallel Stage 3 reviews: code-reviewer, security-reviewer, ui-designer
(Mode 2, run as a static/code review — see note below on why no live render
was attempted).

## Security review — no findings

Full pass over path/key confusion (`mediaKeyFromRef`/`readStoredBuffer`),
backfill script SQL/logging, storage-key provenance (`thumbnails/<id>.webp`),
sharp resource limits (confirmed applied to *both* the thumbnail and blur
pipelines, not just one), CSS-injection-adjacent `url(...)` interpolation of
`blurDataUrl`, and cross-user data leakage. Nothing exploitable found; every
concern traced to a concrete, safe answer (e.g. `id` is always a
server-generated UUID, never client-suppliable to this code path). Confirmed
`src/lib/auth.ts`/`src/middleware.ts`/the media route's auth gate are
untouched.

## UI review — static, matches spec; no violations

Went through the ui-spec's own §5 acceptance checklist item by item against
the actual `BlurImage.tsx`/`MediaCard.tsx`/`ConversationPanel.tsx` code.
**Note:** this was explicitly a static/code review, not a rendered one — the
schema migration (`db:push`) has not been run against the real database (see
Rollout constraint in `design.md`), so starting the dev server would fire
queries against columns that don't exist yet. All 10 checklist items verified
by direct code inspection; two (frosted-edge appearance, zero-flash-on-cache-hit)
were flagged as "mechanism is correct, but only a real render can fully
confirm the pixels" — logged below as a follow-up, not a blocker.

Two minor, non-blocking observations, both explicitly judgment calls the
reviewer said the spec doesn't require acting on:
- Reduced-motion (`prefers-reduced-motion`) suppresses the hover-zoom
  transition too (not just the new opacity fade), so a hover under reduced
  motion snaps instantly to 1.04 scale rather than not scaling at all.
  **Deferred** — ui-spec §4 only requires suppressing the opacity fade; this
  is a defensible superset, not a violation.
- `cn("motion-reduce:!transition-none", className)` could interact oddly with
  a *future* caller that passes its own `transition-*` class (neither current
  caller does). **Deferred** — not a current bug, purely a "worth a comment"
  note.

## Code review — one real finding, fixed; one finding rebutted; one deferred

1. **[FIXED] Hover-zoom lost on the degraded (no-`blurDataUrl`) path.**
   `BlurImage.tsx`'s no-blur branch dropped the pre-existing
   `transition-transform duration-500` class, so a `MediaCard` showing a
   not-yet-backfilled or thumbnail-failed row would snap to `scale(1.04)` on
   hover instead of easing over 500ms — a real, traced regression against
   ui-spec §2.3's "render exactly as today." **Fixed directly** (small,
   contained, single-class change) — restored
   `transition-transform duration-500` on that branch. Re-verified: `tsc
   --noEmit` clean, `thumbnail.test.ts` + `utils.test.ts` 18/18 green after
   the fix.
2. **[REBUTTED] "Unrelated change bundled into the diff"** (`package.json`'s
   `sync:shiv-sati-storyboard` script entry, `scripts/sync-shiv-sati-storyboard.ts`).
   The reviewer flagged this as scope creep from this PR. It is not — both
   were already present as uncommitted/untracked changes in the working tree
   *before this entire session started* (visible in the session's initial
   `git status`), unrelated to any work done here. Confirmed excluded from
   this feature's commit (same handling as the earlier, separate thumbnail
   optimization work this session did before the council run).
3. **[DEFERRED] `useLayoutEffect` SSR warning.** Reviewer explicitly labeled
   this "speculative" and noted this app is a client-only SPA
   (`src/app/page.tsx`) where these cards are never server-rendered — no
   real exposure. No action.

## Outcome

Both real, actionable findings (the hover-zoom regression) are resolved;
tests and typecheck re-verified green. No unresolved findings remain that
warrant a second review round.
