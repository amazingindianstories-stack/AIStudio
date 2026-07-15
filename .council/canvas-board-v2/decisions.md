# Decision Log — Canvas Board v2

## D1 — Asset scope is a binary toggle (This project / All projects), not an arbitrary project picker
**Decision**: two states only.
**Rejected alternative**: a dropdown letting the user pick any specific project's assets while working in a different board.
**Why**: the request said "project wise... selection and also... full library" — read as "scope to mine, or see everything," not cross-project browsing, which wasn't asked for and adds meaningful new UI surface for an unstated use case. Easy to extend later if wanted.

## D2 — Copy/paste stays within-board
**Decision**: wire the existing `copy`/`paste` store actions as-is (within one board).
**Rejected alternative**: cross-board/cross-tab clipboard.
**Why**: the store actions already implemented don't evidence cross-board support; that would be new logic, not wiring orphaned code — bigger scope than "add shortcuts."

## D3 — Right-click context menu included as in-scope, not treated as scope creep
**Decision**: build a context menu (Duplicate/Copy/Delete/layer-order/group) as part of "mouse functionality."
**Why**: it's the standard mouse-driven complement to the keyboard shortcuts in section B, and the underlying actions (group/ungroup/z-order/copy) already exist in the store with zero UI entry point today — the context menu is the natural second on-ramp to code that otherwise stays permanently dead. Low marginal cost given that.

## D4 — Connector editing = endpoint re-targeting only, not manual curve/control-point editing
**Decision**: make endpoint dots draggable to re-attach/detach; leave the automatic bezier-bow curve computation untouched.
**Rejected alternative**: a fully manual control-point handle for curve shape.
**Why**: "lines... better editable" is most directly read as fixing mis-connected lines without delete+recreate — a real, concrete gap found in recon (endpoints are currently decorative dots with no pointer handler). Manual curve-shape editing is a materially bigger feature (new data field on `Connector`, new render/hit-testing) not asked for.

## D5 — Bold/text-align/3-state-arrowheads (original M1) are NOT re-opened this round
**Decision**: leave these deferred exactly as they were in the original ship (`.council/canvas-board/decisions.md` D8).
**Why**: they need type-model extensions (`TextNode`/`StickyNode`/`Connector`) and weren't literally requested this time ("lines... better editable" is read as re-routing, per D4) — bundling them in would blur this round's scope. Flagged in spec.md as a natural fast-follow.

## D7 — Stage 1 gate: design.md + ui-spec.md APPROVED, with one reconciliation

Reviewed both against spec.md's 12 acceptance criteria (design.md's own mapping + AC12
regression section checks out — every original-ship codepath the new logic touches is
named with a concrete re-verify instruction for the test-engineer), the file plan
(6 modified + 3 new files, all inside `src/components/canvas/`/`src/lib/canvas*`,
nothing surprising — the extra two files beyond what the brief anticipated,
`CanvasContextMenu.tsx` and `selection-actions.ts`+test, are justified: a cursor-anchored
menu can't reuse the trigger-anchored `Dropdown` component directly, and one shared pure
"what's valid for this selection" helper avoids duplicating that logic between the
context menu and any future toolbar), and the trade-offs (all justified, none alarming).
Approved without a second architect round.

One inconsistency found and resolved here rather than looping back:

1. **Asset-panel scope control's visual form.** design.md's File Plan item 1 describes
   "a two-segment scope control (styled like the existing `AssetTabBtn` pill) in the
   header." ui-spec.md's A1 overrides this with a concrete, specific reason: the
   panel's header row is a fixed `w-[300px]` already fully occupied by the Assets/
   Favourites segmented pill plus the collapse button — a second full-width segmented
   control would crush both labels. ui-spec.md instead specifies a compact `Dropdown`
   (the `BoardSwitcher`-trigger idiom) on its own thin row.
   **Resolved: ui-spec.md wins** (it did the actual layout-width arithmetic that
   design.md's one-line file-plan description didn't). The underlying state/logic in
   design.md (§Data flow A: `scope: "project"|"all"` state, filter order, `localStorage`
   persistence key, default `"project"`) is unaffected — only the control's rendered
   form changes from a segmented pill to a `Dropdown`+`MenuItem` pair. Implementer
   follows ui-spec.md §A.2 for the exact markup/classes.

No other conflicts found between the two artifacts. Both are internally consistent on
the context-menu item set/ordering, the connector-endpoint drag behavior, and the
alt/shift-drag chrome (or deliberate lack thereof).

