# UI Spec — Canvas Board v2 (project-scoped assets, mouse/context-menu, connector editing)

Design contract for the four v2 enhancement areas. Mode 1 (pre-implementation). Every
requirement below is checkable from a rendered screenshot or a click-through.

**This is an incremental spec.** The single biggest risk is inventing a new visual
language. It does not. Everything here **reuses classNames and motion idioms that already
ship** in `Dropdown.tsx`, `BoardSwitcher.tsx`, `CanvasAssetPanel.tsx`, `ConnectorLayer.tsx`,
`NodeView.tsx`, and `CanvasSurface.tsx`. The original `.council/canvas-board/ui-spec.md`
still governs the overall board; read its preamble first — the app is **strictly
monochrome dark**, the `brand` token is literally white (`#ffffff`), "primary" is a
translucent-white pill (`bg-brand/20 text-brand hover:bg-brand/30`), active pills are
`bg-ink-600 ring-1 ring-line` with a framer-motion `layoutId`, and the **only** saturated
color anywhere is user content or the single destructive red. v2 adds **no new color**.

Where this spec says "reuse X", it means the exact existing class string / component, not a
look-alike. Citations point at the file+line the pattern lives in today.

---

## Prominent assumptions (read at the design gate)

- **A1 — Scope control is a small dropdown, not a second segmented toggle.** Decision D1
  makes it binary (This project / All projects), but the asset-panel header row is already
  full at `w-[300px]` (a `flex-1` segmented tab group + a `w-7` collapse button). A second
  full-width segmented control cannot share that row without crushing the Assets/Favourites
  labels. So the scope control is a compact `Dropdown` (the `BoardSwitcher` idiom) on its
  own thin row. See §A for exact placement and why. If the implementer finds room for a
  segmented control at the target width without truncating either label, that is an
  acceptable substitute **only** if it keeps the two-state semantics and the distinct
  empty state below — flag it if you deviate.
- **A2 — Context menu is a new component but a visual clone of a `Dropdown` menu panel.**
  The existing `Dropdown` is trigger-anchored; a right-click menu is cursor-anchored, so the
  positioning plumbing is genuinely new. Its *panel and rows* must be pixel-identical to a
  `Dropdown`/`MenuItem` menu (§B). No new panel styling is introduced.
- **A3 — Alt-drag / shift-drag get almost no chrome.** These are power-user affordances.
  Alt-drag reuses the native CSS `copy` cursor; shift-drag adds nothing on-canvas (§C).
  This is deliberate restraint matching how Figma keeps them understated, not an omission.
- **A4 — Connector endpoint editing keeps the at-rest dot visually identical** to today's
  decorative dot (`ConnectorLayer.tsx:93-94`); interactivity is added underneath it (larger
  invisible hit target + hover affordance), so a selected connector at rest looks unchanged
  (§D). This preserves consistency; the handle only "lights up" on hover.

---

## A. Asset panel — project-scope control

### A.1 Placement

