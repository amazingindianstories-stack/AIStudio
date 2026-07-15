# Design: Canvas Board v2 — Project-Scoped Assets, Figma-like Input, Connector Editing

Status: ready for build. Scope bound by `spec.md` (AC 1–12) + `decisions.md` (D1–D6) + `recon.md`.
Follow-on to the shipped Canvas Board (`.council/canvas-board/design.md`); this design **matches
that ship's conventions exactly** — pure logic in `src/lib/canvas/*`, gesture-coalesced undo via
`mutateGraph(..., {coalesce:true})`, z-order helpers in `zorder.ts`, `Dropdown`/`MenuItem` styling —
and invents no new patterns.

---

## Open questions

**None are blocking.** The one open question flagged in recon §4 (is the board's `projectId` already
threaded to where `CanvasAssetPanel` renders?) is resolved below by reading the code, not guessing:

- `CanvasView` does **not** receive a `projectId` prop. It reads `activeProjectId` from the global
  `store.ts` (`CanvasView.tsx:28`) and passes it to `BoardSwitcher` as `projectId` (`:252`).
  `BoardSwitcher` only ever lists/creates/loads boards **for that `activeProjectId`**
  (`BoardSwitcher.tsx:34-58`), so **the loaded board's own `projectId` is always identical to the
  global `activeProjectId`.** There is no separate board-owned projectId in `CanvasView`/`canvas-store`.
