/**
 * Find and replace over the board graph in the client store. The whole board
 * is already loaded, so there is no search index: every search scans the
 * visible text of every object (see textFields), culled or not.
 */
import { readingOrder } from "./keyboard-nav";
import { connectorBounds } from "./geometry";

const SHAPE_TYPES = new Set(["rect", "ellipse", "triangle", "diamond", "shape"]);
const DIAGRAM_TYPES = new Set(["erd", "swimlane", "diagram"]);

/** The finder's type filters, in the order the finder lists them. */
export const FIND_TYPES = [
  { id: "sticky", label: "Sticky notes" },
  { id: "text", label: "Text" },
  { id: "shape", label: "Shapes" },
  { id: "frame", label: "Frames" },
  { id: "image", label: "Images" },
  { id: "diagram", label: "Diagrams" },
  { id: "connector", label: "Connectors" },
];

/** The finder type a node belongs to. */
export function findTypeOf(node) {
  if (SHAPE_TYPES.has(node.type)) return "shape";
  if (DIAGRAM_TYPES.has(node.type)) return "diagram";
  return node.type;
}

/** The value at a dotted `field` path ("text", "rows.0.cells.1") of a board object. */
export function valueAt(item, field) {
  return field.split(".").reduce((value, key) => value?.[key], item);
}

/** A copy of `item` with `value` at the dotted `field` path. */
function withValueAt(item, [key, ...rest], value) {
  const next = Array.isArray(item) ? [...item] : { ...item };
  next[key] = rest.length ? withValueAt(item[key], rest, value) : value;
  return next;
}

function fieldsOf(item) {
  switch (item.type) {
    case "frame":
    case "diagram":
      return ["name"];
    case "image":
      return ["alt"];
    case "sticky":
    case "text":
      return ["text"];
    case "erd": {
      // Only the cells the table's columns show.
      const columns = item.columns ?? 3;
      const rows = Array.isArray(item.rows) ? item.rows : [];
      return ["name", ...rows.flatMap((row, r) => (row.cells ?? []).slice(0, columns).map((_, c) => `rows.${r}.cells.${c}`))];
    }
    case "swimlane":
      return ["name", ...(Array.isArray(item.lanes) ? item.lanes : []).map((_, i) => `lanes.${i}.name`)];
    default:
      if (SHAPE_TYPES.has(item.type)) return ["text"];
      // A connector: its labels.
      return Array.isArray(item.labels) ? item.labels.map((_, i) => `labels.${i}.text`) : [];
  }
}

/**
 * The visible text of a board object (node or connector), as `{field, value}`
 * in reading order, `field` a dotted path into the object: a note's or shape's
 * text, a frame's or diagram's title, an image's description, an ERD table's
 * name and the cells its columns show, a swimlane's pool and lane names, a
 * connector's labels. Empty texts are left out.
 */
export function textFields(item) {
  return fieldsOf(item)
    .map((field) => ({ field, value: valueAt(item, field) }))
    .filter(({ value }) => typeof value === "string" && value);
}

function rangesOf(text, query, matchCase) {
  const haystack = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  // Lower-casing can change a string's length for a few characters; then
  // offsets would not map back, so such text only matches case-sensitively.
  if (haystack.length !== text.length || needle.length !== query.length) return matchCase ? [] : rangesOf(text, query, true);
  const ranges = [];
  let from = 0;
  while (needle && from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    ranges.push([at, at + needle.length]);
    from = at + needle.length;
  }
  return ranges;
}

/**
 * Every text field on the board containing `query`, as `{id, field, ranges}`
 * with the matched ranges: objects in reading order, each object's fields in
 * its own order. `types` limits the search to those finder types (all when
 * empty).
 */
export function findOnBoard(present, query, { types = [], matchCase = false } = {}) {
  if (!query) return [];
  const allowed = types.length ? new Set(types) : null;
  const nodesById = Object.fromEntries(present.nodes.map((n) => [n.id, n]));
  const found = new Map();
  const boxes = [];
  const search = (item, type, boxOf) => {
    if (allowed && !allowed.has(type)) return;
    const hits = [];
    for (const { field, value } of textFields(item)) {
      const ranges = rangesOf(value, query, matchCase);
      if (ranges.length) hits.push({ id: item.id, field, ranges });
    }
    if (!hits.length) return;
    found.set(item.id, hits);
    boxes.push({ id: item.id, ...boxOf() });
  };
  for (const node of present.nodes) search(node, findTypeOf(node), () => node);
  for (const connector of present.connectors) search(connector, "connector", () => connectorBounds(connector, nodesById));
  return readingOrder(boxes).flatMap((id) => found.get(id));
}