`CanvasAssetPanel.tsx`'s panel is `absolute inset-y-0 left-0 z-20 flex w-[300px] flex-col
border-r border-line bg-ink-850` (`:103`), with a header region of two stacked rows:

1. **Tab row** — `flex items-center gap-1 border-b border-line px-3 py-2.5` (`:104`):
   the `[Assets | Favourites]` pill group (`flex-1 ... rounded-full bg-ink-700 p-1`,
   `:105`) + the collapse chevron (`ChevronsLeft`, `:113-121`). **Unchanged.**
2. **Search row** — `border-b border-line px-3 py-2.5` (`:124`) holding the rounded search
   input. **Unchanged.**

**Add the scope control as a new thin row inserted between the tab row and the search
row.** Row container: `flex items-center border-b border-line px-3 py-2` (one notch tighter
vertical padding than the neighbours — `py-2` vs `py-2.5` — so it reads as a subordinate
filter strip, not a third primary control). The control is **left-aligned**; the rest of
the row is empty space.

This keeps the tab row and search row untouched (no width fight, no redesign — the task's
constraint) and places scope logically "above" search since scope narrows the pool that
search then filters.

### A.2 The control itself (reuse `Dropdown` + `MenuItem`)

A compact `Dropdown` (`@/components/Dropdown`) whose **trigger** matches the `BoardSwitcher`
trigger pill (`BoardSwitcher.tsx:138-147`) scaled down to `text-xs`:

```
inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-ink-700
px-2.5 py-1 text-xs text-white/60 transition hover:text-white/90   (open && "border-brand/40")
```

Trigger contents, left→right:
- current-scope icon, `h-3.5 w-3.5 text-white/50`: **This project** → lucide `Folder`;
  **All projects** → lucide `Library`.
- the label text (`This project` / `All projects`), `truncate`.
- `ChevronDown`, `h-3 w-3 shrink-0 transition-transform` (`open && "rotate-180"`) — exactly
  the chevron treatment in `BoardSwitcher.tsx:145`.

**Dropdown menu** (default `align="left"`, `side="bottom"`) reuses `MenuItem` verbatim — a
two-row list identical in structure to the board list in `BoardSwitcher.tsx:170-179`:

| Row | Icon (lucide, `h-4 w-4 text-white/50`) | Label | Active marker |
| --- | --- | --- | --- |
| This project | `Folder` | `This project` | `Check`, `h-4 w-4 shrink-0 text-brand` when selected |
| All projects | `Library` | `All projects` | same |

The active row uses `MenuItem`'s built-in `active` prop (`bg-brand/15 text-white`,
`Dropdown.tsx:178-180`) and shows the trailing `Check` exactly as the board list does
(`BoardSwitcher.tsx:178`). Panel inherits the standard `rounded-xl border border-line
bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl` from `Dropdown` (`:143`) — no override.

### A.3 Default & persistence (verifiable)

- On board open the trigger reads **This project** (Decision spec §Acceptance 1). Verify:
  screenshot the panel on first open — the pill says "This project".
- Selecting All projects shows the full, unfiltered library (today's behavior). Selecting
  This project again re-narrows. The choice persists at least per session (implementation
  detail per spec A4 — mirror the existing `localStorage` collapse-persistence at
  `CanvasAssetPanel.tsx:47-63`, key e.g. `vivi-canvas-asset-scope-v1`). Not a visible
  requirement beyond "the pill reflects the last choice after remount".

### A.4 Filter order

Scope → tab → search, applied in that order on top of the existing `placeable`
(`CanvasAssetPanel.tsx:80`, `status === "succeeded"`):
- **This project**: keep items whose `projectId` **strictly equals** the board's own
  `projectId`. Items with `projectId === undefined` are **excluded** (spec §A, recon §4 —
  they belong to no project). 
- **All projects**: no project filter (today's `filtered`, `:82-86`).

### A.5 States (all verifiable from the grid area)

The grid area (`scroll-thin min-h-0 flex-1 overflow-y-auto p-3`, `:136`) currently renders
one of: skeleton / `AssetEmptyState` / the 2-col grid (`:137-147`). Scope adds **one new
empty state** and reuses the rest:

| Condition | What renders |
| --- | --- |
| `loading` | existing `AssetSkeletonGrid` (`:233-241`) — unchanged. |
| Grid has items | existing 2-col `grid grid-cols-2 gap-2` (`:142-146`) — unchanged. |
| **This project scope, zero items belong to this project, but All projects has items** | **NEW project-empty nudge** (below). |
| This project scope, project has items but tab/search filter them out | existing `AssetEmptyState` copy ("No results match your search." / "No favourites match your search.", `:243-263`) — unchanged. |
| All projects, empty | existing `AssetEmptyState` ("Your generations will appear here.") — unchanged. |
| Both scopes empty (brand-new user, zero generations anywhere) | existing `AssetEmptyState` global copy — **not** the nudge (switching scope wouldn't help). |

**NEW project-empty nudge** (distinct from "no assets at all"): reuse the exact
`AssetEmptyState` skeleton (`:244-263`) — the `flex h-full flex-col items-center
justify-center gap-3 px-2 text-center` wrapper and the `grid h-14 w-14 place-items-center
rounded-2xl bg-ink-700 ring-1 ring-line` icon chip — with:
- icon: lucide `FolderOpen`, `h-6 w-6 text-white/40` (empty-folder metaphor, distinct from
  the `History` icon of the generic empty state).
- line 1: `text-sm text-white/55` — "No assets in this project yet."
- line 2: `text-xs text-white/35` (mirrors the `max-w-xs text-xs text-white/35` subtext in
  the canvas empty state, `CanvasSurface.tsx:699`) — "Your other projects have assets you
  can use here."
- **action** (the nudge): a translucent-white pill button, the app's standard secondary
  action — `rounded-lg bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand
  hover:bg-brand/30` (identical to the Retry button in `CanvasView.tsx:275`) reading
  **"Show all projects"**, `aria-label="Show all projects"`. Clicking it switches scope to
  All projects (same state change as picking it in the dropdown) and the trigger pill
  updates to "All projects".

This is the *only* empty state that carries an action button; that's what makes it
distinguishable at a glance from the passive "Your generations will appear here."

### A.6 Collapsed / responsive

When the panel is collapsed (`CanvasAssetPanel.tsx:88-100`, the `ChevronsRight` re-open
button), the scope row is gone with the rest of the panel — no separate collapsed
affordance. Board is desktop-only ≥1024px (original §10), and the panel is fixed 300px, so
there is no narrow-width reflow of this control.

---

## B. Right-click context menu (new UI surface, `Dropdown`-identical look)

### B.1 Appearance — a `Dropdown` menu panel at the cursor

New component (cursor-anchored positioning is new plumbing, A2), but its panel and rows
**must be visually indistinguishable from a `Dropdown` menu**:

- **Panel:** the exact `Dropdown` panel string —
  `scroll-thin fixed z-[100] min-w-[170px] max-w-[calc(100vw-1rem)] overflow-y-auto
  rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl`
  (`Dropdown.tsx:143`), `role="menu"`, portalled to `document.body`.
- **Open animation:** the same framer-motion spring as `Dropdown` —
  `initial={{ opacity: 0, y: -6, scale: 0.97 }}` → `animate={{ opacity: 1, y: 0, scale: 1
  }}`, `transition={{ type: "spring", stiffness: 480, damping: 32 }}` (`Dropdown.tsx:133-136`).
- **Position:** anchored at the pointer `{clientX, clientY}`, then clamped into the viewport
  with the same `margin = 8` logic `Dropdown` uses in `place()` (`Dropdown.tsx:78-94`) so it
  never overflows an edge (flip up/left when near bottom/right).
- **Rows:** the exact `MenuItem` component (`Dropdown.tsx:157-186`) — `flex w-full
  items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm`, hover `hover:bg-white/6
  hover:text-white`, disabled `text-white/25 cursor-not-allowed`.
- **Icons:** leading lucide icon `h-4 w-4`, muted `text-white/50` (matching
  `BoardSwitcher.tsx:201` `<Pencil className="h-4 w-4 text-white/50" />`).
- **Shortcut hints:** right-aligned muted text inside the row — `<span className="ml-auto
  pl-6 text-xs text-white/40">⌘D</span>` — the muted-shortcut treatment the original spec
  set for the zoom menu (original §2, "Shortcuts shown right-aligned in muted `text-white/40`").
