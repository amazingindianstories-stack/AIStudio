# Canvas board sync

Several people can edit one board without overwriting each other. There is no realtime service: the API is
a single gunicorn worker with 8 threads and a 25 s timeout, so boards save through conditional writes,
merge per node on the client and poll for other people's saves.

## Save contract (`PUT /api/canvas-boards/<id>`)

- The body carries `data` (the graph), `baseVersion` (the board version the edits started from) and
  `saveId` (a fresh client UUID for each save attempt). The write is one conditional
  `UPDATE ... WHERE version = baseVersion`. There is no unconditional write: a missing or stale
  `baseVersion`, or a missing `saveId`, gets `409 {error: "VERSION_CONFLICT", board}` with the current
  board (graph and version), and nothing is written. A malformed `baseVersion` or `saveId` gets 400.
- A save that changes nodes or connectors bumps `version`. A save that only changes the viewport (each
  person's own) keeps the version, so open boards do not refetch the graph.
- A graph-changing save records `(board_id, save_id, version, applied_at)` in `canvas_board_saves` in the
  same transaction, unique per board and save id. `run_scheduler` prunes rows older than 30 days daily
  (`board_saves`, the 03:17 UTC slot); deleting a board deletes its rows. Viewport-only saves record nothing.
- `GET /api/canvas-boards/<id>?saveId=<uuid>` adds `saveVersion`: the version that save landed at, or null.
- `GET /api/canvas-boards/<id>/version` returns `{version, updatedAt}` without reading the graph. Open boards
  poll it every 3 s, every 15 s after a minute with no input and no remote change, and not while hidden
  (`src/lib/canvas/use-board-polling.js`); the graph is fetched only when the version moved.

## Client merge (`src/lib/canvas/merge.js`, `src/lib/canvas-store.js`)

- A 409 or a newer polled version merges the other person's graph three-way, per node and connector id,
  against the graph this tab last synced: one-sided changes apply; when both sides changed an item the
  local unsaved edit wins. The viewport stays local. The result is saved again on the new version.
- The same merge is applied to every undo and redo snapshot, so undo only reverts this person's own steps.
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
