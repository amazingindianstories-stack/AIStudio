# Canvas board sync

Several people can edit one board without overwriting each other. There is no realtime service: the API is
a single gunicorn worker with 8 threads and a 25 s timeout, so boards save through conditional writes,
merge per node on the client and poll for other people's saves.

## Save contract (`PUT` and `PATCH /api/canvas-boards/<id>`)

- The body carries `data` (the graph), `baseVersion` (the board version the edits started from) and
  `saveId` (a fresh client UUID for each save attempt). The write locks the board row and applies only
  when its version equals `baseVersion`. There is no unconditional write: a missing or stale
  `baseVersion`, or a missing `saveId`, gets `409 {error: "VERSION_CONFLICT", board}` with the current
  board (graph and version), and nothing is written. A malformed `baseVersion` or `saveId` gets 400.
- `PATCH` sends `patch` in place of `data`: for `nodes` and for `connectors` the whole items added or changed
  (`upsert`), the ids of the upserted items that are new (`add`) and the ids deleted (`delete`), the `viewport`, the board
  `settings` whole when they changed (null clears them), and `nodeOrder`/`connectorOrder` (every id) only
  when the order is not "kept items in their old order, then added ones in patch order"
  (`backend/apps/canvas/patch.py`, mirrored by `src/lib/canvas/patch.js`). Under the same lock and version check
  the server applies it to the stored graph and saves the result exactly as a full save, so roles, stamps,
  History, normalization and the size limit all see the resulting whole board. A patch that does not describe
  a graph (a duplicate id, an order that does not name every item once) or was built over a different one
  (`add` does not name exactly the upserted items the stored graph lacks, as when the editor still holds an
  image someone deleted while it was cropped) gets `400 {error: "INVALID_PATCH"}`.
- The editor sends a patch against the graph of the version it last synced (after a 409, the version the 409
  returned). It sends the whole graph with `PUT` when it holds no version, when a patch got 400 (the same save,
  same `saveId`, goes again as the whole graph; nothing was written), and for the rest of the open board once a
  server answers 405. On unload the keepalive request carries the whole graph when that fits the keepalive
  limit, otherwise the patch, so an edit on a large board still saves; the local draft always holds the whole
  graph.