/**
 * Formatting ranges after the text [start, end) became `inserted` characters
 * long. A range around the replaced text stretches over the new text, ranges
 * after it shift, and a range that only partly covered it is cut at its edge.
 */
export function shiftMarks(marks, start, end, inserted) {
  if (!marks?.length) return marks;
  const delta = inserted - (end - start);
  const out = [];
  for (const mark of marks) {
    let [a, b] = mark;
    if (b <= start) {
      // entirely before: unchanged
    } else if (a >= end) {
      a += delta;
      b += delta;
    } else if (a <= start && b >= end) {
      b += delta;
    } else if (a < start) {
      b = start;
    } else if (b > end) {
      a = start + inserted;
      b += delta;
    } else {
      continue; // entirely inside the replaced text: it goes with it
    }
    if (b > a) out.push([a, b, ...mark.slice(2)]);
  }
  return out;
}

/** `item` with every match of the hit's ranges (or only range `only`) replaced by `replacement`. */
function replaceInItem(item, hit, replacement, only) {
  const value = valueAt(item, hit.field);
  const ranges = only == null ? hit.ranges : [hit.ranges[only]];
  let text = value;
  let marks = hit.field === "text" ? item.marks : undefined;
  // Right to left, so earlier offsets stay valid.
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    if (text.slice(start, end) !== value.slice(start, end)) continue;
    text = text.slice(0, start) + replacement + text.slice(end);
    marks = shiftMarks(marks, start, end, replacement.length);
  }
  const next = withValueAt(item, hit.field.split("."), text);
  if (hit.field === "text") {
    if (marks?.length) next.marks = marks;
    else delete next.marks;
  }
  return next;
}

/**
 * The edits that replace matches: every hit (`target` omitted), or one match
 * `{id, field, index}`. Returns a Map of id to the replaced node or
 * connector, ready for the store to commit as one undo step.
 */
export function replaceMatches(present, hits, replacement, target) {
  const byId = new Map([...present.nodes, ...present.connectors].map((item) => [item.id, item]));
  const edits = new Map();
  for (const hit of hits) {
    if (target && (hit.id !== target.id || hit.field !== target.field)) continue;
    const item = edits.get(hit.id) ?? byId.get(hit.id);
    if (!item || typeof valueAt(item, hit.field) !== "string") continue;
    const next = replaceInItem(item, hit, replacement, target ? target.index : null);
    if (valueAt(next, hit.field) !== valueAt(item, hit.field)) edits.set(hit.id, next);
  }
  return edits;
}

/**
 * Replaces the one match `at` ({hit, range}: indexes into `hits`) and picks
 * the match to go to next: the first one after the new text in the same
 * field, else the next field's first, wrapping like the finder's Next. So
 * replacing with text that contains the query moves on instead of replacing
 * the new text again. Returns the edits, the hits after them, and the next
 * match in those hits (null when none is left).
 */
export function replaceOneMatch(present, hits, at, replacement, query, options) {
  const hit = hits[at.hit];
  const [start] = hit.ranges[at.range];
  const edits = replaceMatches(present, hits, replacement, { id: hit.id, field: hit.field, index: at.range });
  const edited = (item) => edits.get(item.id) ?? item;
  const after = findOnBoard({ ...present, nodes: present.nodes.map(edited), connectors: present.connectors.map(edited) }, query, options);
  if (!after.length) return { edits, hits: after, at: null };
  const same = after.findIndex((h) => h.id === hit.id && h.field === hit.field);
  const range = same < 0 ? -1 : after[same].ranges.findIndex(([from]) => from >= start + replacement.length);
  if (range >= 0) return { edits, hits: after, at: { hit: same, range } };
  // Text edits never reorder objects or fields, so the next field follows this one, or takes its place when it no longer matches.
  return { edits, hits: after, at: { hit: (same < 0 ? at.hit : same + 1) % after.length, range: 0 } };
}

/** The total number of matches across hits. */
export function matchCount(hits) {
  return hits.reduce((sum, hit) => sum + hit.ranges.length, 0);
}
