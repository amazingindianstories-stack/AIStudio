# Board shapes and rich text

Path shapes and formatted text on canvas boards. Both are optional fields in board format v1, so
boards saved before them load and save unchanged. The two serializers,
`src/lib/canvas/serialization.js` and `backend/apps/canvas/serialization.py`, coerce them the same
way; `backend/apps/canvas/fixtures/format_v1_shapes_rich_text.json` holds the cases both test
suites run.

## Shapes

The shapes panel (toolbar, or **S**) places the basic set. Rectangle, rounded rectangle (a `rect`
with `cornerRadius` 16), circle (`ellipse`), triangle and diamond keep their original node types.
Every other basic shape is a generic path shape:

```json
{"type": "shape", "shape": "hexagon", "fill": "...", "stroke": "...", "strokeWidth": 2, ...}
```

`shape` names an outline in the catalogue in `src/lib/canvas/shapes.js`: `parallelogram`,
`trapezoid`, `pentagon`, `hexagon`, `octagon`, `star`, `cross`, `cylinder`, `arrow-left`,
`arrow-right`, `arrow-both`, `chevron`, `callout`, `cloud`. The outline is derived from the node's
box, so a new kind needs only a catalogue entry. The format accepts any kind matching
`^[a-z][a-z0-9-]{0,39}$` and keeps an unknown one, which renders as a rectangle; a node with a
missing or malformed kind is dropped.

A path shape takes pointer events, hit-tests (`geometry.hitTest`) and attaches connectors
(`geometry.nodeAnchorPoint`) on its outline: a side anchor is where the ray from the center towards
that side leaves the outline, and `auto` is where the ray towards the other end does. Marquee
selection and resize use the bounding box. The four original shape types keep their box anchors.

Any shape may hold text: optional `text`, `marks`, `fontSize` and `color`, present only once set.
Double-click a shape to type into it.

Sticky notes moved from **S** to **N**, Miro's key; **R** still places a rectangle.

## Rich text

Text boxes, stickies and shapes keep `text` as the plain string and store formatting beside it as
ranges over that string:

```json
"marks": [[0, 4, "b"], [5, 11, "i"], [12, 17, "u"], [18, 24, "s"], [25, 29, "h", "#fde047"], [30, 34, "a", "https://example.com"]]
```

Offsets are UTF-16 code units with an exclusive end. Kinds: `b` bold, `i` italic, `u` underline,
`s` strikethrough, `h` highlight (`#rrggbb`), `a` link. Both serializers drop malformed entries,
clamp ranges to the text, drop empty ranges, keep at most 4,000 marks per node, accept links only
with an `http://`, `https://` or `mailto:` scheme, no whitespace or control characters and at most
2,048 characters, and omit `marks` when nothing remains. Frames have no rich text.

The editor (`src/components/canvas/nodes/RichText.jsx`) is a contentEditable that is read back
through `readRichDom` in `src/lib/canvas/rich-text.js`, which keeps only text and the six marks;
paste inserts plain text only. Display renders the ranges as React elements, never HTML strings,
and re-checks links and colors. Links open in a new tab with `rel="noopener noreferrer nofollow"`:
on a plain click for view and comment access, on Cmd/Ctrl+click for editors.

Shortcuts while editing: Cmd/Ctrl+B, I, U; Cmd/Ctrl+Shift+X strikethrough; Cmd/Ctrl+K link;
Cmd/Ctrl+Enter finishes; Escape discards the edit. The formatting bar above the node also sets
highlight colors and removes highlights and links.

View and comment access never open the shapes panel or an editor; the server refuses their saves.