- A save that changes nodes, connectors or the board `settings` (background, start view, layers) bumps
  `version`. A save that only changes the viewport (each person's own) keeps the version, so open boards do
  not refetch the graph.
- Changes the saver may not make (`backend/apps/canvas/locks.py`: editing or deleting an object under someone
  else's protected lock, or setting a protected lock or changing the start view below co-owner,
  `../features/board-roles.md`) are put back on the stored copy while the rest of the save is written. Such a save bumps `version` and its
  reply carries the saved graph as `board`, which the editor merges like someone else's save.
- A graph-changing save records `(board_id, save_id, version, applied_at)` in `canvas_board_saves` in the
  same transaction, unique per board and save id, with `changes`: the ids of the nodes and connectors it
  added, edited, moved or deleted (null when more than 2,000). `run_scheduler` prunes rows older than 30 days daily
  (`board_saves`, the 03:17 UTC slot); deleting a board deletes its rows. Viewport-only saves record nothing.
- In the same transaction (the board row is locked with `SELECT ... FOR UPDATE`) the server diffs the stored
  graph against the saved one per node and connector id, stamps each added or edited object with
  `createdBy`/`createdAt`/`updatedBy`/`updatedAt` and appends `board_activity` rows; stamps a client sends are
  ignored (`../features/board-history.md`). The reply carries `stamps` for the objects this save added or
  edited, which the client adopts into its graph, sync base and undo snapshots without an undo step.
- The size limit (2,097,152 UTF-16 units of the graph's JSON) counts content only: both the request check and
  the check on the normalized graph leave out the stamps, so stamping never costs a board room. A patch is
  measured only as the whole board it produces, never by its own size. A save over it
  gets 413 and nothing is written; the editor says the board is too large to save and does not retry until the
  next edit, and the pending draft keeps the unsaved edits.
- `GET /api/canvas-boards/<id>?saveId=<uuid>` adds `saveVersion`: the version that save landed at, or null.
- `GET /api/canvas-boards/<id>/version` returns `{version, updatedAt}` without reading the graph. Open boards
  poll it every 3 s, every 15 s after a minute with no input and no remote change, and not while hidden
  (`src/lib/canvas/use-board-polling.js`); the graph is fetched only when the version moved.
- `GET /api/canvas-boards/<id>/changes?since=<version>` (read role) returns `{version, updatedAt, changes}`
  with, per kind, the current items whose ids the saves after `since` recorded (`upsert`) and those ids no
  longer on the board (`delete`), the board `settings` (null when none), plus `nodeOrderHash`/`connectorOrderHash`
  (FNV-1a over the ids). It returns `{version, updatedAt, data}`, the whole graph, when `since` is ahead of the
  board or more than 200 versions behind, or a save in between recorded no ids or was pruned. A poll that saw a newer version asks it first,
  rebuilds the graph over the one it synced and checks both hashes; a mismatch (a reorder records no ids) or
  an image crop in progress reads the whole board instead, as does a server without the endpoint.

## Client merge (`src/lib/canvas/merge.js`, `src/lib/canvas-store.js`)

- A 409 or a newer polled version merges the other person's graph three-way, per node and connector id,
  against the graph this tab last synced: one-sided changes apply; when both sides changed an item the
  local unsaved edit wins. The viewport stays local. The result is saved again on the new version.
- Board settings merge per setting (background, start view) with the same rule. Layers merge per layer id: a
  layer added on either side stays, one deleted on one side goes only when the other left it unchanged, a layer
  both changed merges per field, and their order merges like the z-order. Which layers are hidden is each
  person's own and stays in the browser (`src/lib/canvas/layer-visibility.js`).
- The same merge is applied to every undo and redo snapshot, so undo only reverts this person's own steps.
- Server stamps are not edits: an item whose local copy differs from the base only in its stamps counts as
  unchanged locally and takes the remote copy, stamps included.
- A save whose answer was lost (a dropped connection or a 5xx) is settled before the next save: the client
  asks for its `saveVersion`, and if it landed its graph becomes the merge base, so its changes are not
  replayed over someone's later edit. Polling waits until it is settled.
- While a text or label edit is open, other people's saves wait: polling does not merge, and a save refused
  with a 409 stays dirty with no further save until the edit ends. When it ends, the tab saves and polls at
  once and the ordinary merge runs, so an unchanged node follows a remote delete and typed text survives one.
  Ending an edit without typing writes nothing.
- While an image is being cropped, other people's changes to that image are held back: their latest version
  (or deletion) waits in one slot, and the sync base keeps the image as it was, so no undo snapshot takes in
  the held version. Everything else merges and is adopted as usual, and this person's own edits to the image
  show and save at once. A save during the crop writes this person's version of the image if they changed it,
  otherwise the held version, so no save reverts anyone. When the crop ends (Apply, Cancel, Enter, Escape, or
  the image leaving the board) the ordinary merge applies the held version: this person's change to the image
  wins, otherwise theirs is kept. An applied crop is set after that merge, on the image's current version, so
  it keeps their change too; an image they deleted comes back with the crop.

## Large boards (`src/lib/canvas/culling.js`)

The board mounts only the nodes and connectors that meet the viewport grown by 900 screen pixels on each side,
so a board of thousands of objects keeps a few hundred elements in the DOM. The selection, the node being
text-edited or cropped, a connector's hover target, selected connectors and both endpoint nodes of every
mounted connector are always mounted. Culling only decides what is mounted: select all, marquee, align,
copy, export, fit, minimap, search, jump-to-object and AI placement read the whole graph from the store.

## Local drafts (`src/lib/canvas-pending-draft.js`)

Every save attempt and every page hide or unmount stores the unacknowledged graph in localStorage with its
base version, base graph and the unsettled save (`{id, data}`). On reopen:

- a draft that is itself a save that landed is discarded; a draft whose unsettled save landed merges with
  that save's graph as its base;
- a draft that never landed and is younger than 30 days merges with its stored base;
- a draft older than 30 days, or without a stored base, lets the server's copy win for every item both
  have and adds only the items that exist solely in the draft (a recent draft on the server's current version
  uses the server graph as its base).

Drafts are never swept by age. When storage is full, other boards' drafts are evicted oldest first until the
new draft fits; if it still does not, it is stored without its base graph.
