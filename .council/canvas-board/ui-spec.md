# UI Spec — Canvas Board (FigJam-style whiteboard)

Design contract for the new Canvas Board feature. Mode 1 (pre-implementation). Every
requirement below is written to be checkable from a rendered screenshot or a click-through.
This spec covers UI/UX only; rendering-engine and persistence-mechanics choices belong to
`design.md`.

The app is **Lumina Studio / "Vivi"** — a strictly monochrome dark UI. Read this before
designing anything new: there is **no colored brand accent**. The Tailwind `brand` token is
literally white (`#ffffff`); "primary" controls are translucent-white pills
(`bg-brand/20 text-brand hover:bg-brand/30`) and active states are a raised pill
(`bg-ink-600 ring-1 ring-line`) animated with a framer-motion `layoutId`. The Canvas Board must
stay inside this vocabulary. The **only** saturated color on the board comes from *user content*
(sticky-note colors, shape fills the user picks), never from app chrome.

---

## Prominent assumptions (logged at the design gate — read these)

- **A1 — Desktop-only, min width 1024px.** Spec §Non-goals scopes v1 to desktop pointer +
  keyboard. Below 1024px (or on a coarse/no-hover pointer) the board shows a blocking overlay
  (see §9). The entry-point rail is already `hidden sm:flex`, so the tab naturally disappears on
  phones.
- **A2 — Full-screen takeover via the `Sidebar.tsx` rail (primary approach).** Board is a
  top-level *view*, not a 4th right-panel tab. When active it replaces the center feed +
  composer **and** the right `HistoryPanel`. `TopBar` (h-14) and the left rail stay. See §1 for
  why the rail beats a 4th `HistoryPanel` tab.
- **A3 — Tab label is "Board"** (not "Figma"/"Canvas"/"FigJam"). Icon: lucide `Shapes`.
- **A4 — Contextual styling toolbar, not a fixed inspector.** The right panel real-estate is
  gone in board view, so node styling floats near the selection (FigJam convention). No new
  persistent side inspector.
- **A5 — Shapes live in the bottom toolbar; the left panel is the Asset Library.** This
  deliberately diverges from the reference screenshot's left "Shapes" panel — rationale in §4.
- **A6 — Color chrome stays monochrome.** Toolbars, panels, handles, marquee, connectors are
  white-on-ink. Sticky/shape/frame fills are the exception (user-chosen).

---

## 0. View skeleton & layout

When Board is active, the workspace right of the 64px rail and below the 56px `TopBar` becomes
the board view. It is composed of these fixed layers (z-order low→high):

1. **Canvas surface** (fills the area) — dotted-grid infinite plane. §2.
2. **Left Asset panel** — docked left, collapsible, ~300px. §4.
3. **Board switcher** — top-left, floating, offset right of the asset panel. §8.
4. **Save-status chip** — top-right, floating. §9.
5. **Bottom-center tool dock** — floating pill. §3.
6. **Bottom-right zoom control** — floating. §2.
7. **Contextual style toolbar** — floats anchored to the current selection. §5.
8. **Blocking / empty / error overlays** — §9, §10.

All floating chrome uses the app's established floating-surface recipe:
`rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl`. Nothing on the board
uses a saturated background.

```
┌───────────────────────────── TopBar (h-14, unchanged) ─────────────────────────────┐
├──┬──────────────────────────────────────────────────────────────────────────────────┤
│  │ [Board ▾]  Untitled board                                   [✓ Saved]            │
│R │ ┌──────────┐                                                                      │
│a │ │ Assets   │            · · · · · · · · · · · · · · · (dotted grid) · · · ·        │
│i │ │ [Assets  │                                                                      │
│l │ │ |Favs]   │                 ┌ EXT. COSMIC VOID ─────────┐                        │
│  │ │ search   │                 │  [img] [img] [img]        │                        │
│  │ │ ▢▢ ▢▢    │                 └───────────────────────────┘                        │
│  │ │ ▢▢ ▢▢    │                                                                      │
│  │ └──────────┘                                                                      │
│  │                                    ┌───── tool dock ─────┐        ┌ 100% ▾ ─ + ┐  │
│  │                                    │ ▮ ✋ │ ▤ T ▢ ▱ ∿ │ 🖼 │                     │
└──┴────────────────────────────────────┴─────────────────────┴────────┴─────────────┘
```

