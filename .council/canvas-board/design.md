# Design: Canvas Board (FigJam-style whiteboard tab)

Status: ready for build. Scope bound by `spec.md` + `decisions.md` (D1–D4) + `recon.md`.

---

## Summary

Add a full-screen infinite-canvas whiteboard as a **new top-level view** (not a right-panel tab), toggled from a new icon in `Sidebar.tsx`. The canvas is a **custom DOM/SVG scene graph** — React nodes positioned by a single CSS transform on a world layer — not a new whiteboard SDK. Board documents persist to a new `canvas_boards` Postgres table with the full graph in a **`jsonb data` column** (matching the existing `generations.referenceImages` / `assets.images` jsonb convention), read/written through a REST-ish `GET/PUT /api/canvas-boards/[id]` for the blob plus an op-switched flat `POST /api/canvas-boards` for metadata (create/rename/delete/list). All interactive/graph state lives in a **separate `canvas-store.ts` Zustand store** (created for the active board), so drag-tick and keystroke updates never re-render the feed/panels driven by the global `store.ts`. Autosave is a 1500 ms debounced `PUT`, force-flushed on board switch, view switch, unmount, and page hide.

Why this beats the main alternative (tldraw): tldraw would cover shapes/connectors/undo/zoom/selection out of the box, but (a) current tldraw SDK versions render a "made with tldraw" watermark that requires a **paid commercial license** to remove — unacceptable for an internal commercial product without sign-off; (b) it owns its own snapshot/persistence format and store, fighting our jsonb-per-board + our-own-node-model requirement (D3) and our native-HTML5-DnD asset drag-in (D2); (c) it is a large dependency in an app that is deliberately plain Tailwind/DOM with zero canvas libs. The trickiest correctness points (connector attachment, frame membership) are small pure functions we want to own and unit-test anyway (AC #11). Custom-build keeps full control at the cost of writing selection/resize/marquee plumbing ourselves — a bounded, well-understood amount of code for the v1 primitive set.

---

## The 6 open decisions (decision + trade-off)

### D-Render — Custom DOM/SVG scene graph (NOT tldraw / NOT `<canvas>` raster)

**Decision.** Nodes are absolutely-positioned React elements inside a single "world" `<div>` that carries one CSS transform (`translate(vx,vy) scale(z)`); connectors and marquee render in an overlaid full-size `<svg>` in the same world space. No new dependency.

**Trade-off.** tldraw/reactflow would eliminate most of the selection/resize/marquee/undo code, but: watermark-licensing (above), loss of control over our jsonb node model + media-proxy image nodes + native-DnD asset drop, and a heavy dep in a lib-free app. `<canvas>`/WebGL raster would give best perf at high node counts but throws away DOM ergonomics (text editing, `<img>` from `/api/media`, accessibility, Tailwind styling) that the rest of the app relies on. DOM/SVG is the idiomatic fit and is performant to low-thousands of nodes; if a board ever exceeds that, viewport culling (only render nodes intersecting the visible world rect) is a localized later optimization, not an architecture change. Chosen: DOM/SVG.

### D-Persist — Postgres table with `jsonb data` column (NOT S3 pointer)

**Decision.** New `canvas_boards` table; the whole graph (nodes + connectors + viewport) lives in `data jsonb`. Timestamps `bigint` ms (`Date.now()`); **app-supplied `crypto.randomUUID()`** id (client needs the id immediately to route autosave `PUT`s and switch boards optimistically). Image nodes store only `/api/media/...` URL strings, never embedded base64 — so the blob stays small (a few hundred KB even for large boards).

**Trade-off.** S3-pointer indirection (spec's alternative) matches the "media always downloaded/re-stored" convention but adds a fetch hop, a signing/proxy path, and lifecycle cleanup for a payload that is small structured JSON, not media bytes. Recon explicitly confirms jsonb is the established pattern for exactly this shape and recommends against S3 indirection. App-supplied UUID over DB-generated: `projects`/`folders` use DB-generated, but boards (like `generations`/`assets`) benefit from a client-known id at create time for optimistic UI + autosave routing.

### D-API — REST-ish `[id]` for the blob + flat op-switch `POST` for metadata

**Decision.**
- `GET /api/canvas-boards?projectId=…` → list of board **metadata** (no `data` blob; keeps the switcher light).
- `POST /api/canvas-boards` → op-switched (`createBoard` | `renameBoard` | `deleteBoard`), returns the updated metadata list — mirrors `api/projects/route.ts` exactly for the list-mutation operations.
- `GET /api/canvas-boards/[id]` → one board **including** `data`.
- `PUT /api/canvas-boards/[id]` → autosave the `data` blob.

**Trade-off.** Jamming board-blob save/load through the op-switch (as projects do) is wrong here: projects always re-read and return the *full list* after every mutation (recon flags this), which for boards would mean shipping every board's full graph on every keystroke-debounced save. A board is a single large document read/written per-id — the textbook case for a REST `[id]` resource. Metadata ops stay on the op-switch because they *are* list mutations and the convention is worth keeping there.

### D-Autosave — 1500 ms debounce, force-flush on lifecycle edges, retry-on-failure

**Decision.** Every mutating canvas-store action sets `saveStatus:"dirty"`. A trailing 1500 ms debounce fires `flushSave()` → `PUT`. `flushSave()` is also called **synchronously** on: board switch (before loading the next), view switch away from canvas, `CanvasView` unmount, and `visibilitychange → hidden` / `beforeunload` (using `fetch(..., { keepalive: true })` so the request survives page teardown). On `PUT` failure, `saveStatus:"error"`, the board stays `dirty`, and the next debounce tick retries (bounded backoff, cap 15 s); the toolbar shows Saving/Saved/"Save failed — retrying". A monotonic `updatedAt` (server-assigned, echoed back) is stored client-side; single-user v1 is last-write-wins, no conflict UI.

**Trade-off.** 1500 ms (spec said "~2s") balances "never lose more than a few seconds" against `PUT` chattiness during rapid edits. `keepalive` fetch on unload is best-effort (bounded to ~64 KB, which our small blob respects); a true guaranteed-delivery queue is out of scope for single-user v1.

### D-Store — Separate `canvas-store.ts` (NOT the global `store.ts`)

**Decision.** A dedicated Zustand store holds the active board's `present` graph, undo/redo stacks, selection, viewport, tool, and save status. The global `store.ts` gets only two tiny additions: `view: "studio" | "canvas"` and `setView`. The asset panel reads existing `items` from the global store (no duplication).

**Trade-off.** One global store is simpler to wire, but every pointer-move during a drag (and every keystroke in a sticky) would notify all global subscribers — `ConversationPanel`, `HistoryPanel`, `MediaCard`s — causing whole-app churn. A scoped store confines high-frequency updates to canvas subscribers. Cost: a second store to reason about, and a deliberate `view` flag bridging them. Worth it.

### D-Entry — New top-level view replacing the studio layout (NOT a 4th right-panel tab)

**Decision.** A new icon in `Sidebar.tsx`'s rail ("Board", lucide `LayoutDashboard`) sets `view:"canvas"`. `page.tsx` conditionally renders `<CanvasView/>` full-screen in place of `main` + right `section` (TopBar + Sidebar persist). The existing image/video mode buttons set `view:"studio"` (+ their mode).

**Trade-off.** A 4th tab inside `HistoryPanel` would reuse the panel container but the panel is collapsible and clamped to `~42vw` — structurally incompatible with the spec's "full-screen infinite canvas editor" (AC #1). A genuine top-level view is the honest fit and keeps the canvas isolated from feed layout. Cost: one conditional in `page.tsx` and a Sidebar that must become view-aware, not just mode-aware.

---

## File plan

### New — pure logic (framework-free, unit-testable; no `"use client"`)
- `src/lib/canvas/types.ts` — `CanvasState`, `CanvasNode` union, `Connector`, `Endpoint`, `Viewport`, `CanvasBoardMeta`, `CanvasBoard`, tool/anchor enums. Shared by client, store, db, and API.
- `src/lib/canvas/geometry.ts` — pure geometry: coord transforms, bounds, hit-testing, move/resize, frame membership + frame-move propagation, connector endpoint resolution + path.
- `src/lib/canvas/zorder.ts` — pure array-reorder helpers (front/back/forward/backward).
- `src/lib/canvas/history.ts` — pure undo/redo stack reducer over `CanvasState` snapshots.
- `src/lib/canvas/serialization.ts` — `emptyCanvasState()`, `validateCanvasState()` (defensive load/migration + defaults), `CANVAS_STATE_VERSION`.

### New — state / data / API
- `src/lib/canvas-store.ts` — the scoped Zustand store (board working state + actions + autosave lifecycle).
- `src/lib/canvas-db.ts` — Drizzle data access for `canvas_boards`.
- `src/app/api/canvas-boards/route.ts` — `GET` list (by project) + op-switched `POST` (create/rename/delete).
- `src/app/api/canvas-boards/[id]/route.ts` — `GET` one board (with data) + `PUT` save data.
- `src/app/api/canvas-boards/[id]/upload/route.ts` — `POST` a pasted/uploaded image → `/api/media` URL (direct upload/paste path; see Out-of-scope note on trimming).

### New — components (`src/components/canvas/`)
- `CanvasView.tsx` — top-level container: board header + `BoardSwitcher`, `CanvasToolbar`, `CanvasSurface`, `CanvasAssetPanel`; owns board load/reset, autosave lifecycle listeners, and document-level keyboard shortcuts.
- `CanvasSurface.tsx` — pan/zoom viewport, world layer, pointer handling (pan, marquee, node drag/resize), and the native-DnD drop target for asset placement.
- `CanvasToolbar.tsx` — tool palette, zoom controls + %/zoom-to-fit, undo/redo, z-order actions, save-status indicator, image-upload button.
- `StyleInspector.tsx` — floating panel to edit fill/stroke/strokeWidth/opacity/cornerRadius/font/color/frame-label for the current selection.
- `BoardSwitcher.tsx` — board dropdown (per project) + new/rename/delete (delete confirmed).
- `ConnectorLayer.tsx` — the overlaid `<svg>` rendering all connectors + marquee.
- `nodes/NodeView.tsx` — per-node dispatcher (chrome: position, selection ring, resize handles).
- `nodes/ShapeNode.tsx` — rect/ellipse/triangle/diamond (SVG).
- `nodes/TextNode.tsx` — text box (contentEditable on edit).
- `nodes/StickyNode.tsx` — sticky note.
- `nodes/FrameNode.tsx` — labeled section container.
- `nodes/ImageNode.tsx` — `<img>`/poster from `/api/media`.

### Modify (only these)
- `src/lib/schema.ts` — add the `canvasBoards` table (picked up by `npm run db:push`).
- `src/lib/save-media.ts` — add `saveCanvasAsset(dataUrl)` wrapper (keys under `canvas/…`).
- `src/lib/store.ts` — add `view: "studio"|"canvas"` + `setView`; nothing else.
- `src/components/Sidebar.tsx` — add the Board rail button; make active-state view-aware.
- `src/app/page.tsx` — conditionally render `<CanvasView/>` full-screen when `view === "canvas"`.

Nothing outside this list is to be touched.

### New — tests (`node:test`, per existing convention)
- `src/lib/canvas/geometry.test.ts`, `zorder.test.ts`, `history.test.ts`, `serialization.test.ts`.

---

## Data model (the jsonb `data` shape)

```ts
// src/lib/canvas/types.ts
export const CANVAS_STATE_VERSION = 1;

export interface Viewport { x: number; y: number; zoom: number } // world coord at screen origin; screen = (world - {x,y}) * zoom

export type NodeType =
  | "rect" | "ellipse" | "triangle" | "diamond"   // shapes
  | "text" | "sticky" | "frame" | "image";

export interface BaseNode {
  id: string;
  type: NodeType;
  x: number; y: number;            // top-left, WORLD coords (absolute — see note)
  w: number; h: number;
  opacity?: number;                // 0..1, default 1
  parentId?: string | null;        // id of the FRAME this node belongs to (frame membership)
  groupId?: string | null;         // shared id linking a group (grouping); null = ungrouped
}

export interface ShapeNode extends BaseNode {
  type: "rect" | "ellipse" | "triangle" | "diamond";
  fill: string; stroke: string; strokeWidth: number;
  cornerRadius?: number;           // rect only
}
export interface TextNode extends BaseNode {
  type: "text";
  text: string; fontSize: number; align: "left"|"center"|"right"; color: string;
}
export interface StickyNode extends BaseNode {
  type: "sticky";
  text: string; fill: string; fontSize: number; color: string;
}
export interface FrameNode extends BaseNode {
  type: "frame";
  name: string; fill: string; stroke: string;   // children referenced via other nodes' parentId
}
export interface ImageNode extends BaseNode {
  type: "image";
  src: string;                     // an /api/media/... url (never base64)
  alt?: string; aspectLocked: boolean; naturalW?: number; naturalH?: number;
}
export type CanvasNode = ShapeNode | TextNode | StickyNode | FrameNode | ImageNode;

export type Anchor = "auto" | "top" | "right" | "bottom" | "left" | "center";
export type Endpoint =
  | { nodeId: string; anchor: Anchor }   // ATTACHED — follows the node
  | { x: number; y: number };            // FREE — fixed world point
export interface Connector {
  id: string;
  from: Endpoint; to: Endpoint;
  kind: "line" | "arrow";          // "arrow" = arrowhead on `to`
  stroke: string; strokeWidth: number; opacity?: number;
}

export interface CanvasState {
  version: number;                 // CANVAS_STATE_VERSION
  viewport: Viewport;
  nodes: CanvasNode[];             // ARRAY ORDER == Z-ORDER (index 0 = back, last = front)
  connectors: Connector[];
}

export interface CanvasBoardMeta {
  id: string; projectId: string; name: string;
  createdBy: string | null; createdAt: number; updatedAt: number;
}
export interface CanvasBoard extends CanvasBoardMeta { data: CanvasState }
```

**The two hard correctness points, made concrete:**

1. **Frames contain children (AC #6).** Membership is `node.parentId === frame.id`. Child coords are **absolute world coords** (not frame-relative). Moving a frame calls the pure `applyFrameMove(state, frameId, dx, dy)` which shifts the frame *and every descendant* (`parentId === frameId`) by the same delta — so contents move together. Membership is (re)computed on drag-end via `computeFrameMembership(node, frames)`: the frame whose bounds contain the node's center, choosing the front-most (highest index) frame; dropping a node inside a frame adopts it, dragging it out clears `parentId`. Absolute coords keep hit-testing, marquee, and connector math uniform (one coordinate space); the only cost is explicit delta propagation on frame move — which is a pure, tested function. (Rejected alternative: frame-relative child coords auto-follow but force every other computation to resolve world coords first — more pervasive complexity.)

2. **Connectors stay attached (AC #7).** An attached endpoint stores `{ nodeId, anchor }`, **never coordinates**. Connectors are resolved to pixels at render time by `resolveEndpoint(ep, nodesById)`; when a node moves, its stored position changes and the connector re-resolves automatically on the next render — no connector mutation, no stale coords. `anchor:"auto"` picks the point on the node's bounding-box perimeter nearest the other endpoint. Free-standing arrows/lines (the "arrow/line" shape from AC #3) are just connectors with two free `{x,y}` endpoints — unifying the shape-arrow and attached-connector requirements into one model. Deleting a node also drops connectors referencing its id.

---

## Interfaces

### `src/lib/canvas-db.ts`
```ts
export async function listBoards(projectId: string): Promise<CanvasBoardMeta[]>;
export async function getBoard(id: string): Promise<CanvasBoard | undefined>;
export async function createBoard(
  projectId: string, name: string, createdBy: string | null
): Promise<CanvasBoardMeta>;                         // inserts data = emptyCanvasState()
export async function renameBoard(id: string, name: string): Promise<void>;
export async function deleteBoard(id: string): Promise<void>;
export async function saveBoardData(
  id: string, data: CanvasState
): Promise<{ updatedAt: number }>;                    // sets data + updatedAt = Date.now()
```
`listBoards` selects metadata columns only (omits `data`). Ids via `crypto.randomUUID()` in `createBoard`.

### Schema addition (`src/lib/schema.ts`)
```ts
export const canvasBoards = pgTable("canvas_boards", {
  id: uuid("id").primaryKey().defaultRandom(),        // app supplies crypto.randomUUID()
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  data: jsonb("data").$type<CanvasState>().notNull(), // whole graph
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```
(Import `CanvasState` type-only from `./canvas/types`.) No `.references()` — bare uuid FK per convention; `deleteProject` in `projects-db.ts` need not change for v1 (boards are orphan-tolerant; cleanup can be a follow-up — noted in Risks).

### API — `src/app/api/canvas-boards/route.ts`
Auth: `getSession()` null-check → 401 (matching `api/projects`). Body: `await req.json().catch(() => ({}))`.
```
GET /api/canvas-boards?projectId=<uuid>
  200 { boards: CanvasBoardMeta[] }            // [] if none
  400 if projectId missing

POST /api/canvas-boards            // { op, ... }
  op "createBoard" { projectId, name }  -> 200 { boards, board }   // board = new meta
  op "renameBoard" { id, name }         -> 200 { boards }
  op "deleteBoard" { id }               -> 200 { boards }          // confirmation is client-side
  else                                  -> 400 { error }
```

### API — `src/app/api/canvas-boards/[id]/route.ts`
Next 15: `{ params }: { params: Promise<{ id: string }> }`, `const { id } = await params`.
```
GET /api/canvas-boards/[id]
  200 CanvasBoard
  404 if not found

PUT /api/canvas-boards/[id]        // { data: CanvasState }
  validates via validateCanvasState(data); on bad shape -> 400 { error }
  200 { ok: true, updatedAt: number }
```

### API — `src/app/api/canvas-boards/[id]/upload/route.ts`
```
POST /api/canvas-boards/[id]/upload   // { dataUrl: string }
  200 { url: string }                 // /api/media/... via saveCanvasAsset()
```

### `src/lib/save-media.ts` (addition)
```ts
export async function saveCanvasAsset(dataUrl: string): Promise<string>; // keys canvas/${randomUUID()}.${ext}
```

### `src/lib/store.ts` (additions only)
```ts
view: "studio" | "canvas";          // default "studio"
setView: (v: "studio" | "canvas") => void;
```

### `src/lib/canvas/geometry.ts` (pure)
```ts
worldToScreen(p, vp): {x,y};  screenToWorld(p, vp): {x,y};
nodeBounds(n): {x,y,w,h};  boundsContain(outer, innerCenter): boolean;
moveNodesBy(state, ids, dx, dy): CanvasState;          // also propagates frame children
applyFrameMove(state, frameId, dx, dy): CanvasState;
resizeNode(n, handle, dx, dy, keepAspect): CanvasNode;
computeFrameMembership(node, frames): string | null;
resolveEndpoint(ep, nodesById): {x,y};
connectorPath(c, nodesById): string;                   // SVG path 'd'
hitTest(state, worldPoint): string | null;             // top-most node id
marqueeHits(state, worldRect): string[];
```

### `src/lib/canvas/zorder.ts` (pure)
```ts
bringToFront(nodes, ids): CanvasNode[];
sendToBack(nodes, ids): CanvasNode[];
bringForward(nodes, ids): CanvasNode[];
sendBackward(nodes, ids): CanvasNode[];
```

### `src/lib/canvas/history.ts` (pure)
```ts
interface History<T> { past: T[]; present: T; future: T[] }
commit<T>(h, next): History<T>;      // push present->past, clear future, bounded (cap 50)
undo<T>(h): History<T>;
redo<T>(h): History<T>;
```

### `src/lib/canvas/serialization.ts` (pure)
```ts
emptyCanvasState(): CanvasState;                       // version, viewport {0,0,1}, [], []
validateCanvasState(raw: unknown): CanvasState;        // coerces/defaults; throws on unrecoverable
```

### `src/lib/canvas-store.ts` — store shape
```ts
interface CanvasStore {
  boardId: string | null; boardName: string; loaded: boolean;
  history: History<CanvasState>;                       // .present is the live graph
  selection: string[];                                 // node ids
  selectedConnectorIds: string[];
  tool: "select"|"hand"|"rect"|"ellipse"|"triangle"|"diamond"|"text"|"sticky"|"frame"|"connector";
  editingTextId: string | null;
  saveStatus: "idle"|"dirty"|"saving"|"saved"|"error";

  // lifecycle
  loadBoard(id: string): Promise<void>;                // flushSave() prior board, GET, reset
  reset(): void;
  flushSave(opts?: { keepalive?: boolean }): Promise<void>;

  // viewport / tool
  setViewport(vp: Viewport): void;                     // NOT history-committed
  zoomToFit(): void; setTool(t): void;

  // graph mutations (each: commit history + markDirty)
  addNode(node: CanvasNode): void;
  addImageFromAsset(a: { url: string; aspectRatio?: string }, worldPoint?: {x,y}): void;
  updateSelectedStyle(patch: Partial<...>): void;
  moveSelectionBy(dx, dy): void;                       // gesture-end commit (coalesced)
  resizeSelected(handle, dx, dy, keepAspect): void;
  deleteSelected(): void; duplicateSelected(): void;
  group(): void; ungroup(): void;
  bringToFront()/sendToBack()/bringForward()/sendBackward(): void;
  addConnector(from: Endpoint, to: Endpoint, kind): void;
  copy(): void; paste(): void;                         // clipboard = node JSON (spec)
  undo(): void; redo(): void;
  setSelection(ids)/toggleSelect(id)/selectAll()/clearSelection(): void;
}
```
Continuous gestures (drag/resize/marquee/pan) update `history.present` transiently and **commit once on pointer-up** so undo steps map to whole gestures (AC #8), not per-frame.

### Asset panel contract — `CanvasAssetPanel.tsx`
Reuses the global store; **no new fetch endpoints** (D2). Props: none required (reads store). Behavior:
- `const items = useStore(s => s.items)` — already loaded by `page.tsx`'s `loadHistory()`. Tabs Assets/Favourites filter exactly like `HistoryPanel` (`item.isFavorite`, `item.kind`).
- Each thumbnail renders `item.url` (image) or `item.poster ?? item.url` (video → static poster per spec) directly — recon confirms `item.url` is already `/api/media/...`.
- Drag: `draggable`, `onDragStart` sets `dataTransfer.setData("application/x-lumina-asset", JSON.stringify({ url, aspectRatio, kind }))`. `CanvasSurface` `onDrop` reads it, converts drop point via `screenToWorld`, calls `addImageFromAsset`.
- Click: calls `addImageFromAsset(asset)` with no point → placed centered in current viewport.
- Default size: 320 px long edge, other edge from `aspectRatio` (fallback 1:1).

---

## Data flow

**Open board.** Sidebar Board icon → `setView("canvas")` → `page.tsx` renders `CanvasView` → on mount, `BoardSwitcher` calls `GET /api/canvas-boards?projectId=activeProjectId`; if the project has no boards it `POST createBoard "Untitled board"`. `loadBoard(id)` → `GET /api/canvas-boards/[id]` → `validateCanvasState(data)` → store `history.present`, `loaded:true`. `activeProjectId` comes from the global store (already guaranteed by `ensureDefaultProject`).

**Edit → autosave.** A mutation action commits history + `saveStatus:"dirty"` → debounce(1500ms) → `flushSave()` sets `"saving"`, `PUT /api/canvas-boards/[id] {data: history.present}` → on 200, store `updatedAt`, `"saved"`; on failure `"error"` + remains dirty → retried next tick. Force-flush (no debounce) on board switch, `setView` away, unmount, and `visibilitychange:hidden`/`beforeunload` (keepalive).

**Place asset.** Drag from `CanvasAssetPanel` → drop on `CanvasSurface` → `addImageFromAsset` creates an `ImageNode` (src = `item.url`) appended to `nodes` (front) → marks dirty. (Direct upload/paste: image `dataUrl` → `POST …/[id]/upload` → returns `/api/media` url → same node creation. On upload failure: toast + no node created.)

**Reload (AC #9).** Refresh → `page.tsx` boots studio; user re-opens Board → `GET /api/canvas-boards/[id]` returns persisted `data` → `validateCanvasState` restores nodes/positions/styles/z-order (array order)/viewport verbatim.

**Error paths.** 401 anywhere → existing `apiFetch` redirect to `/login` (reuse it in the canvas store). `GET [id]` 404 → toast + drop back to switcher. Bad `PUT` body 400 → treated as a save failure (dirty, retry). Corrupt stored blob → `validateCanvasState` coerces/defaults rather than crashing (so one bad board can't white-screen the app).

---

## How each acceptance criterion is satisfied

1. **New full-screen tab** — Sidebar Board icon → `view:"canvas"` → `page.tsx` swaps `main`+right panel for `CanvasView` (D-Entry).
2. **Pan/zoom, unbounded** — single CSS transform on the world layer; `Viewport{x,y,zoom}`, `screenToWorld`/`worldToScreen`; space/drag + scroll-zoom + zoom-to-fit + % readout; only zoom is clamped (min/max), pan is unbounded (world coords are unbounded floats).
3. **Create/move/resize/restyle/delete all primitives** — node union (rect/ellipse/triangle/diamond/text/sticky/frame/image) + connectors (line/arrow); `StyleInspector` edits fill/stroke/opacity/cornerRadius; `moveSelectionBy`/`resizeSelected`/`deleteSelected`.
4. **Selection + group ops** — click/shift-click/`marqueeHits` selection; `moveSelectionBy`, `deleteSelected`, `duplicateSelected`, `group`/`ungroup` (shared `groupId`).
5. **Asset library places real generations** — `CanvasAssetPanel` reuses global `items`; drag→`onDrop`→`addImageFromAsset`, or click→centered; src = existing `item.url` (`/api/media`), zero new fetch/signing (D2).
6. **Frames contain + move children** — `parentId` membership + `applyFrameMove` delta propagation; `computeFrameMembership` on drag-end (Data model §1).
7. **Connectors stay attached** — `{nodeId, anchor}` endpoints resolved at render via `resolveEndpoint`; node move needs no connector edit (Data model §2).
8. **Undo/redo** — `history.ts` snapshot stack; every graph mutation commits; gestures coalesce to one step; Cmd+Z / Cmd+Shift+Z in `CanvasView` key handler.
9. **Persistence round-trips exactly** — full graph incl. z-order (array order) + viewport in `jsonb data`; `PUT` save / `GET` load; `validateCanvasState` restores faithfully (D-Persist).
10. **Multiple boards per project** — `canvas_boards.projectId`; `BoardSwitcher` list/create/rename/switch/delete via `POST` op-switch; delete confirmed client-side.
11. **`npm run build` + unit tests pass** — pure `src/lib/canvas/*` fully typed and covered by `node:test` files (Test seams).

---

## Test seams

Unit-testable (pure, no DOM) — the reason logic lives in `src/lib/canvas/`:
- **geometry**: `worldToScreen`/`screenToWorld` round-trip; `resolveEndpoint` for each anchor incl. `"auto"`; `connectorPath` stability; `computeFrameMembership` (center-in-frame, front-most wins, none); `applyFrameMove` moves frame + all children by exact delta and nothing else; `resizeNode` keepAspect math; `marqueeHits`.
- **zorder**: front/back/forward/backward permutations, multi-select, idempotence at boundaries.
- **history**: `commit` clears future + bounds depth; `undo`/`redo` symmetry; no-op at stack ends.
- **serialization**: `emptyCanvasState` shape; `validateCanvasState` round-trips a full graph (serialize→jsonb→deserialize equality) and coerces missing/garbage fields to defaults without throwing.

Integration/UI-only (not unit-tested here): pointer gesture wiring, native-DnD drop, contentEditable text, CSS-transform rendering, the debounce timer + lifecycle-flush effects, and the API routes end-to-end (those are exercised by `npm run build` typecheck + manual/QA).

---

## Trade-offs (beyond the 6 decisions)

- **Z-order = array index** (not an explicit `z` field): simpler reorder + serialization, trivially testable; cost is O(n) splices on reorder — negligible at v1 scale.
- **Absolute child coords** over frame-relative: uniform coordinate space for hit-testing/connectors at the cost of explicit frame-move propagation (a tested pure fn).
- **Snapshot undo** over command/inverse-op log: far less code and trivially correct; cost is memory per step — bounded to 50 and cheap because the blob is small structured JSON (no media bytes).
- **Groups as a shared `groupId`**, not a container node: no extra node type, no nesting bookkeeping; cost is that groups aren't independently stylable/labelable (not required by spec).
- **Video assets as static poster image nodes**: matches spec Non-goals (no in-canvas playback).

## Out of scope (deliberately not built)

- Everything in spec Non-goals: multiplayer/CRDT/presence (D4), Figma design-tool primitives (pen/bezier, booleans, components/variants, auto-layout, constraints, dev-mode/code export, plugins), on-canvas comments, public share links, templates/stamps/timers, in-canvas video playback, mobile/touch input.
- Per-board ACL: any authenticated user with project access can edit (spec Assumptions).
- Cascade cleanup of boards on project delete: v1 leaves boards orphan-tolerant (see Risks); no change to `projects-db.ts`.
- Direct upload/paste (`upload` route + `saveCanvasAsset`) is included but is **not an acceptance criterion** — it is the first thing to cut if scope must shrink; the library-drag path (AC #5) is the load-bearing one.

## Risks

- **Perf at high node counts** — DOM/SVG re-render cost grows with node count. Mitigation: scoped store (only canvas re-renders), gesture-coalesced commits, `React.memo` per node keyed by id; viewport culling is a localized later add if needed.
- **Autosave data loss on crash** — Mitigation: short debounce + keepalive flush on hide/unload + dirty-retain-on-failure with retry; single-user last-write-wins avoids conflict complexity. Residual: a hard crash mid-gesture can lose < 1.5 s (accepted per spec).
- **Orphan boards after project delete** — v1 doesn't cascade. Mitigation: `listBoards` filters by existing `projectId`, so orphans are simply unreachable, not corrupting; a follow-up can add `clearProjectBoards(projectId)` to `deleteProject`. Called out so it's a conscious deferral, not a silent bug.
- **`db:push` on shared DB** — new table is additive/non-destructive; safe. Note in the PR that `npm run db:push` must run before deploy.
- **Blob bloat if base64 leaks into nodes** — enforced by only ever storing `/api/media` URLs in `ImageNode.src` (upload path converts data URLs before node creation); `validateCanvasState` can additionally reject `data:`-prefixed `src` on save.

---

## Assumptions

- Tab label is **"Board"** (spec left "Board"/"Canvas" to design; "Board" reads cleaner in the rail tooltip). Icon: lucide `LayoutDashboard`.
- Boards are scoped to `activeProjectId`; since `ensureDefaultProject` guarantees a project exists, there is always a valid parent (no "no project" bucket needed).
- Autosave debounce = **1500 ms** (spec's "~2s", tightened for the "few seconds" bound).
- The tldraw watermark/commercial-license concern reflects current SDK versions and should be re-confirmed at build time; even absent it, the control/integration argument (D-Render) stands, so the build decision does not hinge on it.
