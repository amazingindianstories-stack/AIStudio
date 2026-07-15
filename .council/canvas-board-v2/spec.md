# Spec: Canvas Board v2 — Project-Scoped Assets, Figma-like Input, Connector Editing

Follow-on to the shipped Canvas Board (`.council/canvas-board/`, on branch
`feature/canvas-board`, not yet merged to `main`). This spec covers four
enhancement areas requested by the user, scoped from recon of the current
implementation (see Recon note at the bottom of each section — not a separate
recon.md this time, findings are folded in directly since they're short).

## A. Project-scoped asset library + full-library access

**Current state**: `CanvasAssetPanel.tsx` reads the global `items` array with
**zero project filtering** — it already shows every asset across every
project (search + Assets/Favourites tabs only). So today there is only "full
library," no way to narrow to the current project.

**Desired behavior**: Add a project scope control to the asset panel:
- Default view: **This project** — items whose `projectId` matches the
  canvas board's own `projectId` (the board is already opened in a
  project context — `CanvasView`/`BoardSwitcher` already carry `projectId`).
- A one-click way to switch to **All projects** (today's behavior — the full
  library), and back.
- Items with no `projectId` (pre-project-era generations, or items detached
  from a deleted project — confirmed these exist, `store.ts:601-602`) are
  excluded from "This project" (they belong to no project) but included in
  "All projects."

## B. Keyboard shortcuts

**Current state** (confirmed by reading `CanvasView.tsx`/`CanvasSurface.tsx`
in full): a real, working shortcut set already exists — undo/redo, duplicate,
select-all, zoom reset/fit, delete, escape, arrow-nudge, tab-cycle, tool
switches (v/h/r/c/s/t/f). Two concrete gaps found:
1. **Bug**: the toolbar's "Add image" tooltip advertises `⇧I` but no such
   handler exists anywhere — the shortcut is not wired.
2. **Dead code**: `canvas-store.ts` already implements `group`, `ungroup`,
   `bringToFront`, `sendToBack`, `bringForward`, `sendBackward`, `copy`,
   `paste` — none of these eight actions has ANY UI entry point (no keyboard
   shortcut, no toolbar button, no menu). They are fully implemented and
   presumably exercised by the z-order/history unit tests at the pure-logic
   level, but unreachable by a user today.

**Desired behavior**: wire the standard Figma/FigJam bindings for all of the
above, plus fix the broken image shortcut:
- `Cmd/Ctrl+G` → group, `Cmd/Ctrl+Shift+G` → ungroup
- `Cmd/Ctrl+]` → bring forward, `Cmd/Ctrl+[` → send backward
- `Cmd/Ctrl+Shift+]` → bring to front, `Cmd/Ctrl+Shift+[` → send to back
- `Cmd/Ctrl+C` / `Cmd/Ctrl+V` → copy/paste selection
- Fix `Shift+I` (or whatever the toolbar tooltip actually says once checked)
  to actually trigger "add image" (open the file picker), or correct the
  tooltip if wiring it is disproportionate — implementer/architect's call,
  documented either way.