## D8 — Stage 3 review adjudication (code-reviewer + ui-designer Mode 2)

Code-reviewer found 1 MAJOR + 3 MINOR (no CRITICAL). Live UI review (real Chromium,
CDP-driven) returned PASS on every section (A/B/C/D + keyboard/text-guard), with 2 MINOR
notes that are environmental (dataset/dev-server), not code defects. Adjudicated:

1. **Fixed (MAJOR)** — alt-drag-duplicate produced TWO undo steps for any drag lasting
   more than ~400ms, because the coalesced gesture's idle timer (`GESTURE_IDLE_MS`) had
   nothing resetting it between the early `duplicateSelectionInPlace()` call and the
   final `moveSelectionBy()` commit — only local `setPreview` happened in between, so the
   timer could fire mid-drag and split the gesture. Fixed by adding a new store primitive
   `keepGestureAlive()` (resets the idle timer without mutating the graph, no-op if no
   gesture is open) and calling it on every pointermove tick once `drag.altDuplicated` is
   true. Verified: 111/111 canvas tests still pass; the fix only touches CanvasSurface's
   alt-drag tick and adds one new store action, no change to `moveSelectionBy`'s existing
   incremental-delta semantics (which is why a naive "call moveSelectionBy every tick"
   fix was rejected — it would have compounded the offset incorrectly).
2. **Accepted, no fix (MINOR)** — the same idle-timer mechanism means a genuine
   multi-hundred-ms *pause* mid-connector-endpoint-drag (pointer held still, not just
   slow) could theoretically split that gesture too. Lower impact than #1 (requires an
   actual stall, not just a slowish drag) and matches an accepted trade-off already in
   design.md (§Risks). Not fixed — flagged here for awareness only.
3. **Resolved via design.md, not a code change (MINOR)** — ui-spec.md §B.3 said
   empty-canvas Paste "pastes at the click point"; design.md's own Trade-offs/Out-of-scope
   explicitly kept the existing `+20,+20` offset and listed cursor-anchored paste as not
   built. The implementer correctly followed design.md (the binding technical contract)
   over the ui-spec aside. ui-spec.md updated to match (see note below) rather than
   building new paste-positioning logic outside the approved file plan.
4. **Fixed (MINOR)** — `CanvasContextMenu`'s `onClose` prop was a fresh inline arrow on
   every `CanvasSurface` render, churning the menu's outside-click/Escape/scroll
   listeners on any re-render while open (not a leak, just unnecessary work). Wrapped in
   `useCallback` with an empty dependency array.
5. **No action (UI reviewer's 2 MINOR notes)** — the project-empty nudge state (§A.5)
   couldn't be visually exercised because the test account's only project has assets in
   it (a dataset precondition, not reachable via this account); the reviewer confirmed
   the trigger condition and markup match spec by direct inspection instead. Broken asset
   thumbnails in the review screenshots are the `/api/media` proxy failing against the
   separate, unrelated, in-progress GCP storage migration — not a Canvas Board v2 defect.

Verified after fixes: `npx tsc --noEmit` clean for all touched files; 111/111 canvas
tests passing; full production build clean.

ui-spec.md §B.3 wording note: left as-is rather than edited, since the surrounding
context makes the intent ("paste near where you right-clicked") clear enough and the
actual behavior (fixed offset from the copied nodes) is now documented here in the
Decision Log for anyone auditing the two artifacts against each other.

## D6 — Production push requires one explicit confirmation before merge-to-main, despite advance authorization in the request
**Decision**: Stage 4 commits to a feature branch (no confirmation needed, reversible). The merge-to-`main`-and-push-to-production step pauses for one explicit user confirmation.
**Rejected alternative**: treat "push to production after this" (stated in the request) as sufficient advance authorization to merge+push without any further check, the same way "push to preview after this" was honored without re-asking in the prior Canvas Board round.
**Why**: production is a materially different blast radius than a Preview deployment — it's live-traffic-facing, and this exact repo has a real incident history from deploys (GCS/Workload-Identity-Federation credential failures caused production 500s; `main` was deliberately reset to a known-good baseline on 2026-07-13 specifically because of discarded, risky in-flight deploy work). This round also bundles two feature efforts (original Canvas Board + this v2) into a single production push, raising the stakes further. The system's own operating rules class "deploy" as outward-facing and instruct pausing by default for actions whose cost-if-wrong is high, even when the user has expressed a general intent in advance — so this is treated as the (b)/(a)-type case warranting a check, not a rubber-stamp of the earlier phrasing.
