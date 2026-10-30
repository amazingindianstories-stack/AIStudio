# Board history and object info

Who added, edited and deleted which objects on a canvas board, and when. The server records it while it
saves; clients cannot write or forge it.

## Recording (`backend/apps/canvas/activity.py`)

Each graph save is diffed against the stored graph per node and connector id, inside the save's transaction,
after any 409 merge on the client, so the record reflects what was actually written:

- a new id is an `add`, a missing one a `delete`, and a changed one an `edit`;
- moves and votes are not changes (as in Miro): a node whose only difference is `x`, `y`, `parentId`, `groupId`
  or its emoji `reactions`, or a connector whose only difference is where a free end sits, records nothing and keeps its stamps;
- the stored graph is normalized first, so serializer defaults added since it was written are not edits;
- matching is by id alone, and a deleted object's stamps are not kept: restoring one (undo of a delete, or a
  merge or draft restore that brings it back) records an `add` by the restoring person, who becomes its
  creator. Keeping the original creator belongs with the later versions and restore work.

Added and edited objects get `createdBy`, `createdAt`, `updatedBy` and `updatedAt` (user id, epoch ms); an
edit keeps the creation stamps. A sticky whose text someone replaces also gets `textBy`, the author its
label shows ([board-stickies-text.md](board-stickies-text.md)). Both serializers (`serialization.py`, `src/lib/canvas/serialization.js`)
carry the fields, and objects saved before stamping have none until they next change. The stamps do not
count toward the board size limit (`content_length` in `serialization.py`).

Every change appends a row to `board_activity`: board, actor, action, node id, node type (`connector` for
connectors), a snippet of up to 120 characters (a node's text, a frame's name or an image's alt text), the
save time and its position within the save. Viewport-only saves and refused saves record nothing.
`run_scheduler` deletes rows older than 90 days daily (`board_activity`, the 03:17 UTC slot); deleting a
board deletes its rows. Versions, restore and content backups are not part of this.

## Reading

`GET /api/canvas-boards/<id>/activity[?before=<createdAt>.<ordinal>]` returns
`{activity: [{actorId, action, nodeId, nodeType, snippet, at}], next}`, newest first in pages of 100, with
`next` as the cursor for older entries. It needs edit access: commenters and viewers get 403, a board the
caller cannot see 404, and no session 401. Below co-owner, rows for objects inside a hidden frame (and connectors
touching them) are left out, and a row's `snippet` is null unless that object is on the board and visible to
the caller (`backend/apps/canvas/hidden.py`). Names come from `GET /api/users` on the client.

## Interface

- **History** (next to Share, for people who can edit): changes grouped by person and day, newest first, with
  snippets. It refreshes when the board version moves and loads older pages on request. Choosing an object
  still on the board selects it and centers the view on it; deleted objects are listed but not linked
  (`src/components/canvas/BoardHistoryPanel.jsx`).
- **Object info** (everyone who can open the board): with one object selected, a line above the toolbar
  shows who created it and who last changed it, and when (`src/components/canvas/ObjectInfo.jsx`).
