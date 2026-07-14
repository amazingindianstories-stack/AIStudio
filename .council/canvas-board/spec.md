# Spec: Canvas Board (FigJam-style whiteboard tab)

## Problem

Lumina Studio users currently generate images/videos into a linear feed with History/Favorites/Projects organization. There's no spatial way to arrange generated assets into storyboards, moodboards, or scene sequences (see reference screenshot: a FigJam board with rows of generated images grouped into labeled scene sections — "EXT. COSMIC VOID - BEFORE TIME", "EXT. MOUNTAIN TOP - DAY", etc. — connected by arrows). Users want an infinite-canvas whiteboard, native to Lumina, where they can pull assets straight from their existing library and lay them out freely, annotate, and structure a narrative/storyboard.

## Decision log pointer

Scope was narrowed via user clarification (see `.council/canvas-board/decisions.md` D1–D4). Summary of binding decisions:
- **D1**: Clone target is **FigJam** (whiteboard primitives), not the Figma design tool (no vector pen tool, no boolean path ops, no components/variants/auto-layout, no dev-mode code export). "Exact Figma functionality" was infeasible as literally stated; scope is explicitly the whiteboard product family.
- **D2**: The existing asset sidebar (History/Favorites/Projects, generation results) is embedded as a panel inside the new canvas tab; users drag or click assets onto the board, where they become movable/resizable image nodes.
- **D3**: Boards persist to the existing Postgres + S3 backend, scoped per-project, following the `projects`/`folders`/`generations` pattern already in `src/lib/schema.ts`.
- **D4**: Single-user editing for v1. No real-time multiplayer (no CRDT sync layer, no live cursors/presence). This is explicitly deferred, not built.

## Desired behavior

### Entry point
- A new left-nav tab/icon (alongside the existing Project/History/Favorites tabs) opens the canvas board view, replacing the main feed panel with a full-screen infinite canvas editor.
- Boards are scoped to a project (consistent with existing project-scoping of generations). A project can have one or more boards; user can create/rename/delete/switch boards within a project.

### Canvas primitives (FigJam parity — v1 set)
- **Infinite pan/zoom canvas**: click-drag pan (or space+drag), scroll-to-zoom / pinch-zoom, zoom-to-fit, zoom percentage indicator, min/max zoom bounds.
- **Selection tool**: click to select, shift-click to multi-select, drag-marquee select, select-all.
- **Shapes**: rectangle, ellipse, triangle, diamond, arrow/line — with fill color, stroke color/width, opacity, corner radius (rect).
- **Text**: click-to-place text box, font size, basic alignment, color.
- **Sticky notes**: colored note blocks with editable text (FigJam signature primitive).
- **Frames / sections**: labeled rectangular containers that group child nodes (matches the "EXT. MOUNTAIN TOP - DAY" labeled boxes in the reference image) — moving a frame moves its contents.
- **Connectors/arrows**: draw a line/arrow between two nodes that stays attached as nodes move (matches the curly braces/arrows linking scene groups in the reference image).
- **Image nodes**: placed from (a) the embedded asset library panel (drag or click-to-place) or (b) direct file upload/paste. Resizable, movable, keep aspect ratio by default (shift/free-resize toggle).
- **Grouping**: group/ungroup selected nodes; grouped nodes move/resize together.
- **Layer ordering**: bring to front / send to back / forward / backward.
- **Undo/redo**: standard Cmd+Z / Cmd+Shift+Z, covering all node mutations.
- **Delete/duplicate**: standard keyboard shortcuts (Delete/Backspace, Cmd+D).
- **Copy/paste**: within a board and across boards (clipboard holds node JSON).

### Asset library integration (the extra feature beyond FigJam)
- A collapsible sidebar panel inside the canvas view lists the user's existing generations (History) and Favorites, reusing existing data (`GET` endpoints already powering the main feed) — no new asset-fetching logic, just a canvas-context-friendly render of existing data.
- Dragging an asset thumbnail onto the canvas creates an image node at the drop position, sized to a sensible default (e.g. 320px on the long edge), sourced from the same `/api/media/[...path]` proxy already used elsewhere (no new storage/signing logic).
- Clicking an asset (as an alternative to drag) places it centered in the current viewport.