- **Decision:** thread the board's project explicitly — `CanvasView` passes `projectId={activeProjectId}`
  as a new prop to `CanvasAssetPanel` (same value it already passes to `BoardSwitcher`). This keeps the
  asset panel's project source identical to the switcher's, is explicit/testable, and needs no new store
  field. Filtering against `activeProjectId` is provably equivalent to filtering against the board's own
  project because they are the same value. (Rejected: having `CanvasAssetPanel` read `activeProjectId`
  from the global store itself — works, but an explicit prop keeps the panel's project source auditable
  and co-located with `BoardSwitcher`'s.)

---

## Summary

Four small, independent enhancements, each grounded in existing machinery:

- **A (project-scoped assets):** add a binary scope toggle (This project / All projects) to
  `CanvasAssetPanel`, persisted in `localStorage` like the existing collapse flag. Filter the
  already-loaded global `items` by `item.projectId === projectId`; `undefined`-project items are
  excluded from "This project," included in "All projects" (today's behavior). Default: This project.
- **B (keyboard):** wire the 8 already-implemented-but-unreachable store actions
  (`group`/`ungroup`/`bringToFront`/`sendToBack`/`bringForward`/`sendBackward`/`copy`/`paste`) into
  `CanvasView`'s existing document keydown handler, reusing its text-focus guard and mod-key pattern.
  Fix the broken `⇧I` "add image" shortcut by **wiring it for real** (single hidden file input lifted to
  `CanvasView`, shared by the toolbar button and the shortcut).
- **C (mouse):** Alt/Option+drag-to-duplicate and Shift+drag axis-constrain are added as flags on the
  existing `move` `DragState` in `CanvasSurface` (no new drag kind); a new `CanvasContextMenu` component
  (portal + reused `MenuItem` styling) is opened on right-click. All three share one pure
  `selectionActions()` helper that says which actions are valid for the current selection.
- **D (connector endpoints):** a new coalesced store action `updateConnectorEndpoint()` plus a new
  `connector-endpoint` `DragState.kind`. The decorative endpoint dots in `ConnectorLayer` become real
  drag handles that re-target/detach an endpoint, reusing the existing `hitTest` snap-to-node and
  hover-highlight logic, committed as one undo step via the same coalescing the opacity-slider fix used.

Why this beats the alternative (a broader refactor / a generic command bus): every action already exists
in the store; the work is almost entirely *wiring* orphaned logic to input events plus two genuinely new
store actions. The smallest change that satisfies the spec is to extend the existing handlers in place.

---

## File plan (exhaustive)

Implementers may touch **only** these files. Beyond the six the brief anticipated, this plan adds **two
new files** (a context-menu component and a pure selection-actions helper + its test) and flags that
`CanvasToolbar.tsx` **is** touched (for the `⇧I` single-source fix). Nothing else is in scope.

### Modify

1. **`src/components/canvas/CanvasAssetPanel.tsx`** — (A) add a `projectId: string | null` prop; add a
   `scope: "project" | "all"` state persisted to `localStorage` (`SCOPE_KEY`, default `"project"`); add a
   two-segment scope control (styled like the existing `AssetTabBtn` pill) in the header; insert a scope
   filter ahead of the tab/search filters.

2. **`src/components/canvas/CanvasView.tsx`** — (A) pass `projectId={activeProjectId}` to
   `CanvasAssetPanel`. (B) add the 8 new keyboard bindings + the `⇧I` binding to the existing `onKeyDown`
   (`:127-215`), inside the existing focus guard (`:129-131`); add a hidden `<input type="file">` +
   `openImagePicker()` and pass `onAddImageClick={openImagePicker}` to `CanvasToolbar`; add the new store
   actions to the effect's dependency array. No change to `CanvasSurface` mount props except those below.

3. **`src/components/canvas/CanvasSurface.tsx`** — (C) alt-drag-duplicate + shift-axis-constrain +
   deferred shift-toggle as flags on the `move` `DragState`; `onContextMenu` handler on the container that
   selects the node-under-cursor (or clears for empty) and opens `CanvasContextMenu`; render
   `CanvasContextMenu`. (D) new `connector-endpoint` `DragState.kind` handled in `onPointerMove`/`endDrag`;
   pass `onEndpointPointerDown` and `onConnectorContextMenu` to `ConnectorLayer`.

4. **`src/components/canvas/ConnectorLayer.tsx`** — (D) make the two selected-endpoint dots real drag
   handles: add `pointer-events-auto` + a fat invisible grab circle + `onPointerDown` calling a new
   `onEndpointPointerDown(e, connectorId, end)` prop. (C) add `onContextMenu` to the existing fat hit-path
   calling a new `onConnectorContextMenu(e, id)` prop.

5. **`src/lib/canvas-store.ts`** — add two actions to `CanvasStore` + impl:
   `duplicateSelectionInPlace()` and `updateConnectorEndpoint(connectorId, end, endpoint)`; export
   `hasClipboard()`. Refactor the existing clone logic in `duplicateSelected`/`paste` into a shared
   internal helper `buildClones(present, ids, dx, dy)` so `duplicateSelectionInPlace` reuses it (no
   behavior change to the two existing actions).

6. **`src/components/canvas/CanvasToolbar.tsx`** — (B) replace the self-owned file input: drop the
   `onAddImageFile` prop, the `fileInputRef`, and the hidden `<input>`; change the button's `onClick` to a
   new `onAddImageClick: () => void` prop. Tooltip stays `Add image (⇧I)` — now accurate.

### New

7. **`src/components/canvas/CanvasContextMenu.tsx`** — client component. A cursor-positioned menu rendered
   via `createPortal`, reusing the exact panel styling from `Dropdown`'s panel and the `MenuItem`
   component. Outside-click + `Escape` close (same effect pattern as `Dropdown.tsx:47-68`). Renders only
   the items that `SelectionActionFlags` marks valid.

8. **`src/lib/canvas/selection-actions.ts`** — pure, framework-free (no `"use client"`). The single
   "what actions are valid for this selection" helper shared by the context menu and any future toolbar.

9. **`src/lib/canvas/selection-actions.test.ts`** — `node:test` unit tests for `selectionActions`
   (matching the existing `src/lib/canvas/*.test.ts` convention).

---

## Data model / type changes

**No `Connector`, `CanvasNode`, `Endpoint`, or `CanvasState` type changes** (per decisions.md D4):
endpoint re-targeting reuses the existing `Endpoint` union (`{nodeId, anchor}` attached | `{x,y}` free,
`types.ts:76-78`). The only type additions are local to the components/store:

- `CanvasSurface` `DragState` (`CanvasSurface.tsx:101-118`):
  - `DragKind` gains `"connector-endpoint"`.
  - `move`-kind gains optional flags: `altDuplicate?: boolean`, `altDuplicated?: boolean`,
    `pendingDeselectId?: string`.
  - `connector-endpoint`-kind adds: `endpointConnectorId?: string`, `endpointEnd?: "from" | "to"`.
- `canvas-store.ts` `CanvasStore` interface gains `duplicateSelectionInPlace` and
  `updateConnectorEndpoint` (signatures below).
- `selection-actions.ts` introduces `SelectionActionFlags` (a plain flags object).

No schema change, no jsonb shape change, no migration. Persisted board `data` is byte-for-byte unchanged.

---

## Interfaces (exact signatures)

### `src/lib/canvas/selection-actions.ts` (pure)

```ts
import type { CanvasState } from "./types";

export interface SelectionActionFlags {
  hasNodeSelection: boolean;      // selection.length > 0
  hasConnectorSelection: boolean; // selectedConnectorIds.length > 0
  canDuplicate: boolean;          // >= 1 node selected
  canCopy: boolean;               // >= 1 node selected
  canPaste: boolean;              // clipboardCount > 0
  canDelete: boolean;             // >= 1 node OR connector selected
  canReorder: boolean;            // >= 1 node selected (bring-to-front / send-to-back)
  canGroup: boolean;              // >= 2 nodes selected AND not all sharing one non-null groupId
  canUngroup: boolean;            // some selected node has a non-null groupId
}

export function selectionActions(
  state: CanvasState,
  selection: string[],
  selectedConnectorIds: string[],
  clipboardCount: number
): SelectionActionFlags;
```

`canGroup` rule (mirrors group()'s own guard, extended): `selection.length >= 2` and the selected nodes
do **not** all already share one identical non-null `groupId`. `canUngroup`: at least one selected node
has `groupId != null`. Connector-only selection ⇒ everything false except `hasConnectorSelection` and
`canDelete`.

### `src/lib/canvas-store.ts` (additions)

```ts
// CanvasStore interface additions:
duplicateSelectionInPlace: () => void;
updateConnectorEndpoint: (
  connectorId: string,
  end: "from" | "to",
  endpoint: Endpoint
) => void;

// module-level export (reads the module `clipboard` var; not reactive):
export function hasClipboard(): boolean; // clipboard.length > 0
```

- `duplicateSelectionInPlace()` — clones the current node selection with **zero** offset (duplicates
  land exactly on the originals), new ids/groupIds (same remap rules as `duplicateSelected`), appends them
  front-most, sets `selection` to the new ids, and — critically — runs through
  `mutateGraph(..., { coalesce: true })` so it shares the active gesture baseline with the move that
  follows it (see Data flow C). Reuses the new internal `buildClones` helper.
- `updateConnectorEndpoint(connectorId, end, endpoint)` — replaces `connector[end]` on the matching
  connector, via `mutateGraph(..., { coalesce: true })` (live drag ticks collapse to one undo step,
  exactly like the opacity-slider fix, `.council/canvas-board/decisions.md:43`). Does **not** touch
  `selection`/`selectedConnectorIds` (the connector stays selected). No-op if the connector id is absent.

### `src/components/canvas/CanvasContextMenu.tsx`

```ts
export type ContextMenuAction =
  | "duplicate" | "copy" | "paste" | "delete"
  | "bringToFront" | "sendToBack" | "group" | "ungroup";

export function CanvasContextMenu(props: {
  x: number;                        // client (screen) coords
  y: number;
  flags: SelectionActionFlags;
  onAction: (action: ContextMenuAction) => void;
  onClose: () => void;
}): JSX.Element;
```

Renders (via portal, `MenuItem` rows, in this order, each shown only if its flag is true):
Duplicate · Copy · Paste · — · Bring to front · Send to back · — · Group · Ungroup · — · Delete.
Empty-canvas right-click ⇒ only Paste is enabled (all node flags false). Dividers collapse when a whole
group is hidden.

### `src/components/canvas/ConnectorLayer.tsx` (added props)

```ts
onEndpointPointerDown?: (e: React.PointerEvent, connectorId: string, end: "from" | "to") => void;
onConnectorContextMenu?: (e: React.PointerEvent | React.MouseEvent, connectorId: string) => void;
```

### `src/components/canvas/CanvasAssetPanel.tsx` (added prop)

```ts
projectId: string | null;   // the board's project == global activeProjectId
```

### `src/components/canvas/CanvasToolbar.tsx` (changed props)

```ts
// remove: onAddImageFile: (file: File) => void;
// add:
onAddImageClick: () => void;
```

---

## Data flow

### A — Project-scoped asset library

`CanvasView` passes `projectId={activeProjectId}`. `CanvasAssetPanel` derives:

```
placeable = items.filter(status === "succeeded")           // unchanged
scoped    = scope === "project"
              ? placeable.filter(i => projectId != null && i.projectId === projectId)
              : placeable                                   // "all" == today's behavior
base      = tab === "favourites" ? scoped.filter(isFavorite) : scoped
filtered  = base.filter(prompt matches search)
```

- `GenerationItem.projectId` is `string | undefined` (`types.ts:37`); items detached from a deleted
  project are set to `undefined` (`store.ts:601-602`). The `i.projectId === projectId` test excludes
  `undefined` from "This project" (AC2) and the `"all"` branch includes them (AC2).
- Scope persists to `localStorage[SCOPE_KEY]` (same try/catch pattern as `COLLAPSE_KEY`,
  `CanvasAssetPanel.tsx:47-63`). Default `"project"` on first open (AC1). No schema/jsonb change (A4).
- **Error path:** if `projectId` is `null` (should not happen — `ensureDefaultProject` guarantees one),
  "This project" shows an empty grid via the existing `AssetEmptyState`; the toggle still lets the user
  reach "All projects".

### B — Keyboard shortcuts

All added inside the existing `onKeyDown` in `CanvasView` (`:127`), **after** the focus guard
(`:129-131`) so nothing fires while editing a sticky/text/rename input (AC11). Each binding
`preventDefault()`s and `return`s (matching existing handlers). `mod = e.metaKey || e.ctrlKey` already
exists (`:133`).

- `mod+G` → `group()`; `mod+Shift+G` → `ungroup()` (detect `e.key.toLowerCase() === "g"` + `e.shiftKey`).
- `mod+]` → `bringForward()`; `mod+[` → `sendBackward()`; `mod+Shift+]` → `bringToFront()`;
  `mod+Shift+[` → `sendToBack()`. **Detect brackets via `e.code` (`"BracketRight"`/`"BracketLeft"`), not
  `e.key`** — with Shift held, `e.key` for `]` becomes `"}"` on a US layout, so `e.code` is the robust
  discriminator; `e.shiftKey` chooses front/back vs forward/backward.
- `mod+C` → `copy()`; `mod+V` → `paste()`.
- `⇧I` (`e.key.toLowerCase() === "i" && e.shiftKey && !mod`) → `openImagePicker()`.
- **Latent-bug fix:** add `if (mod) return;` immediately before the trailing tool-letter switch
  (`:208-214`). Today `mod+C` falls through to `key === "c"` and wrongly switches to the connector tool;
  the guard prevents any `mod+<letter>` from switching tools. The 8 new mod bindings all `return` before
  this anyway; the guard is belt-and-suspenders and also stops `mod+V`/`mod+H`/etc. leaking to tools.

`⇧I` wiring (single source of truth): `CanvasView` owns one hidden `<input type="file" accept="image/*">`
whose `onChange` calls the existing `addImageFile(file)` (`:116-123`). `openImagePicker = () =>
inputRef.current?.click()`. The `CanvasToolbar` button now calls `onAddImageClick={openImagePicker}`
(`CanvasToolbar.tsx` loses its own input/ref). One input, one code path, tooltip accurate (AC6).

### C — Mouse functionality

**C1 Alt/Option+drag-to-duplicate** (Figma "in-place clone then drag original stays"):
- `onPointerDownNode` (select tool): if `e.altKey`, ensure the node is selected (add via `setSelection`
  if not already in `selection`; keep a multi-selection intact), start `kind:"move"` with
  `altDuplicate:true`. (Alt takes precedence over shift's multi-select toggle.)
- `onPointerMove` `move` branch: on the **first** move past threshold, if
  `drag.altDuplicate && !drag.altDuplicated`: call `duplicateSelectionInPlace()` (coalesced, zero
  offset; selects the duplicates), set `drag.altDuplicated = true`, and `return` (skip this ~2px tick).
  Subsequent moves preview the **duplicates** (store `selection`/`present` have re-rendered to the new
  ids) using the existing local-preview path unchanged.
- `endDrag` `move` branch: unchanged — commits the total delta via `moveSelectionBy(dx, dy)`. Because
  `duplicateSelectionInPlace` and the closing `moveSelectionBy` are **both** coalesced, they share one
  `gestureBaseline` (`canvas-store.ts:266-312`) and collapse into **one undo step** (originals untouched;
  AC7). Alt+click without dragging (`drag.moved` stays false) never duplicates.

**C2 Shift+drag axis-constrain** (dominant-axis, re-evaluated live per Figma):
- In `onPointerMove` `move` branch, before calling `moveNodesBy`, if `e.shiftKey`: with cumulative
  `worldDx/worldDy`, zero the smaller magnitude (`abs(dx) >= abs(dy) ? dy = 0 : dx = 0`). The commit in
  `endDrag` reads the (already-constrained) `preview` position, so no separate commit-time logic (AC8).
- **Shift+drag vs shift+click multi-select disambiguation** (protects the original shift-click AC):
  `onPointerDownNode` with `e.shiftKey`: if the node is **not** selected → add it (`setSelection([...])`)
  and start move (a shift-drag on a new node adds+moves); if the node **is** already selected → set
  `drag.pendingDeselectId = node.id` and do **not** toggle it out yet. In `endDrag`/`onPointerUp`, if
  `!drag.moved && drag.pendingDeselectId` → `toggleSelect(pendingDeselectId)` (realizes shift-click-to-
  deselect on release). This preserves shift-click multi-select while letting shift+drag constrain the
  axis without dropping the grabbed node.

**C3 Right-click context menu:**
- Container `onContextMenu(e)` (CanvasSurface): `preventDefault()`; compute `worldPoint`;
  `nodeId = hitTest(present, worldPoint)`. If `nodeId` and it's not in `selection` → `setSelection([nodeId])`
  (right-click selects the item under the cursor, Figma-style); if empty canvas → `clearSelection()`.
  Then open the menu at `{x: e.clientX, y: e.clientY}`.
- Connector right-click: `ConnectorLayer`'s fat hit-path `onContextMenu` (new `onConnectorContextMenu`
  prop) `stopPropagation()`s, selects the connector (`selectedConnectorIds:[id], selection:[]`), and opens
  the menu — so the container handler doesn't also fire.
- The menu computes items from `selectionActions(present, selection, selectedConnectorIds,
  hasClipboard() ? 1 : 0)`. `onAction` maps to store calls: duplicate→`duplicateSelected`,
  copy→`copy`, paste→`paste`, delete→`deleteSelected`, bringToFront→`bringToFront`,
  sendToBack→`sendToBack`, group→`group`, ungroup→`ungroup`; then `onClose`. Outside-click/`Escape`
  close (AC9). This is the second, discoverable on-ramp to the section-B actions (decisions.md D3).

### D — Connector endpoint editing

- **Grab:** `ConnectorLayer` renders the two endpoint dots only when the connector is selected
  (`:91-96`). They gain `pointer-events-auto`, a `cursor-move`, and a fat invisible grab circle
  (r≈9, mirroring the fat hit-path pattern) whose `onPointerDown` `stopPropagation()`s and calls
  `onEndpointPointerDown(e, c.id, "from" | "to")`.
- **Begin drag:** `CanvasSurface.onEndpointPointerDown` `setPointerCapture`s the dot (subsequent
  pointer events still bubble to the container — identical to how resize handles work, `NodeView.tsx:151`)
  and sets `dragRef = { kind: "connector-endpoint", endpointConnectorId, endpointEnd, ... }`;
  `onTransientChange?.(true)`.
- **Live re-target + snap:** `onPointerMove` `connector-endpoint` branch:
  `worldPoint = screenToWorld(screen, viewport)`; `target = hitTest(present, worldPoint)` (reuses the
  exact snap-to-node logic connector *creation* uses, `:452-458`); set `connectorHoverTargetId = target`
  (drives the existing node highlight ring, `NodeView.tsx:181`); build the new endpoint
  (`target ? {nodeId: target, anchor:"auto"} : {x, y}`) and call
  `updateConnectorEndpoint(connectorId, end, endpoint)` (coalesced). The **real** connector re-renders
  through `connectorPath` each tick, giving an accurate live preview in the connector's true style/curve
  — `connectorPath` itself is untouched (D4).
- **Release:** `endDrag` `connector-endpoint` branch clears `connectorHoverTargetId`,
  `onTransientChange?.(false)`. The coalesced gesture commits as **one** history step via the existing
  idle-finalize (`GESTURE_IDLE_MS`), the same mechanism `moveSelectionBy` already relies on (AC10). Drop
  over a node ⇒ attached; drop over empty canvas ⇒ free `{x,y}` (detached). Deleting a node still drops
  its connectors via the existing `deleteSelected` logic (`canvas-store.ts:639-644`) — unchanged.
- **Error paths:** `updateConnectorEndpoint` is a no-op for a missing connector id; a re-target to a node
  that is later deleted resolves via the existing dangling-ref guard in `resolveEndpoint`
  (`geometry.ts:246`) and `safeResolve` (`ConnectorLayer.tsx:129`).

---

## Acceptance-criteria mapping (all 12)

1. **Asset panel defaults to This project; toggle to All projects and back** — A: `scope` state defaults
   `"project"`, segmented control flips it, persisted in `localStorage`.
2. **No-`projectId` items never in This project, always in All projects** — A: `i.projectId === projectId`
   excludes `undefined`; the `"all"` branch is unfiltered.
3. **`mod+G`/`+Shift+G` group/ungroup; single-click then selects the whole group** — B: bindings →
   `group()`/`ungroup()`; group membership is the existing shared `groupId` selected as a unit by existing
   selection logic.
4. **`mod+]`/`[`/`Shift+]`/`Shift+[` change z-order** — B: bindings (via `e.code` bracket detection) →
   `bringForward`/`sendBackward`/`bringToFront`/`sendToBack` (existing `zorder.ts` helpers).
5. **`mod+C`/`V` copy then paste as new nodes, offset** — B: bindings → existing `copy()`/`paste()`,
   which already assign new ids and offset `+20,+20` (`canvas-store.ts:746-770`).
6. **Advertised image shortcut works** — B: `⇧I` → shared `openImagePicker()`; tooltip now accurate.
7. **Alt/Option+drag duplicates, original stays** — C1: `duplicateSelectionInPlace()` + coalesced move;
   originals untouched, duplicates follow the cursor.
8. **Shift+drag constrains to one axis** — C2: dominant-axis zeroing in the move preview.
9. **Right-click menu: Duplicate/Copy/Delete/Bring-to-front/Send-to-back, context-scoped (node,
   connector, empty→paste-only)** — C3: `CanvasContextMenu` driven by `selectionActions`.
10. **Selected connector endpoints draggable; onto node reattaches, to empty detaches; one undo step** —
    D: `updateConnectorEndpoint` (coalesced) + `connector-endpoint` drag reusing `hitTest` snap.
11. **No new shortcut fires while editing text** — B: everything sits behind the existing focus guard
    (`CanvasView.tsx:129-131`); the context menu's own actions are pointer-driven, not keyboard.
12. **No regression to the original 11 ACs** — see the dedicated section below.

---

## Regression analysis (AC12 — no regression to the original 11 ACs)

Codepaths the new logic touches that the original ship's tests / ACs cover — flagged so the
test-engineer knows exactly what to re-verify:

- **`moveSelectionBy` frame-membership (original geometry tests: `moveNodesBy`, `computeFrameMembership`).**
  Alt-drag-duplicate ends by calling `moveSelectionBy` on the **duplicates**, and C2's axis-constrain
  changes the delta passed to it — but neither changes `moveSelectionBy`/`moveNodesBy`/
  `computeFrameMembership` themselves; they receive a (possibly axis-zeroed) delta and a different id set.
  **Re-verify:** (a) alt-dragging a framed node out of its frame clears `parentId` (same
  `computeFrameMembership` path); (b) dragging a frame still carries children; (c) shift-constrained move
  still reparents correctly at the constrained end position.
- **Shift-click multi-select (original selection AC).** C2 defers the *deselect* case to pointer-up.
  **Re-verify:** shift-click on an unselected node adds it; shift-click on a selected node removes it (now
  on mouse-up without movement); marquee + shift-click combinations unchanged.
- **Connector creation (original connector AC).** D reuses the same `hitTest` snap + `connectorHoverTargetId`
  highlight + `draftConnector`/`ConnectorLayer` rendering, but the *create* path (`kind:"connector"`) is
  untouched. **Re-verify:** dragging a new connector from a node/edge-handle/empty canvas still creates
  and attaches exactly as before; the new endpoint dots don't intercept create-drags (they only render
  when a connector is already selected, and `stopPropagation` on their pointerdown can't fire during
  creation).
- **Tool-letter shortcuts (`v/h/r/c/s/t/f`).** The new `if (mod) return;` guard runs before the
  tool-letter switch. **Re-verify:** plain letters still switch tools; `mod+<letter>` no longer switches
  tools (this is a *fix*, not a regression — it removes the accidental `Cmd+C → connector` behavior).
- **Coalesced undo cap (original opacity-slider fix, decisions.md:43).** Both new store actions use
  `mutateGraph(..., {coalesce:true})`; an endpoint drag or an alt-drag must produce a **single** history
  entry, not one-per-tick. **Re-verify:** a long endpoint drag + a long alt-drag each undo in one press.
- **`duplicateSelected`/`paste` refactor.** Extracting `buildClones` must not change their output.
  **Re-verify:** `mod+D` duplicate and `mod+V` paste still offset `+20,+20`, remap groupIds, and keep
  intra-selection parent links (these have no dedicated unit test today; verify by `npm run build` +
  manual).

No API route, schema, jsonb shape, autosave, persistence, or global-`store.ts` behavior is touched, so the
original persistence/multi-board/build ACs are structurally out of the blast radius.

---

## Test seams

Unit-testable (pure, `node:test`, matching `src/lib/canvas/*.test.ts`):

- **`selection-actions.test.ts` (new):** `selectionActions` truth table — empty selection; single node;
  two ungrouped nodes (`canGroup` true); two nodes already sharing one group (`canGroup` false,
  `canUngroup` true); mixed grouped/ungrouped; connector-only (`canDelete` true, node flags false);
  `clipboardCount` 0 vs >0 → `canPaste`.
- **Existing pure helpers reused, already covered:** `hitTest` (endpoint snap + right-click target),
  `moveNodesBy`/`computeFrameMembership` (alt-drag + axis-constrain feed these), `zorder.*`
  (context-menu/keyboard z-order), `resolveEndpoint`/`connectorPath` (endpoint re-target rendering). No
  new geometry/hit-test helper is introduced — endpoint grab is DOM `onPointerDown` on the dots, and
  re-target snapping delegates to the already-tested `hitTest`, so there's nothing new to unit-test there.

DOM/pointer-only, out of automated scope (verified by `npm run build` typecheck + manual QA, per the
original ship's approach): the keydown wiring, alt/shift pointer state-machine, right-click detection,
`CanvasContextMenu` portal/positioning/outside-click, the endpoint drag pointer capture + live coalesced
mutation, and the `localStorage` scope persistence.

---

## Trade-offs

- **Alt-drag = duplicate-in-place-then-move (C1), collapsed via shared coalescing baseline**, rather than
  a preview-ghost-committed-on-release. Chosen because it reuses the *entire* existing move preview/commit
  path verbatim (duplicates become the selection and drag with real rings/handles), needs only one new
  store action, and still yields one undo step. Cost: a one-tick (~2px) skip on the frame that triggers
  duplication, and reliance on the 400ms idle-finalize to fuse the two coalesced mutations — acceptable
  and identical to how `moveSelectionBy` already finalizes.
- **Endpoint drag mutates the real connector per-tick (coalesced), not a local draft** (D). Chosen so the
  live preview is the connector's true curve/style via `connectorPath` (free reuse) and snapping/highlight
  reuse the create-path code. Cost: per-tick store writes — bounded and history-safe by coalescing (few
  connectors; matches the opacity-slider precedent). Rejected: local-draft-commit-on-release (the move
  pattern) — would draw a styleless dashed preview while the old endpoint still renders underneath.
- **Context menu is a bespoke portal reusing `MenuItem` + `Dropdown`'s panel classes**, not the `Dropdown`
  component itself. Chosen because `Dropdown` is trigger-anchored (`Dropdown.tsx:70-109`) and cannot open
  at an arbitrary cursor point; reusing only the styling primitives keeps the look identical with far less
  fighting. Cost: a small amount of duplicated outside-click/Escape effect logic (copied from the proven
  `Dropdown` pattern).
- **`⇧I` wired by lifting the single file input into `CanvasView`** (touching `CanvasToolbar`) rather than
  adding a second hidden input just for the shortcut. Chosen for a single "add image" code path and an
  accurate tooltip; cost is a two-line prop change to the toolbar. Rejected: correcting the tooltip to
  drop `⇧I` — leaves a real capability unreachable when wiring it is trivial.
- **Scope persisted in `localStorage`, not the board jsonb** (A4) — no schema change, matches the existing
  collapse-flag pattern; cost is the choice is per-browser, not per-board (acceptable per AC1/A4).
- **Binary scope toggle, not an arbitrary project picker** (decisions.md D1) — smaller UI surface,
  extendable later.

---

## Out of scope (deliberately not built)

- Manual bezier control-point / curve-shape editing for connectors (D4): only endpoint *re-targeting*.
- Arrowhead 3-state / Bold / text-align (original M1, decisions.md D5): need type-model extensions.
- Cross-board / cross-tab clipboard (decisions.md D2): `copy`/`paste` stay within-board.
- Cursor-anchored paste position (paste keeps the existing `+20,+20` offset); an arbitrary-project asset
  picker; multiplayer; touch/trackpad-specific tuning.
- 45° angle-snapping on shift+drag (only orthogonal dominant-axis constrain is specified, AC8).

---

## Risks

- **`e.key` vs `e.code` for shifted brackets** — the biggest footgun; mitigated by mandating `e.code`
  (`BracketLeft`/`BracketRight`) for the z-order bindings so Shift doesn't change the detected key.
- **Alt-drag stale-closure** — the duplication mutation re-renders `CanvasSurface` mid-gesture; mitigated
  by `return`ing on the duplication tick so the next event reads fresh `selection`/`present`, and by not
  resetting `startScreen` (so the total delta stays measured from pointer-down).
- **Two coalesced actions not fusing into one undo step** — if the alt-drag duplication and its move land
  under different gesture baselines, undo would need two presses; mitigated by both using
  `mutateGraph(coalesce:true)` and the module-level `gestureBaseline` persisting across them. Explicitly
  called out as a re-verify item (Regression section).
- **Shift-drag regressing shift-click multi-select** — mitigated by the deferred-deselect rule (C2) and
  flagged for re-verification.
- **Context menu covering off-screen at viewport edges** — mitigated by clamping `x/y` to the viewport in
  `CanvasContextMenu` (same clamp shape as `Dropdown.tsx:82-92`).