---

## 1. Entry point (the rail tab)

**Placement.** A third item in `Sidebar.tsx`, below the existing AI Image / AI Video mode
switches, separated by a hairline divider so it reads as a *different kind* of control (a view,
not a generation mode).

Rail after change (top→bottom):
```
[ Image ]   ← generation mode
[ Video ]   ← generation mode
────────    ← 1px divider: h-px w-6 bg-line, my-1
[ Board ]   ← view switch (Shapes icon)
```

**Why the rail, not a 4th `HistoryPanel` tab.** Acceptance §1 requires a *full-screen* editor.
The Project/Assets/Favourites tabs live inside the ~360px right panel; a board rendered there
would be neither full-screen nor able to host its own asset panel (the panel *is* that column).
The rail is the only place a top-level full-bleed view can be launched, and it matches the
mental model "switch what the whole app is doing." **If the architect instead wants a 4th tab,
that violates §1's full-screen requirement — flag before proceeding.**

**Icon & label.** lucide `Shapes`, `strokeWidth={1.9}`, `h-[19px] w-[19px]` — identical
sizing/stroke to the existing rail icons. Hover tooltip label **"Board"**, rendered with the
exact existing tooltip treatment (`left-[52px]`, `bg-ink-650`, `ring-1 ring-line`, `shadow-pop`).

**Active / inactive states (verifiable):**
- *Inactive:* `text-white/45`, `hover:text-white/90 hover:bg-white/5` — same as current rail
  items.
- *Active (board view open):* the shared active-pill treatment
  (`bg-gradient-to-br from-brand/25 to-brand/5 ring-1 ring-brand/40`) with the SAME
  `layoutId="sidebar-active"` so the highlight slides between Image/Video/Board.
- When Board is active, **neither** Image nor Video is active (the pill is on Board). Clicking
  Image or Video returns to the generation view in that mode. There must never be two active
  rail items at once.

---

## 2. Canvas surface (pan / zoom / selection)

**Background.** Dotted grid on `ink-900` (`#070708`). Dots are `rgba(255,255,255,0.06)`, ~1px,
on a base 24px lattice at 100% zoom. Grid spacing scales with zoom (dots stay ~constant screen
size across a zoom step, re-subdividing at thresholds so they never crowd or vanish). Grid is
purely decorative — no snapping implied. This matches the reference screenshot's dotted board.

**Pan.** Click-drag on empty canvas with the **Hand** tool, OR **space+drag** with any tool, OR
middle-mouse-drag, OR two-finger trackpad scroll. Momentum not required.

**Zoom.** Scroll / pinch to zoom toward the cursor. Bounds: **min 10%, max 400%**. Ctrl/Cmd+scroll
also zooms. Zooming keeps the point under the cursor fixed.

**Zoom control (bottom-right, floating).** Style mirrors the existing `AssetZoomControl`
(`rounded-lg border border-line bg-ink-800 p-1`), scaled up:
- `[ − ]  100%▾  [ + ]` where **100%** is a `Dropdown` trigger (reuse `Dropdown.tsx`).
- Dropdown menu items (reuse `MenuItem`): **Zoom in** (⌘+), **Zoom out** (⌘−),
  **Zoom to fit** (⇧1), **Zoom to selection** (⇧2, disabled when nothing selected),
  **Zoom to 100%** (⌘0). Shortcuts shown right-aligned in muted `text-white/40`.
- The `100%` label is the single source of truth for current zoom, updates live while zooming.

