# Board diagramming

Shape packs, structured diagram objects and connection-line features on canvas boards. Everything
is an optional field in board format v1, so older boards load and save unchanged. The twin
serializers, `src/lib/canvas/serialization.js` and `backend/apps/canvas/serialization.py`, coerce
the fields the same way; `backend/apps/canvas/fixtures/format_v1_shapes_rich_text.json` holds the
shared cases. It builds on the generic path shapes in [board-shapes-rich-text.md](board-shapes-rich-text.md).

## Shape packs

The shapes panel (**S**) lists packs: flowchart, UML, BPMN, data flow, value stream, electrical,
process, callouts, diagram, and a cloud and Kubernetes architecture pack. Packs load lazily
(a dynamic import in `src/lib/canvas/shapes.js`), so a board that uses no pack ships none of them.
A placed pack shape is an ordinary `type: "shape"` node with a `shape` kind. Which packs are
enabled and the diagram theme are personal preferences in `localStorage`, not board data.

### Licence and provenance

Every pack outline and detail stroke is original geometry authored in this repository
(`src/lib/canvas/shape-packs.js`). None is copied from a third-party icon set, so no attribution
is required. The cloud pack uses generic infrastructure and Kubernetes-style silhouettes. Vendor
logo sets (AWS, Azure, GCP and similar) are not shipped, because their terms restrict
redistribution. Users who need them upload the vendor SVGs as a custom shape pack.

### Custom shape packs

A user uploads SVG files into a named pack kept per user in the `CustomShapePack` table
(`/api/canvas-shape-packs`, `/api/canvas-shape-packs/<id>`; only the owner or an admin may edit or
delete). `backend/apps/canvas/svg_sanitize.py` sanitizes on upload: a 50 KB cap, at most 100
shapes per pack, an allowlist of tags and attributes, and no scripts, event handlers, external
references, `<use>`, `<image>`, `<style>` or `data:` URLs. A placed custom shape is a `shape`
node with kind `custom` and the sanitized `svg`, `svgViewBox` and `shapeName` fields. Both
serializers re-check those fields, so a hand-crafted board cannot smuggle markup in.

## Structured objects

- `erd`: an entity table with rows. A connector can attach to a row with an anchor of the form
  `row:<id>:left` or `row:<id>:right`, and the ERD line caps (one, many, zero or one and so on)
  are connector cap values.
- `swimlane`: a pool with lanes, horizontal or vertical. Moving the pool moves its children.
- `diagram`: a container with named layers. `diagramLayerId` on a node assigns it to a layer;
  hidden layers are skipped by viewport culling, along with their connectors, and Focus mode
  shows one layer.
- A callout shape's `tail` is a world point or a node anchor and follows its target.

## Connection lines

Connector fields: `shape` (curved, straight or orthogonal), `startCap` and `endCap` (arrowhead
styles), `waypoints` (custom paths), `labels` (text at a position along the line) and
`lineJumps`. `src/lib/canvas/connector-routing.js` holds the pure geometry: shortest orthogonal
routing around obstacles, shift angle snapping, line jumps where lines cross, and the points a
label or an inserted shape sits on. Holding Cmd or Ctrl while drawing disables snapping. The
inspector's "Insert shape on line" splits one connector into two with a shape between.
Clicking a selected shape's connection handle creates a linked copy and a connector (quick
diagram creation).

## Roles and saves

All edits go through `mutateGraph`, which refuses them in read-only mode, so viewers and
commenters cannot change content. Saves use the per-node save path.
