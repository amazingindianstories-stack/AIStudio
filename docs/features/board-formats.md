# Board formats

Docs, Slides, HTML embeds and Draw.io diagrams on canvas boards, their focus mode, diagrams built
from Mermaid code, and click-through prototypes. Everything is an optional field in board format v1,
so older boards load and save unchanged. The twin validators, `src/lib/canvas/formats/validate.js`
and `backend/apps/canvas/formats.py`, coerce the fields the same way, and both serializers must turn
each case in `backend/apps/canvas/fixtures/format_v1_formats.json` into its expected board
(`src/lib/canvas/formats/model.test.js`, `backend/apps/canvas/test_formats.py`).

## Format objects

A format is an ordinary board node of `type: "format"` with a `format` kind: `doc`, `deck`, `html`
or `drawio`. It saves through the per-node save path, so it obeys roles, locks, culling and the
board size limit ([canvas-board-sync.md](../architecture/canvas-board-sync.md)); its large fields are
stored outside the board JSON ([Payload storage](#payload-storage)). A node with an unknown kind is
dropped. Every kind has:

- `name`: up to 120 UTF-16 units; a missing or longer name becomes the kind's default
  ("Untitled doc", "Untitled slides", "HTML embed", "Draw.io diagram").
- `status` (optional): `draft`, `in_review`, `approved`, `done` or `outdated`. A `diagram` node
  can carry one too. The Formats button shows the board's status: the default view's, else
  the least finished one.
- `defaultView` (optional, `true`): the format the board opens in focus mode. At most one format
  holds it; a copy never does. `viewLocked` (`true`, only with `defaultView`) keeps read-only
  viewers in focus mode: they cannot go back to the board, and closing another format returns them
  to the default view.

Kind-specific fields and caps:

| Kind | Fields |
|---|---|
| `doc` | `blocks`: up to 2,000, each with a unique `id` and a `type` of `p`, `h1`-`h3`, `ul`, `ol`, `todo`, `quote`, `code`, `table` or `diagram`. Text blocks hold `text` (20,000 units) with rich-text `marks`, and `todo` adds `checked`. A `table` holds `rows`, up to 20 by 8 cells of 500 units, padded to a rectangle. A `diagram` block holds `ref`, the id of another diagram or format on the board, shown inline. An empty list becomes one empty paragraph. `suggestions` (optional, up to 200): `replace` (new `text` and `marks`) or `delete` proposals on an existing `blockId`, with `by` and `at`. |
| `deck` | `slides`: up to 100, each `{id, title (120), frameId, notes (5,000), lane}`. A slide shows a board frame through `frameId`. `lanes`: up to 6 `{id, name (60)}`; a `main` lane always exists, and a slide in an unknown lane moves to it. |
| `html` | `html`: up to 500,000 units. |
| `drawio` | `xml`: up to 500,000 units. `preview` (optional): an SVG data URL (`data:image/svg+xml;base64,`) of up to 500,000 units. |

Text over its cap is replaced by the fallback, not truncated, so editors clip input to the caps
(`clipText` in `src/lib/canvas/rich-text.js`). Every string is saved well formed: an unpaired
surrogate becomes U+FFFD, because PostgreSQL `jsonb` rejects it.

Doc text also carries inline chips: `@[name](user:id)` for a person and `{{date:YYYY-MM-DD}}` for a
date (`parseChips` in `src/lib/canvas/formats/model.js`).

## Focus mode

The Formats button (bottom right) creates formats and Mermaid diagrams, lists the board's formats
and diagrams, and holds the wireframing library and prototype previews. Opening a format shows it
full screen in focus mode, which is local view state and never saved. "Copy focus link" copies the
current URL with `?board=<id>&focus=<node id>`; opening it switches to the Board, opens that board
(in its own project when the user can see it) and focuses the node, then removes both parameters.

A read-only viewer, or a format that is locked (or on a locked layer,
`src/lib/canvas/locks.js`), opens read-only. "Board default" is disabled, with a reason, while
another format is the locked default.

## External origins

Opening a board contacts no outside origin. HTML embeds render through `staticEmbedHtml`
(`src/lib/canvas/formats/html-embed.js`) in a frame with an empty `sandbox`: scripts, event
handlers, outside links, frames and refreshes are removed, and a Content Security Policy allows only
inline styles and `data:` images, fonts and media. A Draw.io diagram shows its stored `preview`. Only
when an editor opens its editor does the browser load `https://embed.diagrams.net` and post it that
node's XML; the edited XML and a fresh SVG preview come back and are saved.

## Diagrams from code

`src/lib/canvas/formats/mermaid.js` parses Mermaid `flowchart`/`graph` (node shapes, link styles and
labels, chains, `&` groups, subgraphs) and `stateDiagram` transitions with a hand-written parser, no
evaluation and no remote renderer, up to 20,000 units of source, 150 nodes and 300 edges. Unsupported
statements are reported and nothing changes. The result is a native `diagram` node with ordinary
shapes and connectors, created on the active layer, that people edit like any other.

- `sourceKind: "mermaid"` and `source` (20,000 units) on a `diagram` keep its code.
- `mermaidKey` on a shape names it in that code (a Mermaid id: letters, digits, `_` and inner `-`, up
  to 64 units). "Update diagram from code" rebuilds the shapes the code describes, keeping the ids of
  shapes whose keys survive, and leaves other children in place; "Read visual edits into code" writes the diagram back as source. A shape loses its key when
  it moves to another parent, and a copy keeps it only inside a copy of its diagram, so a key names one
  shape per diagram. A locked diagram, or one with locked shapes, is not rebuilt.

## Prototypes and slides

The wireframing library places screen frames (mobile, tablet, desktop) and UI elements; an element
goes inside the selected frame when there is one. `screenLink` on any non-frame node (an id of up to 64 units) is its
click-through destination frame; previewing a frame makes linked objects navigate, with Back and
Restart. A deck's slides render their frames from the full graph, and dragging an unlocked plain object
onto a slide moves it into that frame. The server drops a `screenLink` and clears a slide's `frameId`
when the target is not on the board; copying objects together with their targets remaps both.

## Payload storage

Docs blocks and suggestions, HTML embeds and draw.io XML and previews live in `canvas_board_format_payloads`,
one row per board and node (`apps/canvas/payloads.py`), not in the board JSON. The node keeps
`payload: {size, rev}`; `rev` rises only when the content changes. The server splits the fields off inside
the board-locked save, so roles, version conflicts and History apply unchanged, and a node sent with its
reference but without its fields keeps its stored row. Reads return the payload inline by default;
`?payloads=lazy` on the board, its save and its changes feed leaves the reference only, and
`GET /api/canvas-boards/:id/payloads/:nodeId` loads one node's payload.

The editor reads lazily. A format object loads its payload when it renders (culling leaves off-screen objects
unrendered) or opens in focus mode, and shows "Loading…" until then. Copying, cutting and every duplicate
(including an alt-drag) load the selected objects' missing payloads when they happen, four requests at a time,
taking whatever revision the server holds; the clipboard keeps the content, so pasting loads nothing. If one
cannot load, nothing is copied, a cut deletes nothing, and the board says "Some items could not be copied. Try
again." A cut deletes its objects only once their payloads have loaded, since a viewer cannot read the payload
of an object no longer on the board.
Saves and the pending draft carry a payload only where it differs from the synced graph, and a save's stamps
return each changed node's new reference (`src/lib/canvas/formats/payloads.js` holds the client side). A row
outlives its node, so an undo or merge that brings the node back finds its content; the rows go with the board.

The 2 Mi board limit, and the template snapshot's, count the graph without payloads. One payload may hold up
to 1,048,576 UTF-16 units of JSON (413 `payload` beyond that), on top of the per-field caps above.
Copying a board or template reads inline and re-splits; a template saved from a selection takes unloaded
payloads from the source board.

Migration `canvas.0019_format_payloads` is an expand step: it copies inline payloads into rows and adds each
node's reference, keeping the inline fields, so the previous release (which drops the reference and reads the
fields) still shows and saves every payload while both serve. A node without a reference is read from its inline
fields, and a save by this release takes them off. Removing the inline copies left by the migration is a later
contract step. Unapplying 0019 puts every row back inline into a node without its fields and drops the reference
before the table goes, so a rollback first unapplies canvas 0019 with the new image still deployed, then rolls back
the image.

## Roles and history

All edits go through the board store, which refuses them in read-only mode, and format edit paths
skip locked targets. Board History snippets use a format's `name`
([board-history.md](board-history.md)).