### Persistence
- A board is a named entity belonging to a project: `{ id, projectId, name, createdAt, updatedAt, createdBy }`.
- Board content (nodes + edges/connectors + canvas viewport state) is stored as JSON, associated with the board row. Given board JSON can grow large (many nodes with embedded image references), store it in S3 alongside other media (consistent with "media always downloaded/re-stored" convention) with a pointer column, OR as a `jsonb`-equivalent column if Drizzle/Postgres setup supports it cleanly — **architect decides based on existing schema conventions**, record the choice in `design.md`.
- Autosave on a debounce (e.g. 2s after last change) plus explicit save on tab/board switch. No manual "Save" button required for v1 (matches modern whiteboard UX), but must never lose more than a few seconds of work on crash/reload.
- Reload of a board must faithfully restore all node types, positions, z-order, and viewport.

### Non-goals (explicitly out of scope for this build)
- Real-time multiplayer (live cursors, presence, concurrent-edit sync/CRDT). Deferred — see D4.
- Figma design-tool primitives: vector pen/bezier tool, boolean path operations, components/variants/instances, auto-layout, constraints, dev-mode/code export, plugins/widgets API.
- Commenting/mentions on canvas objects.
- Board sharing/permalinks outside the existing app auth (no public share links).
- Templates library, stamps/emoji reactions, voting, timer widgets (FigJam extras beyond core whiteboard).
- Video nodes with inline playback controls on canvas — v1 places video assets as a static thumbnail/poster-frame image node (playing back video-in-canvas is a stretch goal, not required for acceptance).
- Mobile/touch-optimized input (desktop pointer + keyboard is the target for v1).

## Acceptance criteria

1. A new tab appears in the left navigation that opens a full-screen infinite canvas editor, distinct from the existing feed/History/Favorites views.
2. User can pan (drag) and zoom (scroll/pinch + zoom controls) the canvas smoothly with no functional upper bound on canvas extent.
3. User can create, move, resize, restyle (fill/stroke/opacity), and delete: rectangles, ellipses, triangles, diamonds, text boxes, sticky notes, frames/sections, and connector arrows.
4. User can select single or multiple nodes (click, shift-click, marquee) and perform group move/delete/duplicate/group-ungroup on the selection.
5. The canvas view includes an asset library panel; dragging or clicking an asset from it places an image node on the canvas sourced from the user's real generation history/favorites.
6. Frames/sections visually contain and move their child nodes together, matching the reference screenshot's grouped/labeled-box pattern.
7. Connector arrows attach to nodes/frames and stay attached (update their endpoints) as those nodes are moved.
8. Undo/redo works across at least node create/move/resize/delete/restyle operations.
9. Board state persists: creating nodes, reloading the page, and reopening the same board restores the board exactly (same nodes, positions, styles, z-order, viewport).
10. Multiple boards can exist per project; user can create a new board, rename it, switch between boards, and delete a board (with confirmation, since delete is destructive).
11. `npm run build` passes (typecheck) and any new unit tests pass.

## Assumptions (logged, not asked — defensible defaults)

- **Rendering approach**: canvas will be built as an HTML/SVG/DOM-based scene graph (React components positioned via CSS transforms) rather than a `<canvas>`-pixel-raster or WebGL renderer, consistent with the rest of the app being a standard React/Tailwind DOM app and avoiding a new heavy rendering dependency unless the architect finds a compelling reason (e.g. an existing, well-maintained open-source whiteboard engine) to use one. Architect to confirm/decide and record reasoning in `design.md`.
- **Board scoping**: boards belong to projects, not folders (folders currently organize generations only); a project with no explicit "no project" bucket today — architect to check how ungrouped generations are handled and mirror that for boards if relevant.
- **Access control**: same as existing generations — any authenticated user can create/edit boards within a project they can access (no additional per-board ACL layer); consistent with current single-tier auth (`requireUser`/`requireAdmin`).
- **Naming**: the left-nav tab is labeled "Board" (or "Canvas") rather than "Figma" — the feature is a whiteboard *inspired by* FigJam's functionality, not a Figma-branded product; avoids trademark confusion in-product. Architect/ui-designer confirm exact label during design.
