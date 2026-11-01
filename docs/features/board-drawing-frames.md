# Board drawing and frames

Freehand drawing, the eraser, smart drawing, grids, synced copies, visual notes and frame structure on
canvas boards. Every new field is optional in board format v1, so older boards load and save unchanged.
`src/lib/canvas/extras.js` and `backend/apps/canvas/extras.py` coerce the `ink`, `grid` and `synced` nodes
and the board's `notes` the same way; `backend/apps/canvas/fixtures/format_v1_drawing_frames.json` holds
the cases both test suites run. Each command is one board edit through the store, so it is one undo step,
a per-node save and a no-op on a read-only board.

## Drawing

- **Pen (P) and highlighter (Shift+P).** A stroke is one `ink` node: `pts` (flat `[x0, y0, x1, y1, ...]`
  relative to the box it was drawn in, `vw` x `vh`), `stroke`, `strokeWidth`, and `highlighter: true` with
  opacity 0.4 for the highlighter. Strokes are simplified on release to about a pixel at the current zoom,
  harder if still over 1,500 points, because dense ink eats into the board size limit. It moves, resizes,
  rotates, groups and copies like any object. A stylus varies the pen width with pressure (about 0.5x to
  1.5x); a mouse keeps the preset.
- **Presets.** The strip above the tool dock offers three colors and three thicknesses for each tool
  (`src/lib/canvas/ink.js`). The chosen presets, the eraser mode and smart drawing are personal
  preferences in `localStorage` (`src/lib/ink-prefs.js`), not board data.
- **Eraser (E).** Whole stroke removes every stroke the eraser touches; Precision cuts out only the
  touched part and splits the rest into pieces (the first keeps the stroke's id and fields). A rotated
  stroke is hit where it is drawn, and its pieces are stored upright. Connectors attached to a stroke
  that disappears go with it. A sweep is one undo step.
- **Smart drawing.** A toggle on the pen's preset strip. On release, `src/lib/canvas/smart-draw.js` reads
  the stroke: a closed outline becomes a rectangle, ellipse, triangle or diamond (a squarish rectangle
  becomes a sticky), a straight stroke a line connector, and a back-and-forth scribble erases the objects
  it crosses with their connectors. Containers (frames, swimlanes, diagrams) are never scribble-erased.
  Anything else stays ink.
- Neither the eraser nor a scribble removes locked objects, objects on a layer the person hides, or what
  the board hides (a hidden diagram layer, or everything outside the diagram in Focus mode).

## Grids

A `grid` node is a table of `rows` x `cols` (each at most 100, at most 2,500 cells). `cells` lists only
cells that hold something, as `[row, col, text, fill, color]` with trailing defaults left off (text up to
1,000 characters); `merges` lists merged ranges as `[row, col, rowSpan, colSpan]`. Cells share the box
equally, so resizing the node resizes the table. The toolbar's grid menu adds an empty grid of a chosen
size or one made from pasted CSV or TSV text (a tab anywhere means tab-separated), trimmed to the cell cap.
Once a grid is selected, a click picks a cell (drag or Shift-click for a range), a double click edits it
(Enter commits, Shift+Enter breaks the line, Escape cancels), and the controls above it add and delete rows
and columns, merge and unmerge, and set cell colors. The strip below moves it. Locked grids do not edit.

## Synced copies

A `synced` node stores `sourceBoardId`, `sourceNodeId` and the source's `name`: a view-only copy of a frame
or diagram on another board of the same project, inserted from the toolbar's synced-copy menu. Nothing of
the source is copied into the board. The copy reads the source's current content when shown and every 30
seconds while visible (`src/lib/synced-frames.js`), keeps the last good copy when a refresh fails, and
draws it scaled into its box without what the source diagram's hidden layers hide. A synced copy inside
that content is drawn as an outline, so copies never nest without end. Its badge opens the original
board. A selected frame or diagram lists the boards that hold a copy of it under Copies. The routes and
their access rule are in [board-roles.md](board-roles.md) (`backend/apps/canvas/synced.py`): each read
checks the caller's access to the source board and its hidden frames, and a source the caller can no
longer read shows as unavailable.

## Visual notes

The header's Notes button opens one formatted note for the whole board, stored as `notes: {text, marks,
refs, updatedBy, updatedAt}` (text up to 200,000 characters, marks as in rich text). It offers templates
(meeting notes, creative brief, review checklist) and up to 50 links (`refs: [{id, type, label}]`) to
selected objects; clicking a link selects the object and pans to it, and a link to a deleted object shows
as gone. Everyone who can open the board reads it; editors change it. The server stamps `updatedBy` and
`updatedAt` and ignores any stamp a client sends. Whether the panel is open and pinned is a personal
preference in `localStorage`. How `notes` travels in a patch is in
[canvas-board-sync.md](../architecture/canvas-board-sync.md).

## Frames and structure

- **Frame around selection** (Cmd/Ctrl+Alt+F, or the context menu) wraps the selection in a new frame
  with 40 units of padding, behind the first selected object. When the selection sits in one container,
  the frame nests inside it. Locked objects are not moved into it.
- **Size presets.** A selected frame's strip offers slides (16:9, 4:3), A4 and Letter paper, square, and
  desktop, tablet and phone sizes (`FRAME_PRESETS` in `src/lib/canvas/frames.js`); a preset keeps the
  top-left corner. Locked frames keep their size.
- **Nesting.** Frames nest to any depth. A dragged or nudged frame keeps its parent while that parent
  still holds its center, else joins the smallest frame, swimlane or diagram that wholly contains it.
  Moving, aligning or distributing a container moves everything inside it at any depth, except locked
  objects, which stay put with their own contents. A nested frame shows its title only on hover.
- **Duplicate with dates.** Duplicating a frame moves the dates in its title on by one day
  (`2026-03-31`, `Mar 31`, `31 Mar 2026`; without a date, a weekday name).
- **Paste into frames.** With frames selected, paste puts one copy into each, at the same offsets from
  the frame's corner as the originals had from their source frame's corner (or, outside one frame, the
  copied selection's corner). A frame that was itself copied, or holds what was, gets an ordinary paste.
- **Hide and reveal.** A co-owner or owner can hide a frame (`hidden: true`); everyone else sees an empty
  placeholder until it is revealed. The server enforces it (`backend/apps/canvas/hidden.py`); the rules for
  reads, saves, History and copies are in [board-roles.md](board-roles.md),
  [canvas-board-sync.md](../architecture/canvas-board-sync.md) and [board-history.md](board-history.md).