**Cursor states (per active tool / context — each must be visibly distinct):**
| Context | Cursor |
| --- | --- |
| Select tool over empty canvas | default arrow |
| Select tool over a node body | `move` (4-way) |
| Hand tool / space held | `grab`; `grabbing` while dragging |
| Over a resize handle | directional (`nwse-resize` / `nesw-resize` / `ew-resize` / `ns-resize`) |
| A shape/text/sticky/frame tool armed | `crosshair` |
| Connector tool armed, or over a node edge-handle | `crosshair` |
| Over an editable text field in edit mode | `text` |

**Selection.**
- *Click* a node → selects it. *Shift-click* → add/remove from selection.
- *Click empty canvas + drag* (Select tool) → **marquee**: a rectangle
  `ring-1 ring-brand/60` fill `bg-brand/10` (translucent white). Nodes intersecting the marquee
  on release become selected.
- *Select-all* (⌘A) selects all nodes on the board.
- *Escape* clears selection (and cancels an armed tool back to Select).

**Selected-node & multi-select bounding box.**
- Single selected node: `ring-2 ring-brand` outline hugging the node (reuse the exact
  `ring-2 ring-brand` used by selected `MediaCard`).
- Multi-select: one `ring-1 ring-brand` box around the union bounds.
- **Resize handles:** 8 small squares (corners + edge midpoints), `~9px`,
  white fill, `ring-1 ring-ink-900` so they read on any node color. Edge-midpoint handles
  only for axis-resize; corner handles for proportional. Handles hide while dragging.
