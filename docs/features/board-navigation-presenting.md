# Board navigation, presenting and keyboard

Finding objects, frames and presenting, the command palette, keyboard shortcuts, accessibility
tools, copying out of a board and links to objects. Everything works from the board data in the
client store (`src/lib/canvas-store.js`), never the DOM, so objects that viewport culling has not
mounted are found, navigated, checked and copied too. The **Board** menu in the top bar opens each
tool; the open panel, finder and presentation live in `src/lib/canvas/board-ui.js` and are never
saved.

## Frame fields in format v1

Frames take two optional fields, both board data that saves and merges per object like any other
edit:

```json
{"type": "frame", "name": "Intro", "frameOrder": 1, "notes": "Say hello first", ...}
```

- `frameOrder`: the frame's place in the board-wide frame order. Both serializers keep it only
  when it is a finite number (a numeric string is dropped).
- `notes`: presenter notes. Both serializers keep only a non-empty string.

`src/lib/canvas/serialization.js` and `backend/apps/canvas/serialization.py` coerce them the same
way; the `frames` case in `backend/apps/canvas/fixtures/format_v1_shapes_rich_text.json` runs in
both test suites. Boards saved before these fields load and save unchanged.

## Find and replace

Cmd/Ctrl+F searches sticky notes, text boxes and shapes (their text), frame titles and image
descriptions, with an optional match-case switch and type filters (`src/lib/canvas/find.js`). Hits
come in reading order; each jump selects the hit and brings it into view while the overlay dims
the rest. Editors can replace one match or all of them as one undo step; formatting ranges around
replaced text stretch or shift with it.

## Frames panel and presenting

The frames panel lists frames in presentation order (`orderedFrames` in `src/lib/canvas/frames.js`):
frames with a `frameOrder` first, then the rest in reading order. It shows thumbnails or a list,
jumps to a frame and copies a link to it. Editors reorder by drag or Alt+arrows, write presenter
notes, and run **Organize frames**, which lays the frames out in a grid in their order and moves
their contents with them. Notes are part of the board, so everyone who can open it can read them.

**Present frames** (Cmd/Ctrl+Alt+P) shows each frame as a slide on this screen only; nobody
else's view follows. A slide is the live board fitted to the frame with everything around it
blacked out, full screen when the browser allows. Keys: arrows, Page Up/Down and Space step;
Home and End jump; G shows all slides; N toggles presenter notes; B leaves the slides to look
around the board; F toggles full screen; Escape stops. The slide view is not recorded as the
board's view, and stopping restores the view from before the presentation.

## Command palette and shortcuts

Cmd/Ctrl+K opens the command palette (`src/components/canvas/CommandPalette.jsx`): dock tools,
board panels, Organize frames, copy and link actions on the selection, connecting the selected
objects with arrows in reading order, undo and redo, and recent boards. Inside the rich-text editor
Cmd/Ctrl+K still adds a link.

Every board shortcut is one entry in the registry in `src/lib/canvas/shortcuts.js`, which the key
handler dispatches from and the shortcut panel (F1 or ?) and palette list; its header documents
the entry fields. Keys typed into a field or editor never reach it, and single-character keys can
be turned off in the panel or palette so screen readers and voice control keep those letters.
Number keys 1 to 9 pick dock tools in dock order; **Customize toolbar** pins, unpins and reorders
the creation tools (`src/lib/canvas/toolbar-tools.js`).

Keyboard navigation (`src/lib/canvas/keyboard-nav.js`) reads the board like a page: B focuses the
board, Tab walks one level in reading order, Enter goes into a frame or group (or edits text),
Escape comes back out, and Cmd/Ctrl+arrows jump to the nearest object in that direction. Screen
readers hear what is selected through a polite live region.

## Accessibility tools

**Check accessibility** (`src/lib/canvas/a11y-check.js`) lists text below WCAG 2.2 AA contrast
against its fill, frame or the board background (4.5:1, or 3:1 from 24px), images without a
description and frames without a title, each with a jump to it; editors can fill in the missing
description or title in place. **Explore board content** lists the board for screen readers:
frames in presentation order with what each holds, then the objects outside frames.

## Copy as text or image

Cmd/Ctrl+C copies the selection for pasting on a board and also puts its text on the system
clipboard, one object per line in reading order; a selected frame contributes its title, then its
contents. Cmd/Ctrl+Shift+C copies the selection as a PNG drawn from the board data on the board
background, at up to twice its size and at most 4096 x 4096 pixels' worth of area; images are read through the same-origin media stream
(`src/lib/canvas/clipboard-export.js`).

## Object links and recent boards

A link `/?project=P&board=B&object=O` (`src/lib/canvas/object-link.js`) opens the board view,
switches project, opens the board and centers the object with a **Go back** prompt to the earlier
view; the address is then cleaned. Copy one from the frames panel or the palette. The server's
board access rules still apply to whoever opens it.

The palette's recent boards are kept in localStorage per signed-in user
(`veevee-board-prefs-v1:<userId>`, at most 8) and cleared on sign-out. The single-key switch and
toolbar layout are device preferences under `veevee-board-prefs-v1`
(`src/lib/canvas/board-prefs.js`).

View and comment access can find, present, browse frames, run the checks and copy; they cannot
replace, reorder frames, edit notes or organize frames, and the server refuses their saves.