- **Dividers:** `<div className="my-1 h-px bg-line" />` — the exact divider from
  `BoardSwitcher.tsx:219`.
- **Destructive (Delete) row:** the exact two-tone treatment from the board delete row
  (`BoardSwitcher.tsx:210-211`): `<Trash2 className="h-4 w-4 text-red-400/80" />` +
  `<span className="text-red-300/90">Delete</span>`. This is the app's single sanctioned red.

### B.2 Dismissal & focus

Mirror `Dropdown`'s own behavior (`Dropdown.tsx:47-68`): close on outside `mousedown`, on
`Escape`, on `scroll`, and on any item click. On open, move focus to the first `MenuItem`
so the menu is keyboard-operable; on close, return focus to the canvas
(`role="application"` container). A second right-click elsewhere closes the current menu and
opens a new one at the new point. Only one context menu open at a time.

### B.3 Items, icons, and context-sensitivity

Full item vocabulary (lucide icons; all exist in `lucide-react`):

| Item | Icon | Shortcut hint |
| --- | --- | --- |
| Duplicate | `CopyPlus` | ⌘D |
| Copy | `Copy` | ⌘C |
| Paste | `ClipboardPaste` | ⌘V |
| Bring to Front | `BringToFront` | ⌘⇧] |
| Send to Back | `SendToBack` | ⌘⇧[ |
| Group | `Group` | ⌘G |
| Ungroup | `Ungroup` | ⌘⇧G |
| Delete | `Trash2` (red, per B.1) | ⌦ |

**Which subset shows, by what is under the cursor** (the menu is built from the target, not
a fixed list):

| Right-click target | Menu (top→bottom, `—` = divider) |
| --- | --- |
| **Empty canvas** (background, no node) | **Paste** only. Disabled (`MenuItem disabled`, greyed `text-white/25`) when the module clipboard is empty (`canvas-store.ts:446`, `clipboard.length === 0`). Pastes at the click point. |
| **Single node** | Duplicate · Copy · Paste — Bring to Front · Send to Back — Delete. (Group omitted: needs 2+. Ungroup appears **only if that node has a `groupId`**, `canvas-store.ts` group model — inserted before Delete with its own preceding divider.) |
| **Multi-selection (2+ nodes)** | Duplicate · Copy · Paste — Bring to Front · Send to Back — **Group** (enabled) · **Ungroup** (shown only if any selected node has a `groupId`) — Delete. |
| **Already-grouped selection** (selection is exactly one whole group) | Duplicate · Copy · Paste — Bring to Front · Send to Back — **Ungroup** (Group omitted, already grouped) — Delete. |
| **Connector** | **Delete** only. (The clipboard/z-order/group model is node-only — `clipboard: CanvasNode[]`, `canvas-store.ts:446`; connectors live in a separate array and have no z-order or grouping, so Copy/Duplicate/layer/group don't apply. Delete matches acceptance §9/§10.) |

Notes that keep this consistent with existing behavior:
- Right-clicking a node that is **not** in the current selection first selects it (single),
  then opens its menu — the standard select-then-act pattern; matches how left
  `onPointerDownNode` already selects on press (`CanvasSurface.tsx:335-337`).
- Right-clicking inside the current multi-selection keeps the selection and shows the
  multi-selection menu.
- Every action routes to the store method that already exists (`group`/`ungroup`/
  `bringToFront`/`sendToBack`/`copy`/`paste`/`duplicateSelected`/`deleteSelected`) — the
  menu is the on-ramp, not new logic (spec D3, recon §1).

---

## C. Alt-drag-duplicate & shift-drag-axis-constrain (near-zero chrome)

### C.1 Alt/Option-drag duplicate — cursor only

- While a **move** drag is in progress with Alt/Option held (a duplicate-drag,
  `CanvasSurface.tsx` move branch, `:426-439`), the canvas cursor is the **native CSS
  `copy` cursor** — add `cursor-copy` to the container's `cursorClass` computation
  (`CanvasSurface.tsx:608-614`) for the duration of an alt-held move. This is the standard,
  universally-recognized "you are duplicating" affordance and introduces no bespoke chrome.
- The primary feedback is simply that **a second node appears** and drags while the original
  stays put (spec §C.1 / acceptance §7). No badge, label, ghost, or count chip.
- Verify: press Alt, drag a selected node — cursor shows the OS copy glyph (arrow + small
  `+`), and on release there are two nodes.

### C.2 Shift-drag axis constrain — no on-canvas chrome

- Deliberately **understated** (A3). While moving with Shift held, motion locks to the
  dominant axis; cursor stays `move` (`NodeView.tsx:88`). **No guide line, no snap flash, no
  label.** The user reads the constraint from the node itself only travelling on one axis —
  exactly how Figma leaves it.
- The single verifiable requirement: during a shift-move, the **off-axis coordinate does not
  change** (drag mostly-horizontal → `y` is constant; mostly-vertical → `x` is constant).
  Checkable by dragging and observing the node tracks a straight horizontal/vertical line.
- Do **not** add a guide line. If a future round wants one, it must be a monochrome 1px
  line at `rgba(255,255,255,0.25)` matching the marquee stroke (`ConnectorLayer.tsx:120`),
  but that is out of scope here.

(Note: Shift already means "invert aspect-lock" during **resize**, `CanvasSurface.tsx:445,551`
— that is unchanged. Shift-axis-constrain applies to the **move** gesture only; the two
gestures never overlap.)

---

## D. Connector endpoint editing

Applies to a **selected** connector's two endpoint dots (`ConnectorLayer.tsx:91-96`), which
today are decorative. Each becomes a real drag handle. Three states:

### D.1 At rest (connector selected) — looks unchanged, becomes grabbable

- **Visible dot: identical to today** — keep `r={4} fill="white" stroke="#000"
  strokeWidth={1} vectorEffect="non-scaling-stroke"` (`ConnectorLayer.tsx:93-94`). A selected
  connector at rest is pixel-for-pixel what ships now (A4). This preserves consistency; users
  don't see a redesigned connector, just the same two dots.
- **Larger invisible hit target underneath**, so the small dot is easy to grab — a
  concentric transparent circle `r={9}` (≈18px diameter) with
  `className="pointer-events-auto cursor-grab"`. This mirrors the connector's own
  fat-invisible-hit-path pattern (`ConnectorLayer.tsx:69-80`, a 14px transparent stroke over
  a thin visible one). Cursor over the endpoint = **`grab`**, signalling "pick this up",
  distinct from the connector body's `cursor-pointer` (`:75`) and node body's `move`.
- **Hover affordance** (pointer over the hit target): the visible dot gains a **halo ring**
  reusing the create-flow hover color — a concentric `<circle r={7} fill="none"
  stroke="rgba(255,255,255,0.6)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />`,
  i.e. the same `brand/60` (white-at-0.6) used by the reattach-target highlight
  `ring-2 ring-brand/60` (`NodeView.tsx:182`). So "grabbable" is spoken in the exact accent
  the board already uses for connector interactions. Verify: hover an endpoint of a selected
  connector — a faint white halo appears and the cursor is `grab`.

### D.2 Mid-drag — live re-route, reuse the create hover-to-attach highlight

- Cursor: **`grabbing`** (`cursor-grabbing`) for the duration.
- The **dragged dot follows the cursor exactly** in world coordinates; the **other endpoint
  stays put**.
- The **connector path live-updates every pointermove**, rendered in its **real style**
  (its own `stroke`/`strokeWidth`/arrowhead + the selected glow
  `drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]`, `ConnectorLayer.tsx:89`) — **not** the
  dashed draft used for *creating* a connector (`:101-111`). Rationale: the user is editing
  an existing real line, so it should read as that line bending, mirroring the move/resize
  live-preview idiom (the real node moves live, committed on release,
  `CanvasSurface.tsx:426-439,441-450`). The automatic bezier-bow (`connectorPath`) is
  untouched (spec D4) — only the endpoint moves.
- **Reattachment-target highlight: reuse the create flow's treatment exactly.** When the
  cursor is over a valid node, that node shows `<div className="pointer-events-none absolute
  inset-0 rounded-sm ring-2 ring-brand/60" />` — the identical `connectorHoverTarget`
  overlay from `NodeView.tsx:181-183`, driven by the same `setConnectorHoverTargetId` /
  `hitTest` path used when drawing a new connector (`CanvasSurface.tsx:452-458`). So dragging
  an endpoint onto a node highlights it precisely the way dragging a *new* connector onto it
  does — no second visual dialect.
- Over empty canvas (no node under cursor): no highlight; on release the endpoint becomes a
  free `{x,y}` point (detach). The `Endpoint` type already supports free endpoints
  (recon §3, `types.ts:76-78`) — no visual difference from an attached dot; it simply sits
  at the drop point.

### D.3 On release — settle, understated

- The reattach-target highlight clears immediately (target node's `ring-2 ring-brand/60`
  disappears).
- The connector **settles into its committed path** with **no success flash** — the app's
  restrained motion language (only springs on menus/tabs; a single `floatUp` keyframe for
  appearing handles). The sanctioned, minimal "just settled" motion is to let the committed
  endpoint dot reuse the existing **`floatUp` keyframe** exactly as connection handles do
  (`animate-[floatUp_0.15s_ease-both]`, `NodeView.tsx:174`) — a ~150ms fade/rise as it
  snaps to its new anchor. Nothing louder (no color pulse, no ring expansion). If the
  implementer prefers, "just settle with no motion at all" is equally acceptable — the hard
  requirement is only that there is **no attention-grabbing confirmation animation**.
- Committed as **one undo step** (spec §D, acceptance §10), matching the gesture-coalesced
  commit-on-release pattern of `moveSelectionBy` (`CanvasSurface.tsx:490-505`). Verify:
  drag an endpoint to a new node, release, press ⌘Z once — the connector returns to its
  previous attachment in a single undo.

### D.4 Both endpoints, and detached connectors

- Both `from` and `to` dots are independently draggable (both already render when selected,
  `ConnectorLayer.tsx:91-96`).
- A connector with an already-free endpoint renders its dot at that free point and it is
  draggable too (same hit target + hover + drag rules).
- Existing live-attachment (endpoints re-route when a node moves/resizes; deleting a node
  deletes its connectors) is unchanged (original §7).

---

## Accessibility

- **Scope control (A):** the `Dropdown` trigger is a real `<button>` with
  `aria-haspopup="menu"`/`aria-expanded` (built into `Dropdown.tsx:113-124`). Each scope
  `MenuItem` has `role="menuitem"` (built in). Selected scope is conveyed by the trailing
  `Check`, not color alone. The "Show all projects" nudge button has a visible label and
  `aria-label`, and meets ≥4.5:1 (`text-brand` = white on `bg-brand/20`).
- **Context menu (B):** `role="menu"`, rows `role="menuitem"` (from `MenuItem`). Opens with
  focus on the first item; `Escape` closes and returns focus to the canvas
  (`role="application"`). Also openable via the keyboard **Context-Menu key / Shift+F10** at
  the current selection's bounding-box top-left (nice-to-have; if implemented, position like
  a normal open). Disabled items use `MenuItem disabled` (non-focusable, `text-white/25`).
- **Endpoint handles (D):** give each interactive endpoint an `aria-label` (e.g. "Connector
  start endpoint — drag to reattach" / "Connector end endpoint — drag to reattach").
  Endpoint dragging is **pointer-only**, consistent with the existing **resize handles**,
  which are also pointer-only in v1 (`NodeView.tsx:145-161`) — this is acknowledged parity,
  not a new gap. The hover halo (`rgba(255,255,255,0.6)`) and reattach highlight
  (`ring-brand/60`) convey state by ring/shape, never by color alone, consistent with the
  monochrome-chrome rule.
- **Alt/shift drag (C):** power-user pointer affordances with keyboard equivalents already
  present — duplicate is ⌘D, nudge is arrow keys (`CanvasView.tsx:141-145,171-180`); no new
  keyboard path is required for these two mouse gestures.
- **Contrast:** all new readable text uses `text-white/55` or brighter (nudge copy, menu
  labels); `text-white/40`/`white/35` is reserved for shortcut hints and secondary subtext,
  matching original §11.

---

## Acceptance-check quick map (spec §Acceptance → this spec)

1. Panel defaults to "This project"; visible control switches to "All projects" and back →
   §A.1–A.3.
2. `projectId === undefined` items never in "This project", always in "All projects" → §A.4.
3–5, 9. Group/ungroup, z-order, copy/paste reachable via the context menu → §B.3.
7. Alt-drag duplicate cursor + duplicate appears → §C.1.
8. Shift-drag axis constraint (off-axis coord constant) → §C.2.
9. Right-click menu scoped to target (node / connector / empty→paste-only) → §B.3.
10. Selected connector endpoints draggable; reattach on node, detach on empty; one undo →
    §D.
11–12. New shortcuts respect the text-input guard / no regression → governed by
    `CanvasView.tsx:128-131` guard and unchanged existing behavior; not new UI surface here.