- **Image nodes keep aspect by default**; holding a modifier frees the ratio (mirror the
  spec's shift/free-resize toggle). Non-image shapes free-resize; shift constrains ratio.

**Rotation:** out of scope for v1 (no rotate handle). Do not add one.

---

## 3. Toolbar (bottom-center floating dock)

**Placement & justification.** Bottom-center floating pill, matching the reference screenshot
**and** correct for a full-screen canvas: it keeps all four edges clear for content, sits in the
natural resting zone, and doesn't fight the left asset panel or the top switcher. This is the
one place the reference layout and the app's own "floating pill" habit agree.

**Container.** `rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl`,
horizontal, `p-1.5`, items are `h-9 w-9` grid-centered icon buttons. Groups separated by
`w-px h-5 bg-line` dividers.

**Tools (left→right), each with tooltip `Label (shortcut)`:**
| Group | Tool | lucide icon | Shortcut |
| --- | --- | --- | --- |
| Navigate | Select | `MousePointer2` | V |
| | Hand / pan | `Hand` | H |
| Create | Sticky note | `StickyNote` | S |
| | Text | `Type` | T |
| | Shapes ▾ (popover) | `Square` | R |
| | Frame / section | `Frame` | F |
| | Connector | `Spline` | C |
| Media | Add image | `ImagePlus` | ⇧I |

**Shapes popover** (opens above the button, reuse `Dropdown` with `side="top"`): a 5-icon row —
Rectangle `Square`, Ellipse `Circle`, Triangle `Triangle`, Diamond `Diamond`, Line/Arrow
`MoveRight`. Selecting one arms that shape and shows it as the active glyph on the Shapes button
until changed.

**Button states (verifiable):**
- *Inactive:* `text-white/55 hover:text-white hover:bg-white/[0.07]`.
- *Active (armed tool):* the raised active pill `bg-ink-600 ring-1 ring-line` with
  `layoutId="board-tool"` sliding between tools (same motion idiom as the tab pills).
- *Add image:* opens the OS file picker (accepts image types); also handles paste (⌘V of an
  image) and files dropped anywhere on the canvas.

**Placement behavior when a create-tool is armed:** click on the canvas places a default-sized
node at the click point; click-drag draws it to size. After placing, the tool reverts to Select
(single-shot), UNLESS the user locked the tool by double-clicking it (shows a small lock dot).
Text/sticky enter edit mode immediately after placement with the caret active.

---

## 4. Left panel: Shapes vs. Asset Library

**Decision (A5).** Shapes go in the bottom dock (§3). The **left docked panel is the Asset
Library** — the feature that makes this board *Lumina's*, not a generic FigJam. Rationale: there
are only 5 shapes (they fit a popover), whereas the asset library is a browse-heavy, scroll-heavy
surface that needs persistent width and reuses `MediaCard`. Two competing left panels would be
redundant; one earns the space, the other is a toolbar affordance. This is a conscious, stated
divergence from the reference's left "Shapes" panel.

**Panel.** Docked left inside the board view, `w-[300px]`, `bg-ink-850`,
`border-r border-line`, full board-height. Structure top→bottom, reusing existing pieces:
- **Header row:** a pill tab group (reuse the `TabBtn` idiom from `HistoryPanel`):
  **[Assets] [Favourites]** — the same `LayoutGrid` / `Star` icons and `layoutId` pill. (History
  = "Assets", matching current label.) A **collapse** chevron (`ChevronsLeft`) sits at the row's
  right edge.
- **Search:** the existing rounded search input ("Prompt keywords"), identical styling.
- **Grid:** reuse the `MediaCard`/asset grid render with a **smaller default card width** (~120px,
  two columns) suited to the narrow panel. Infinite-scroll sentinel and `SkeletonGrid` reused.
  Favourites tab reuses the Images/Videos sectioning.

**Collapsed state.** Panel collapses to a `w-11` rail showing just the `Assets`/`Favourites`
icons stacked vertically, or fully off with a single floating re-open button (`ChevronsRight` in
a `bg-ink-750/95` pill) pinned top-left. Collapse state persists per session (localStorage,
matching the app's existing UI-persistence approach).

**Placing an asset — drag (primary):** native HTML5 DnD (the app's only DnD pattern).
- Drag source = a thumbnail; on `dragStart` set `dataTransfer.setData("text/assetId", item.id)`
  and use the thumbnail as the drag image. Thumbnail shows `cursor: grab` on hover with tooltip
  **"Drag onto the board · or click to place"**.
- Canvas is the drop target: `onDragOver` `preventDefault()` and show a faint insertion ghost
  (a `320px`-long-edge dashed placeholder following the pointer). `onDrop` reads `assetId`,
  converts pointer screen-coords → canvas-coords (accounting for pan/zoom), and creates an image
  node whose long edge = **320px** at 100% zoom, sourced from the existing `item.url`
  (`/api/media/...`, no new signing). The new node is auto-selected.
- If the drop lands inside a frame, the node is parented to that frame (frame border highlights
  during hover-drop — see §6).

**Placing an asset — click (required fallback):** a plain click on a thumbnail (no drag)
creates the same image node **centered in the current viewport** and auto-selects it. If that
center is inside a frame, it parents to that frame. A brief pop-in (the app's
`floatUp`/spring scale-in) confirms placement.

**Empty asset panel:** reuse `EmptyHistory` / `EmptyFavorites` copy and icon-in-`rounded-2xl`
treatment verbatim.

---

## 5. Node styling — contextual floating toolbar

**Decision (A4).** When exactly one node (or a homogeneous multi-selection) is selected, a
**floating style toolbar** appears anchored just **above** the selection bounding box
(FigJam convention), horizontally centered on it, ~8px gap. Same floating recipe
(`rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl`, `p-1`,
`h-8` controls). It repositions live with the selection and **hides while dragging/resizing/
panning**, reappearing on release. If the selection is near the top edge, it flips below.

**Controls shown depend on node type (only relevant controls appear):**
| Control | Applies to | UI |
| --- | --- | --- |
| **Fill** | shapes, sticky, frame | swatch button → `Dropdown` color grid |
| **Stroke color** | shapes, connector | swatch button → color grid |
| **Stroke width** | shapes, connector | small stepper / segmented S·M·L |
| **Corner radius** | rectangle only | segmented sharp / rounded |
| **Opacity** | all | slider `0–100%` styled like the existing `accent-white` range |
| **Text color** | text, sticky | swatch → color grid |
| **Font size** | text, sticky | numeric stepper (e.g. 12–96) |
| **Text align** | text, sticky | segmented left/center/right (`AlignLeft/Center/Right`) |
| **Bold** | text, sticky | toggle (`Bold`) |
| **Arrowheads** | connector | segmented none / →end / ↔both |
| **Frame label** | frame | inline text field (also editable by double-click on label) |
| **Layer order** | all | `Bring to front` / `Send to back` (overflow `MoreHorizontal` menu) |
| **Duplicate / Delete** | all | in the overflow menu; also ⌘D / Delete |

**Color grid.** A fixed monochrome-plus-FigJam-ish palette (≈12 swatches: transparent, whites/
greys, then muted yellow/green/blue/pink/orange/purple/red for stickies & fills) rendered as a
`Dropdown` grid, each swatch a `role="button"` with an `aria-label` naming the color, current
selection marked with a `Check`. A "custom" hex input row at the bottom. This is the ONLY place
saturated color enters the UI, and it comes from user choice.

No fixed right-hand inspector panel is added. Multi-type selections show only the universal
controls (opacity, layer order, duplicate/delete).

---

## 6. Frames / sections

Frames are labeled rectangular containers that read clearly as regions on the dark grid,
matching the reference's "EXT. COSMIC VOID — BEFORE TIME" boxes.

**Visual treatment (verifiable):**
- **Border:** `1px` `lineStrong` solid when it contains children; `1px dashed line` when empty
  (signals "drop things here").
- **Background tint:** a very faint `rgba(255,255,255,0.02)` fill so the frame reads as a
  distinct plane above the `ink-900` grid without looking like a solid card. User may change the
  fill via the style toolbar (§5); default is the faint tint.
- **Label:** sits at the frame's **top-left, just above the top border**, as plain editable
  text, `text-sm font-medium text-white/70`, no chip background (matches the reference's floating
  scene-slug labels). Selecting the frame shows the label with a subtle underline-on-focus when
  editing (double-click to edit). Long labels truncate with ellipsis to the frame width; they do
  **not** wrap or push layout.
- **Default size** on placement: a comfortably large rectangle (e.g. 640×400 at 100%).

**Containment behavior:**
- Dragging a node so its center enters the frame parents it; the frame border highlights
  `ring-1 ring-brand/50` during the hover-drop.
- Moving the frame moves all children together (they keep relative positions).
- Resizing the frame does **not** rescale children (v1: no auto-layout — that's a non-goal); it
  only changes the container bounds.
- Deleting a frame prompts: delete frame only (children released in place) vs. delete frame +
  contents — offered as two buttons in the confirm (see §8 confirm pattern). Default action is
  the safer "frame only."

---

## 7. Connectors

**Drawing (two equivalent paths):**
1. **Edge-handle drag (primary):** hovering a node (Select tool) reveals 4 small circular
   **connection handles** at the N/E/S/W edge midpoints (`~8px`, white, `ring-1 ring-ink-900`,
   fade in on hover). Drag from a handle → a live curved connector rubber-bands from that anchor
   to the cursor → hovering a valid target node highlights it `ring-2 ring-brand/60` → release
   on the target to attach. Releasing on empty canvas discards the connector (no floating
   endpoints in v1 — connectors always attach on both ends).
2. **Connector tool (C):** arm the tool, click a source node then a target node.

**Visual style.** **Curved (bezier)** by default — matching the brace-like arcs in the reference
screenshot. Stroke `2px`, `rgba(255,255,255,0.7)`; arrowhead is a filled triangle at the target
end by default (toggle none/→/↔ in the style toolbar). Selected connector shows its two endpoint
dots and a `ring`/glow on the path.

**Live attachment (verifiable).** Each endpoint dot renders sitting on the target node's edge;
when either node moves or resizes, the connector re-routes so its endpoints stay on the nearest
sensible edge points — never detaching, never leaving a dangling end. Deleting a node deletes
connectors attached to it.

---

## 8. Board management (create / rename / switch / delete)

**Board switcher (top-left, floating).** Offset to the right of the asset panel so it never
overlaps it. A `Dropdown` trigger styled like the existing project/account triggers:
`rounded-full border border-line bg-ink-700 pl-3 pr-2 py-1.5`, showing the current board name +
`ChevronDown`. Analogous to how projects are switched elsewhere.

**Dropdown menu (reuse `MenuItem`):**
- List of boards in the current project, active one marked with `Check`; each row has a
  hover `MoreHorizontal` → **Rename** / **Delete**.
- Divider, then **`+ New board`** (lucide `Plus`) — creates "Untitled board", switches to it,
  and drops the name into inline-rename immediately.
- If the current project has no boards, the switcher shows "Untitled board" for the first,
  auto-created board.

**Rename.** Inline: click the board name in the switcher trigger (or Rename in the row menu) →
it becomes a text input in place; Enter commits, Escape cancels. Empty names reject (revert to
previous). Names truncate with ellipsis in the trigger.

**Switch.** Selecting a board flushes the current board's pending autosave first (§9), then loads
the target (loading state per §9).

**Delete (destructive → confirmation required, per acceptance §10).** Row menu → Delete opens a
small **confirm dialog** (centered, `rounded-2xl border border-line bg-ink-750 shadow-pop`,
backdrop `bg-black/50`): title "Delete this board?", body naming the board + "This can't be
undone.", buttons **Cancel** (ghost) and **Delete** (`bg-red-500/80 text-white hover:bg-red-500`
— the app's one destructive-red usage, mirroring the `MediaCard` delete hover). Focus starts on
Cancel; Escape = Cancel. Note: the app uses `alert()`/`confirm()` in places today — this feature
must use a styled dialog for the delete gate, not a native `confirm()`.

---

## 9. States: empty / loading / error / autosave

**First-time empty board.** Dotted-grid canvas with a centered, non-blocking hint using the
existing empty-state recipe: icon (`Shapes`) in `h-14 w-14 rounded-2xl bg-ink-700 ring-1
ring-line`, then `text-sm text-white/55` "This board is empty." + subtext "Pick a tool below, or
drag an asset from the left to start your storyboard." It sits above the grid and disappears the
moment the first node exists. All tools remain enabled.

**Board loading.** While fetching board JSON: the tool dock, zoom control, and switcher render
but are **disabled/dimmed** (`opacity-50 pointer-events-none`), and the canvas shows a centered
`Loader2` spinner (`text-brand/80`) with "Loading board…". The left asset panel loads
independently and shows its own `SkeletonGrid`.

**Load error.** If the board JSON fails to load: centered error state — `AlertCircle`
(`text-red-400/90`) + "Couldn't load this board." + a **Retry** button (`bg-brand/20 text-brand`).
The rest of the app stays usable (user can switch boards or leave via the rail).

**Autosave status chip (top-right, floating) — must never silently lose work.** A small pill
reflecting save state:
| State | Appearance |
| --- | --- |
| Idle / saved | `Check` + "Saved" in `text-white/45` (quiet). |
| Debouncing / saving | `Loader2` spin + "Saving…" `text-white/60`. |
| **Save failed** | **Prominent, persistent** amber pill: `bg-amber-400/15 ring-1 ring-amber-400/40 text-amber-200`, `AlertTriangle` + "Couldn't save — retrying" + a **Retry** button. Stays visible until a save succeeds. |

On save failure the app must also warn on navigation/reload (`beforeunload`) and block a
silent board-switch (surface the failure first). The failed state is intentionally the loudest
chrome on the board because losing storyboard work is the worst outcome.

---

## 10. Responsive / desktop-only scope

**Assumption A1.** v1 is desktop pointer + keyboard, **min usable width 1024px**.

- The rail entry point is already `hidden sm:flex`, so on phones the Board tab isn't offered.
- If the board is open and the viewport drops below **1024px**, or the primary pointer is
  coarse / hover is unavailable, show a **full-cover blocking overlay** (`bg-ink-900/95`,
  centered): icon (`Monitor`) + "Canvas Board needs a larger screen." + "Open Vivi on a desktop
  (1024px or wider) to use the board." No partial/broken canvas is ever shown below the
  threshold. The board's data is untouched; resizing back above 1024px restores the editor.
- Touch gestures are not designed for v1 (stated non-goal); the overlay is the honest fallback
  rather than a half-working touch canvas.

---

## 11. Accessibility

**Keyboard path (focus order):** rail (Image → Video → Board) → board switcher → save-status chip
→ left panel (collapse toggle → Assets/Favourites tabs → search → thumbnails) → canvas → bottom
tool dock (Select → … → Add image) → zoom control. All floating controls are reachable by Tab;
`Escape` closes any open popover/dialog and returns focus to its trigger (the `Dropdown` already
does this).

**Canvas keyboard operability (so the feature isn't pointer-only):**
- Canvas container is focusable (`tabindex=0`, `role="application"`, `aria-label="Board canvas"`).
- With a create-tool armed, **Enter** places a default node at viewport center (the click-to-
  place parity path), so nodes can be created without a pointer.
- Selected node(s): **arrow keys** nudge 1px (⇧ = 10px), **Delete/Backspace** removes,
  **⌘D** duplicates, **⌘Z / ⌘⇧Z** undo/redo, **⌘A** select-all, **Escape** deselects, **Tab**
  (with canvas focused) cycles selection between nodes.
- Tools are selectable by their letter/number shortcuts (shown in every tooltip).

**Labels / roles:** every icon-only button (tools, zoom, collapse, connection handles as a set,
color swatches, layer-order actions) has an `aria-label` and `title`. Color swatches name the
color. The tool dock is a `role="toolbar"` with `aria-label="Board tools"`. The active tool is
conveyed with `aria-pressed`, not color alone.

**Focus & contrast:**
- Visible focus ring (`ring-2 ring-brand` / `ring-white`) on every interactive control.
- Meaningful text (board name, dialog copy, error/save messages, tool tooltips) must meet
  **≥4.5:1** on its background — i.e. use `text-white/70` or brighter for anything the user needs
  to read; `white/45` is reserved for decorative/secondary labels only.
- Selection, armed-tool, and drop-target states are conveyed by **ring/shape**, never by color
  alone (consistent with the monochrome chrome), so the board stays usable regardless of color
  perception.

---

## 12. Explicitly NOT designed (non-goals — do not add)

Vector pen/bezier authoring, boolean path ops, components/variants/instances, auto-layout,
constraints, dev-mode/code export, plugins; live multiplayer cursors/presence; on-canvas comments;
templates/stamps/emoji/voting/timers; public share links; inline video playback controls on
canvas (video assets place as static poster-frame image nodes); rotation handles; mobile/touch
input. Frame resize does not rescale children.

---

## 13. Acceptance-check quick map (spec §Acceptance → this spec)

1. Full-screen editor from a new tab → §1, §0.
2. Smooth pan/zoom, no upper canvas bound → §2.
3. Create/move/resize/restyle/delete all primitives → §2, §3, §5, §6, §7.
4. Single/multi select + group ops → §2 (selection), §5 (overflow menu).
5. Asset panel drag + click-to-place image nodes → §4.
6. Frames contain & move children → §6.
7. Connectors attach & stay attached → §7.
8. Undo/redo across mutations → §11 (shortcuts), surfaced app-wide.
9. Persistence restores nodes/positions/z-order/viewport → save chip §9 (UI side of it).
10. Multiple boards: create/rename/switch/delete-with-confirm → §8.
11. Build/tests → engineering, not UI-visible.
