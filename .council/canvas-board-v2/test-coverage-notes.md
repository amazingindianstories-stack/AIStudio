# Canvas Board v2 — test coverage notes (SDET pass)

Written independently, alongside `src/lib/canvas/selection-actions-regression.test.ts`,
per design.md's "Test seams" and "Regression analysis (AC12)" sections. Purpose: make
explicit exactly what is/isn't covered by automated tests for this round, so nothing
falls through the cracks between the unit-test layer and manual QA.

## Confirming the "no automated harness for this" call

design.md's "Test seams" section places the keydown wiring, the alt/shift pointer
state machine, right-click detection, `CanvasContextMenu` portal/positioning, the
endpoint-drag pointer-capture + coalesced mutation loop, and `localStorage` scope
persistence into "DOM/pointer-only, out of automated scope... verified by `npm run
build` + manual QA" — matching how the *original* Canvas Board ship (`.council/
canvas-board/`) treated its own DOM/pointer-driven surface (shift-click multi-select,
marquee, resize-drag, connector-create-drag: also never had a dedicated automated
test, per that design's own test-seams section).

Checked the repo for a way to do better than that call:
- No test framework beyond Node's built-in `node:test` + `node:assert` exists
  anywhere in the repo (`package.json` has no `jest`/`vitest`/`@testing-library/*`/
  `jsdom`/`happy-dom` dependency, and `CLAUDE.md` says explicitly "no test framework
  exists" beyond ad-hoc `scripts/`).
- `canvas-store.ts` is a Zustand store whose mutating actions
  (`moveSelectionBy`, `duplicateSelected`, `paste`, the new
  `duplicateSelectionInPlace`/`updateConnectorEndpoint`) are reachable via pure
  function calls in principle, but the *behaviors this round adds risk to* are
  specifically the pointer-event sequencing around them (alt-drag's "skip one
  tick then duplicate", shift-drag's deferred-deselect-on-pointerup, the 400ms
  `GESTURE_IDLE_MS` coalescing window fusing two actions into one undo step) —
  these live in `CanvasSurface.tsx`'s pointer handlers, not in pure logic, and
  faking a realistic `PointerEvent` sequence (pointerdown → move ×N → pointerup,
  with real timing against `GESTURE_IDLE_MS`) without `jsdom`/RTL would mean
  hand-rolling a DOM/timer shim whose fidelity to real browser pointer-capture
  semantics could not itself be verified — that is a materially larger, riskier
  undertaking than what this round's scope asked for, and would be net-new test
  infrastructure decided unilaterally, not something within an SDET's mandate to
  introduce silently.

**Conclusion: yes, the "manual/build-verified, no dedicated unit test" call from
design.md is still the right one for this round.** Introducing a DOM-pointer test
harness is a legitimate idea but is infrastructure-scope, not test-writing-scope,
and should be raised explicitly with the team rather than added ad hoc here.

What *is* within an SDET's mandate and IS done in this round: the new pure,
framework-free `selectionActions()` helper gets full automated coverage (see
`src/lib/canvas/selection-actions-regression.test.ts`), because that logic has no
DOM/timing dependency at all — exactly the kind of pure logic this repo's existing
convention (`geometry.test.ts`, `zorder.test.ts`, `history.test.ts`) already unit-tests.

## What remains manual-verification-only (reviewer checklist)

Each item below names the acceptance criterion(s) and design.md codepath it maps to,
so the reviewer can check it off by hand rather than assume it's covered.

### New v2 behavior (no automated test exists or can reasonably exist yet)

1. **Asset panel project-scope toggle (AC1, AC2).** Open a board in a project that
   has both project-scoped and un-scoped (`projectId === undefined`) items. Verify:
   default view on open is "This project"; un-scoped items never appear under
   "This project"; toggling to "All projects" shows everything including un-scoped
   items; toggle persists across a page reload within the same browser (localStorage,
   not per-board — per A4/design.md, this is intentionally per-browser).
2. **`⇧I` add-image shortcut (AC6).** Confirm the toolbar tooltip and the actual
   keyboard behavior agree — pressing `Shift+I` opens the file picker; the toolbar
   button opens the same picker (single code path per design.md).
3. **`mod+G`/`mod+Shift+G` group/ungroup (AC3).** Select 2+ ungrouped nodes, group,
   then single-click anywhere in the group and confirm the whole group is selected
   as one unit (this end-to-end "click selects the group" behavior is a UI/store
   interaction, not something `selectionActions()` alone proves).
4. **`mod+]`/`[`/`mod+Shift+]`/`[` z-order shortcuts (AC4).** Visually confirm overlap
   order changes for both single- and multi-node selections, and that `mod+C` no
   longer switches to the connector tool (the `if (mod) return;` latent-bug fix
   design.md calls out).
5. **`mod+C`/`mod+V` copy/paste (AC5).** Confirm paste produces new ids, offset
   placement, and (per the Regression section below) correct groupId/parent remapping.
6. **Alt/Option-drag-to-duplicate (AC7).** Drag a selection with Alt held; confirm
   the duplicate follows the cursor, the original(s) stay exactly at the pre-drag
   position, and a single Undo (not two) removes the duplicate and restores nothing
   else (validates the two-mutation coalescing-into-one-undo-step guarantee).
7. **Shift-drag axis constrain (AC8), including its interaction with shift-click
   multi-select (Regression section item below).**
8. **Right-click context menu (AC9).** Exercise all three contexts: a selected node,
   a selected connector, and empty canvas (paste-only, all node/connector actions
   disabled) — confirm the rendered menu items match what `selectionActions()`
   would report for that selection (the menu itself is a thin renderer over the now
   fully-unit-tested flags, but the portal positioning/outside-click/Escape-close and
   the `onContextMenu` routing are pointer/DOM-only).
9. **Connector endpoint drag re-target/detach (AC10).** Select an existing connector,
   drag one endpoint onto a different node (confirm snap + reattach), drag the other
   endpoint to empty canvas (confirm detach to a free point), confirm exactly one
   Undo reverts the whole drag regardless of how many intermediate ticks fired.
10. **Focus guard for all new shortcuts (AC11).** With focus inside a sticky/text
    node in edit mode and inside the board-rename input, confirm none of the 9 new
    keybindings (group/ungroup, 4x z-order, copy, paste, `⇧I`) fire.

### Original-ship (AC12 regression) codepaths this round touches but does not add new tests for

Per design.md's own "Regression analysis (AC12)" section, these existing behaviors
are touched by new logic (different delta/id inputs, a defer-to-pointerup rule, a
new coalesced action sharing the gesture baseline) but the underlying pure functions
(`moveNodesBy`, `computeFrameMembership`, `zorder.*`) are unchanged and already have
dedicated tests (`geometry.test.ts`, `zorder.test.ts`) — what's NOT unit-tested is the
*new wiring* around them:

11. **Alt-dragging a framed node out of its frame** still clears `parentId` via the
    same `computeFrameMembership` path (design.md: "re-verify (a)").
12. **Dragging a frame (via alt-drag or shift-constrained drag) still carries its
    children.**
13. **Shift-constrained move still reparents correctly at the constrained end
    position**, not the unconstrained cursor position.
14. **Shift-click multi-select is unchanged**: shift-click on an unselected node adds
    it (unchanged path); shift-click on an already-selected node removes it — but now
    realized on pointer-up rather than pointer-down (the new `pendingDeselectId`
    defer). Must re-verify: (a) simple shift-click add/remove still works, (b) a
    shift-click that turns into a shift-drag does NOT deselect on release, (c)
    marquee-select combined with shift-click still behaves as before.
15. **Connector creation is unchanged.** Dragging a new connector from a node, an
    edge-handle, or empty canvas still creates/attaches exactly as before, AND the
    new endpoint-drag-handle dots (only rendered when a connector is already
    selected) do not intercept or interfere with a fresh connector-create drag.
16. **Tool-letter shortcuts (`v/h/r/c/s/t/f`) still work for plain keypresses**, and
    the new `if (mod) return;` guard prevents `mod+<letter>` from ever reaching the
    tool switch (explicitly a fix, not a regression, per design.md — but still worth
    confirming `mod+C` no longer switches to the connector tool, folded into item 4).
17. **`duplicateSelected` (`mod+D`) and `paste` (`mod+V`) still offset `+20,+20`,
    remap `groupId`s, and preserve intra-selection parent links** after the
    `buildClones` extraction refactor. Design.md flags explicitly: *"these have no
    dedicated unit test today; verify by `npm run build` + manual."* This SDET pass
    concurs this remains manual-only for the same DOM/pointer-harness reasoning
    above — `buildClones` itself is a plausible future pure-unit-test candidate
    (it takes `(present, ids, dx, dy)` and returns clones) if the implementer
    exports it, but that export is not part of this round's design.md interface
    contract, so no test is written against it here to avoid testing an
    implementation detail not promised by the spec/design.

## Recommendation

If `buildClones` ends up exported (design.md says it's an internal helper, not
listed in the public "Interfaces" section), flag it back to this SDET or a
follow-up pass — it would be a strong, cheap addition to the pure-logic unit-test
surface (same `node:test` convention) and would retire item 17 above from the
manual-only list without needing any DOM/timer harness.
