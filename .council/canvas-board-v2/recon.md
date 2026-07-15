# Recon — Canvas Board v2

## 1. Keyboard shortcuts — current inventory

`CanvasView.tsx` document-level keydown (`:127-218`), guarded at top (`:129-131`)
against `target.isContentEditable`/INPUT/TEXTAREA focus — reuse this guard for any
new binding.

- `mod+Z`/`mod+Shift+Z` → undo/redo (`:135-140`)
- `mod+D` → duplicate (`:141-145`); `mod+A` → select all (`:146-150`); `mod+0` → zoom 100% (`:151-156`)
- `Delete`/`Backspace` → delete selection (`:157-161`)
- `Escape` → clear selection + select tool (`:162-166`)
- `Shift+!` → zoom to fit (`:167-170`)
- Arrow keys → nudge (1px, 10px+Shift) (`:171-180`)
- `Tab`/`Shift+Tab` → cycle selection (`:181-192`)
- `Enter` → place default node at viewport center (`:193-206`)
- Tool-switch letters, no mod (`:208-214`): `v`=select, `h`=hand, `r`=rect, `c`=connector,
  plus `SHAPE_SHORTCUTS` (`:21-25`): `s`=sticky, `t`=text, `f`=frame.
- **Bug**: toolbar tooltip advertises `⇧I` for "add image" (`CanvasToolbar.tsx:204`) — not wired anywhere.
- **Dead code**: `canvas-store.ts` implements `group`/`ungroup`/`bringToFront`/`sendToBack`/
  `bringForward`/`sendBackward`/`copy`/`paste` (interface at `:119-126`, impls `:686-770`
  roughly) — grepped the whole `src/components/canvas/` tree for calls to any of these
  eight methods: **zero call sites**. No keyboard shortcut, no toolbar button, no menu
  reaches them. `clipboard` is a module-level `let clipboard: CanvasNode[] = []` (`:446`).

`CanvasSurface.tsx` space-to-pan (`:199-216`) is a separate keydown/keyup pair with the
same editing-target guard (`:203`).

## 2. Mouse/pointer interactions — current inventory

`CanvasSurface.tsx`, `DragState.kind`: `pan | marquee | move | resize | connector | create` (`:101`).
- Wheel (`:225-249`): plain scroll pans; `ctrl`/`meta`+scroll zooms **toward cursor**
  (`:231-238`) — confirmed intentional (original decisions.md D7), not a bug.
- Space+drag pan: `isPanning = tool === "hand" || spaceHeld` (`:223`).
- Marquee select: `:297-306`, `:421-424`, `:470-485`, partial-overlap counts as a hit.
- Shift-click adds to selection: node down (`:333-334`), connector hit (`ConnectorLayer.tsx:78`).
- Shift during resize: inverts aspect-lock (`:445,551`), NOT an axis constraint.
- **Missing**: shift-drag axis/45° constrain on move, alt/option-drag-to-duplicate,
  right-click/context menu (no `onContextMenu` anywhere in `CanvasSurface.tsx`/`ConnectorLayer.tsx`).
- Connector drag: free-standing from empty canvas (`:281-295`) or from node body/edge-handle
  (`:319-329`, `:363-385`); ends attached if released over a node, else free (`:510-527`).

## 3. Connector/line editing — current capabilities

- Connectors selectable (`ConnectorLayer.tsx:70-80`, 14px invisible hit-path), show two
  endpoint dots when selected (`:91-96`) — **dots are decorative, no `onPointerDown`,
  cannot be dragged**. Only style (stroke/width/kind/opacity) is editable post-creation
  via `updateSelectedStyle`/`applyStylePatchToConnector` (`canvas-store.ts:238-246`).
- No control-point/curve handle; `connectorPath` (`geometry.ts:267-288`) is fully
  automatic (`bow = min(dist*0.25, 60)`), not user-adjustable — v2 should leave this as-is.
- Deletion: Delete/Backspace + `selectedConnectorIds` only (`CanvasView.tsx:157-161` →
  `canvas-store.ts` around `:629-648`); no right-click delete today.
- `Endpoint` type already supports both attached (`{nodeId, anchor}`) and free (`{x,y}`)
  forms (`types.ts:76-78`); auto-anchor resolves to nearest perimeter point
  (`geometry.ts:207-227`). Free-standing endpoints were already added in the original
  ship's Stage-3 fixes (original decisions.md D7) even though the original ui-spec.md
  said "no floating endpoints in v1" — don't re-litigate, just note the type already
  supports what v2's endpoint-dragging needs; no `Endpoint` type change required.
- No existing store action to mutate a connector's endpoint after creation (grepped for
  `updateConnector`/`setConnectorEndpoint` — no hits). This is genuinely new logic, not wiring.

## 4. Asset panel project-scoping

`CanvasAssetPanel.tsx:36` reads `useStore((s) => s.items)` — confirmed zero project
filter; `filtered` (`:82-86`) only applies tab/search. `store.ts`: `activeProjectId:
string | null` (`:75`, `:192`), `projects: Project[]`, `setActiveProject` (`:554`).
`GenerationItem.projectId` (`src/lib/types.ts:37`) is `projectId?: string` — optional.
Confirmed items with `projectId === undefined` exist in practice: `store.ts:601-602`
sets `projectId: undefined` when a project is deleted; pre-project-era generations
would also lack it. A "This project" filter must treat `undefined` as excluded, not
silently matched.

The canvas board is already opened within a project context (`CanvasView`/
`BoardSwitcher` already thread a `projectId` prop through, since boards are
per-project) — the new scope control should filter against *that* `projectId`, not
necessarily the global `store.ts` `activeProjectId` (which drives the Studio-mode
History panel and may or may not equal the board's own project — architect should
confirm which is correct by reading how `CanvasView` receives/uses `projectId` today).

## 5. Already-decided/deferred items — do not re-litigate

Per original `ui-spec.md` and `decisions.md` D8: Bold toggle + text-align for
text/sticky nodes, and 3-state arrowhead (none/one-way/two-way — `Connector.kind` is
currently 2-state `"line"|"arrow"`) were spec'd but deferred purely because the data
model lacks the backing fields. Out of scope for this v2 round per spec.md's
Non-goals (D5 in this round's decisions.md) — "lines... better editable" here means
endpoint re-targeting (§3 above), not arrowhead styling.
