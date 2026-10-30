/**
 * Find and replace over the board graph in the client store. The whole board
 * is already loaded, so there is no search index: every search scans the
 * text of stickies, text boxes and shapes, frame titles and image
 * descriptions, culled or not.
 */
import { readingOrder } from "./keyboard-nav";

const SHAPE_TYPES = new Set(["rect", "ellipse", "triangle", "diamond", "shape"]);

/** The finder's type filters, in the order the finder lists them. */
export const FIND_TYPES = [
  { id: "sticky", label: "Sticky notes" },
  { id: "text", label: "Text" },
  { id: "shape", label: "Shapes" },
  { id: "frame", label: "Frames" },
  { id: "image", label: "Images" },
];

/** The finder type a node belongs to. */
export function findTypeOf(node) {
  return SHAPE_TYPES.has(node.type) ? "shape" : node.type;
}

/** The searchable field of a node: its text, a frame's title, an image's description. */
export function searchableField(node) {
  if (node.type === "frame") return "name";
  if (node.type === "image") return "alt";
  if (node.type === "sticky" || node.type === "text" || SHAPE_TYPES.has(node.type)) return "text";
  return null;
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
 * Every node whose searchable text contains `query`, in reading order, with
 * the matched ranges. `types` limits the search to those finder types (all
 * when empty).
 */
export function findOnBoard(present, query, { types = [], matchCase = false } = {}) {
  if (!query) return [];
  const allowed = types.length ? new Set(types) : null;
  const hits = new Map();
  for (const node of present.nodes) {
    const field = searchableField(node);
    if (!field || (allowed && !allowed.has(findTypeOf(node)))) continue;
    const value = node[field];
    if (typeof value !== "string" || !value) continue;
    const ranges = rangesOf(value, query, matchCase);
    if (ranges.length) hits.set(node.id, { id: node.id, field, ranges });
  }
  return readingOrder(present.nodes.filter((n) => hits.has(n.id))).map((id) => hits.get(id));
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

/** `node` with every match of the hit's ranges (or only range `only`) replaced by `replacement`. */
function replaceInNode(node, hit, replacement, only) {
  const value = node[hit.field];
  const ranges = only == null ? hit.ranges : [hit.ranges[only]];
  let text = value;
  let marks = hit.field === "text" ? node.marks : undefined;
  // Right to left, so earlier offsets stay valid.
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    if (text.slice(start, end) !== value.slice(start, end)) continue;
    text = text.slice(0, start) + replacement + text.slice(end);
    marks = shiftMarks(marks, start, end, replacement.length);
  }
  const next = { ...node, [hit.field]: text };
  if (hit.field === "text") {
    if (marks?.length) next.marks = marks;
    else delete next.marks;
  }
  return next;
}

/**
 * The node edits that replace matches: every hit (`target` omitted), or one
 * match `{id, index}`. Returns a Map of id to the replaced node, ready for
 * the store to commit as one undo step.
 */
export function replaceMatches(present, hits, replacement, target) {
  const nodesById = new Map(present.nodes.map((n) => [n.id, n]));
  const edits = new Map();
  for (const hit of hits) {
    if (target && hit.id !== target.id) continue;
    const node = nodesById.get(hit.id);
    if (!node || typeof node[hit.field] !== "string") continue;
    const next = replaceInNode(node, hit, replacement, target ? target.index ?? 0 : null);
    if (next[hit.field] !== node[hit.field]) edits.set(node.id, next);
  }
  return edits;
}

/** The total number of matches across hits. */
export function matchCount(hits) {
  return hits.reduce((sum, hit) => sum + hit.ranges.length, 0);
}