- All new bindings must respect the existing text-input-focus guard pattern
  (`CanvasView.tsx`'s early bail when focus is in an editable field) so
  typing inside a sticky/text node never triggers a canvas shortcut.

## C. Mouse functionality

**Current state**: pan (space+drag, hand tool, plain scroll), zoom-to-cursor
(mod+scroll — confirmed intentional per D7, not a bug), marquee select,
shift-click multi-select, resize-handle drag, connector drag-to-create all
already work. Confirmed **missing**: alt/option-drag-to-duplicate, shift-drag
axis constraint while moving a node, and any right-click/context menu.

**Desired behavior**:
1. **Alt/Option+drag** on a selected node (or selection) starts a drag that
   duplicates the selection in place and drags the duplicate, leaving the
   original untouched — the standard Figma pattern.
2. **Shift+drag while moving** a node/selection constrains movement to the
   dominant axis (horizontal or vertical) rather than free movement.
3. **Right-click context menu** on a node/selection/connector with: Duplicate,
   Copy, Delete, Bring to Front, Send to Back, Group/Ungroup (context-
   sensitive) — this doubles as the second, discoverable entry point for the
   B-section actions, not just a keyboard-only feature.

## D. Connector/line editing polish ("polish lines to be better editable")

**Current state**: a connector's two endpoints are rendered as dots when
selected, but they are **decorative only** — not draggable. Once created, a
connector can only be re-styled (stroke/width/opacity), never re-routed; the
only way to "fix" a wrongly-connected line today is delete + recreate.

**Desired behavior**: make a selected connector's endpoint dots real drag
handles:
- Dragging an endpoint lets the user re-target it to a different node (snaps
  to the node with the same hover-to-attach behavior already used when
  creating a connector) or drop it at a free point (detaching that end).
- Live preview of the new path while dragging, committed as one undo step on
  release (matching the existing gesture-coalesced undo pattern used
  elsewhere, e.g. `moveSelectionBy`).
- No change to the automatic bezier-bow curve logic itself (`connectorPath`)
  — this is about re-targeting endpoints, not adding manual control-point
  curve editing (that stays out of scope, see Non-goals).

## Acceptance criteria

1. Asset panel defaults to "This project" scope on open; a visible control
   switches to "All projects" and back; the choice is scoped per board (or
   per session — assumption, see Assumptions).
2. Items lacking a `projectId` never appear under "This project," always
   appear under "All projects."
3. `Cmd/Ctrl+G`/`+Shift+G` group/ungroup the current selection; visually
   confirmed by a subsequent single-click selecting the whole group.
4. `Cmd/Ctrl+]`/`[`/`Shift+]`/`Shift+[` change z-order of the selection;
   visually confirmed by overlap order changing.
5. `Cmd/Ctrl+C`/`V` copies then pastes the selection as new nodes (new ids,
   offset placement so paste is visible/distinguishable from the source).
6. The advertised image-upload shortcut actually works (or the tooltip is
   corrected to match reality — either resolves this acceptance criterion).
7. Alt/Option+drag on a selected node produces a duplicate that drags with
   the cursor; the original stays at its pre-drag position.
8. Shift+drag while moving constrains motion to one axis.
9. Right-click opens a context menu with at least Duplicate/Copy/Delete/
   Bring-to-front/Send-to-back, scoped to whatever is under the cursor
   (node, connector, or empty canvas → paste-only menu).
10. A selected connector's endpoints are draggable; dragging one onto a
    different node reattaches that end; dragging to empty canvas detaches it
    to a free point; the change is one undo step.
11. None of the new shortcuts fire while focus is inside a text-editing
    field (sticky note / text node in edit mode, board-rename input, etc.).
12. No regression to any of the 11 acceptance criteria from the original
    `.council/canvas-board/spec.md` — existing shortcuts, existing mouse
    behavior (pan/zoom/marquee/resize/create), and existing connector
    creation continue to work exactly as before.

## Non-goals (explicitly out of scope for this round)

- Still not "exact Figma": no pen/bezier tool, no boolean shape ops, no
  components/instances, no auto-layout, no node rotation.
- Manual bezier control-point dragging for connectors (only endpoint
  re-targeting, not curve-shape editing).
- The already-deferred M1 items from the original spec (Bold/text-align on
  text/sticky nodes, 3-state arrowhead none/one-way/two-way) — these need
  `TextNode`/`StickyNode`/`Connector` type extensions and were deliberately
  parked before; the user's phrase "lines... better editable" is read here
  as re-routing/dragging, not arrowhead styling, so this is not re-litigated
  in-scope. Flagged as a natural fast-follow if wanted.
- Real-time multiplayer (still single-user v1, unchanged from D4).
- Touch/trackpad gesture-specific tuning beyond what already exists.

## Assumptions (logged, defaults chosen where the request was silent)

- **A1**: "Project-wise asset library selection" means the toggle default is
  the board's own project; "full library" means literally today's
  unfiltered behavior, preserved as the alternate option — not a new
  per-project-picker across arbitrary other projects. (An admin picking
  *some other specific* project's assets while working in project X was not
  asked for and adds meaningful UI surface for a use case not stated;
  narrowed to a binary toggle. Reversible/extendable later if wanted.)
- **A2**: Copy/paste is within-board only for this round (paste back into the
  same board), not cross-board/cross-tab clipboard — matches what the
  existing (currently unreachable) `copy`/`paste` store actions already
  implement; no evidence they support cross-board paste, and adding that
  would be new scope, not wiring.
- **A3**: The right-click context menu is additive (new capability, not asked
  for verbatim but the natural mouse-side home for "figma like... mouse
  functionality" plus the only non-keyboard way to reach group/layer-order/
  copy actions for mouse-only or shortcut-unaware users) — included as an
  acceptance criterion rather than treated as scope creep, because it's the
  standard mouse-driven complement to section B and low-marginal-cost given
  the underlying actions already exist.
- **A4**: Asset panel scope choice persists at least for the session (not
  necessarily written to the board's persisted `jsonb`, to avoid a schema
  change) — implementation detail for the architect to fix precisely.

## Process note — production push

The user's request ends with "push to production after this." Per this
project's standing pipeline rules, Stage 4 will commit this work to a
feature branch (reversible, no confirmation needed) — most likely the
existing `feature/canvas-board` branch, or a stacked branch on top of it,
architect/orchestrator's call at Stage 4. The final step of **merging to
`main` and pushing to trigger a production deploy** is treated as requiring
one explicit confirmation before it happens, despite the advance
authorization in this request: this repo has a documented history of
production incidents from deploys (GCS/Workload-Identity-Federation
credential failures causing production 500s, `.council`/memory:
"production-baseline-reset"), and this round bundles two feature efforts
(the original Canvas Board + this v2 work) into one production push. This is
a process decision, not a functional acceptance criterion, and does not
block any of the build/review work below.
