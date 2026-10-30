# Board stickies and text styling

Sticky options, tags, emoji votes, author labels, sticky stacks, fonts and styles on canvas boards.
Every new field is optional in board format v1, so older boards load and save unchanged. The two
serializers, `src/lib/canvas/serialization.js` and `backend/apps/canvas/serialization.py`, coerce
them the same way; `backend/apps/canvas/fixtures/format_v1_stickies_tags.json` holds the cases both
test suites run. Board actions live in `src/lib/canvas/sticky-actions.js` over pure helpers
(`stickies.js`, `tags.js`, `reactions.js`, `styles.js`, `fonts.js`, `lists.js`); each goes through
the store's `editBoard`, so it is one undo step, a per-node save, and a no-op on a read-only board.

## Stickies

- **Palette and shape.** A sticky's Fill shows 16 sticky colors (`STICKY_COLORS`), each with a
  readable text color that follows it. Square and rectangle (1.75 times as wide) keep the height and
  top-left corner. Shape is derived from the size, not stored.
- **Auto font size.** `autoFit: true` (stored only when on; new stickies have it) sizes the text to
  the largest whole size that fits, up to a third of the shorter side, shrinking before a word would
  break (`nodes/use-auto-fit.js`). Only rendered stickies measure, so culling is unaffected. Choosing
  a size turns it off.
- **Bulk mode.** The sticky tool's menu (the chevron beside it) opens a dialog: one sticky per
  non-blank line, at most 500, laid out in a grid at the middle of the view.
- **Paste cells.** Cells copied from a spreadsheet (an HTML table, else tab-separated text) paste as
  one sticky per non-empty cell in the same grid, up to 50 rows and 100 columns; more shows a notice.
  Copying board objects also marks the system clipboard (`board-clipboard.js`), so a paste puts back
  whichever was copied last.
- **Sticky stack.** A `stack` node (`fill` only) from the same menu. Dragging off an unselected stack
  peels a new empty sticky in its color, which follows the pointer in the same undo step; the stack
  stays. Select a stack to move, recolor or delete it.
- **Author.** The server stamps `textBy` when someone replaces an existing sticky's text
  (`backend/apps/canvas/activity.py`); the author is `textBy`, else `createdBy`. `showAuthor` puts the
  name in the sticky's footer (More, Show author).
- **Tags.** The board keeps a tag table, `tags: [{id, name, color}]` (at most 300, names up to 60
  characters, unique ignoring case), and a sticky lists up to 8 `tagIds`. The Tags picker finds,
  creates, applies and removes tags on the selection, renames, recolors and deletes a tag board-wide,
  and selects everything with a tag. Unused tags stay until deleted.
- **Emoji votes.** `reactions: {emoji: [userIds]}`, at most 12 emojis per sticky. Voting from the
  inspector or clicking an emoji in the footer adds or takes back your own vote. Votes are not edits:
  they leave the history stamps and activity alone, and they merge per person (below).
- **CSV export.** More, Export to CSV downloads the selected stickies' text, color name, tags and
  author as "<board> stickies.csv" (UTF-8 with a byte order mark; a cell that a spreadsheet would run
  as a formula is prefixed with `'`).
- **Clustering.** More, Cluster stickies by Tag, Color or Author arranges two or more selected
  stickies into near-square grids, left to right, each under a bold title such as "Urgent (3)".

## Text and styling

- **Rich text and text in shapes** are described in [board-shapes-rich-text.md](board-shapes-rich-text.md).
  Shape text is centered unless the shape stores `align` (`left`, `center` or `right`, chosen in the
  inspector), and typing or pasting into a shape stops at 6,000 characters (`MAX_SHAPE_TEXT`); the
  limit is the editor's, so text that arrives longer some other way (switching a long sticky to a
  shape) is kept.
- **Lists.** Typing "- " or "* " at the start of a line starts a bulleted list, "1. " a numbered one;
  Enter continues, Enter on an empty item ends it, Tab and Shift+Tab nest up to 5 levels. Markers are
  ordinary text (`lists.js`), so lists need no format field; numbers are rewritten on commit.
- **Fonts.** `fontFamily` on text, stickies and shapes picks one of 34 fonts (sans, serif, mono,
  handwriting and CJK), self-hosted through next/font in `src/components/canvas/board-fonts.js` and
  downloaded only when used. An unknown id is kept and renders in the default font.
- **Colors.** Fill, stroke and text colors use the 23 board colors plus "My colors": up to 16 colors
  picked by spectrum, hex or eyedropper, saved per person in this browser.
- **Remembered style.** A style chosen in the inspector becomes the default for that person's next
  sticky, text box or shape (per kind, in this browser).
- **Copy and paste style.** Cmd/Ctrl+Alt+C copies the first selected object's style; Cmd/Ctrl+Alt+V
  (or More) applies what the selection can take. Shapes without text do not gain text styling.
- **Switch type.** More, Switch to turns stickies, text boxes and the basic shapes into one another,
  in bulk, keeping text, formatting and color.

Personal preferences (custom colors, remembered styles) use `localStorage` under
`veevee:board-<kind>:<userId>`; nothing personal is written to the board.

## Collaboration and roles

Tags merge per tag id like nodes, and emoji votes merge per person even when both sides changed
the same sticky, so two people voting at once both count (`src/lib/canvas/merge.js`). View and comment
access see tags, votes and authors but get no inspector, sticky menu or vote buttons, and the server
refuses their saves.
