// Board nodes built from the structured results of the diagram and board layout AI formats (backend/apps/agents/board.py).
// Pure: positions come from the result and a centre, never from the DOM.

import { MAX_CONTEXT_TEXT, nodeText } from "./ai-selection.js";
import { lockedIdSet } from "./locks.js";

export const STICKY_FILLS = {
  yellow: "#e3c56a",
  orange: "#d99a5b",
  pink: "#d189a7",
  purple: "#9b86c9",
  blue: "#6f9bd1",
  green: "#7fae86",
};
/** Columns for `count` notes: one row up to four, then a grid a little wider than tall. */
export function stickyColumns(count) {
  return count <= 4 ? Math.max(count, 1) : Math.ceil(Math.sqrt(count * 1.5));
}

const NODE_W = 180;
const NODE_H = 72;
const GAP_X = 72;
const GAP_Y = 72;
const DIAGRAM_FILL = "#2b3140";
const DIAGRAM_STROKE = "#8ea0c4";

const newId = () => crypto.randomUUID();

/** Rank of each node: its distance from a root along the edges (cycles and unreachable nodes fall back to rank 0). */
export function rankNodes(nodes, edges) {
  const incoming = new Set(edges.map((edge) => edge.to));
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) children.get(edge.from)?.push(edge.to);
  const rank = new Map();
  const queue = nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  if (!queue.length && nodes.length) queue.push(nodes[0].id);
  for (const id of queue) rank.set(id, 0);
  for (let head = 0; head < queue.length; head += 1) {
    for (const child of children.get(queue[head]) ?? []) {
      if (!rank.has(child)) {
        rank.set(child, rank.get(queue[head]) + 1);
        queue.push(child);
      }
    }
  }
  for (const node of nodes) if (!rank.has(node.id)) rank.set(node.id, 0);
  return rank;
}

/**
 * A diagram result as shape nodes and arrow connectors. A flowchart reads top to bottom, a mind map left to right;
 * both are layered by rank and centred on `center`.
 */
export function diagramGraph(result, center) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  const edges = (Array.isArray(result?.edges) ? result.edges : []).filter((edge) => nodes.some((n) => n.id === edge.from) && nodes.some((n) => n.id === edge.to));
  if (!nodes.length) return { nodes: [], connectors: [] };
  const horizontal = result.kind === "mindmap";
  const rank = rankNodes(nodes, edges);
  const layers = [];
  for (const node of nodes) (layers[rank.get(node.id)] ??= []).push(node);
  const across = (list) => list.length * (horizontal ? NODE_H : NODE_W) + (list.length - 1) * (horizontal ? GAP_Y / 2 : GAP_X / 2);
  const widest = Math.max(...layers.filter(Boolean).map(across));
  const depth = layers.length * (horizontal ? NODE_W : NODE_H) + (layers.length - 1) * (horizontal ? GAP_X : GAP_Y);
  const originX = center.x - (horizontal ? depth : widest) / 2;
  const originY = center.y - (horizontal ? widest : depth) / 2;
  const ids = new Map();
  const built = [];
  layers.forEach((layer, row) => {
    if (!layer) return;
    const offset = (widest - across(layer)) / 2;
    layer.forEach((node, index) => {
      const along = row * ((horizontal ? NODE_W : NODE_H) + (horizontal ? GAP_X : GAP_Y));
      const step = index * ((horizontal ? NODE_H : NODE_W) + (horizontal ? GAP_Y / 2 : GAP_X / 2)) + offset;
      const id = newId();
      ids.set(node.id, id);
      built.push({
        id,
        type: node.shape === "ellipse" || node.shape === "diamond" || node.shape === "triangle" ? node.shape : "rect",
        x: originX + (horizontal ? along : step),
        y: originY + (horizontal ? step : along),
        w: NODE_W,
        h: node.shape === "diamond" ? NODE_H + 24 : NODE_H,
        fill: node.color || DIAGRAM_FILL,
        stroke: DIAGRAM_STROKE,
        strokeWidth: 2,
        text: node.label,
        fontSize: 16,
        color: node.color ? "#1c1a12" : "#f1f5f9",
        align: "center",
        opacity: 1,
        parentId: null,
        groupId: null,
      });
    });
  });
  const connectors = edges.map((edge) => ({
    id: newId(),
    from: { nodeId: ids.get(edge.from), anchor: horizontal ? "right" : "bottom" },
    to: { nodeId: ids.get(edge.to), anchor: horizontal ? "left" : "top" },
    kind: "arrow",
    shape: "orthogonal",
    stroke: DIAGRAM_STROKE,
    strokeWidth: 2,
    ...(edge.label ? { labels: [{ id: newId(), text: edge.label, position: 0.5, orientation: "horizontal" }] } : {}),
  }));
  return { nodes: built, connectors };
}

const FRAME_PAD = 24;
const FRAME_HEAD = 56;
const STICKY = 200;
const FRAME_GAP = 48;
const FRAME_COLUMNS = 2;

/** A board layout result: a title, then frames side by side, each holding its sticky notes in a grid. */
export function layoutGraph(result, center) {
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  if (!frames.length) return { nodes: [], connectors: [] };
  const sizes = frames.map((frame) => {
    const count = Math.max(frame.notes?.length ?? 0, 1);
    const columns = Math.min(FRAME_COLUMNS, stickyColumns(count));
    const rows = Math.ceil(count / columns);
    return { columns, w: columns * STICKY + (columns + 1) * FRAME_PAD, h: FRAME_HEAD + rows * STICKY + (rows + 1) * FRAME_PAD };
  });
  const title = typeof result.title === "string" ? result.title.trim() : "";
  const width = sizes.reduce((sum, size) => sum + size.w, 0) + (frames.length - 1) * FRAME_GAP;
  const height = Math.max(...sizes.map((size) => size.h)) + (title ? 72 : 0);
  let x = center.x - width / 2;
  const top = center.y - height / 2 + (title ? 72 : 0);
  const nodes = [];
  if (title) {
    nodes.push({ id: newId(), type: "text", x: center.x - width / 2, y: top - 64, w: Math.min(width, 800), h: 48, text: title, fontSize: 32,
      align: "left", color: "#f1f5f9", opacity: 1, parentId: null, groupId: null });
  }
  frames.forEach((frame, index) => {
    const size = sizes[index];
    const frameId = newId();
    nodes.push({ id: frameId, type: "frame", x, y: top, w: size.w, h: size.h, name: frame.title, fill: "transparent", stroke: "#8ea0c4",
      opacity: 1, parentId: null, groupId: null });
    (frame.notes ?? []).forEach((note, position) => {
      nodes.push({
        id: newId(), type: "sticky",
        x: x + FRAME_PAD + (position % size.columns) * (STICKY + FRAME_PAD),
        y: top + FRAME_HEAD + FRAME_PAD + Math.floor(position / size.columns) * (STICKY + FRAME_PAD),
        w: STICKY, h: STICKY, text: String(note.text ?? ""), fill: STICKY_FILLS[note.color] ?? STICKY_FILLS.yellow, fontSize: 16,
        color: "#1c1a12", opacity: 1, parentId: frameId, groupId: null,
      });
    });
    x += size.w + FRAME_GAP;
  });
  return { nodes, connectors: [] };
}

/** One text note holding a generated summary, to the right of the selected objects (or at `center` with none). */
export function summaryGraph(result, present, selectionIds, center, inPlace = false) {
  // A refinement takes the place of the note it refines (centred on it), rather than stepping right of the selection.
  const selected = inPlace ? [] : present.nodes.filter((node) => selectionIds.includes(node.id));
  const right = selected.length ? Math.max(...selected.map((node) => node.x + node.w)) + FRAME_GAP : center.x - 180;
  const top = selected.length ? Math.min(...selected.map((node) => node.y)) : center.y - 160;
  const body = `${result.title}\n\n${result.body}`;
  return {
    nodes: [{ id: newId(), type: "sticky", x: right, y: top, w: 360, h: 320, text: body, fill: STICKY_FILLS.blue, fontSize: 16, color: "#1c1a12",
      opacity: 1, parentId: null, groupId: null }],
    connectors: [],
  };
}

/** `present` with the AI's edited text written onto the selected objects it names (their rich-text marks no longer fit). */
export function applyRewrite(present, result) {
  const edits = new Map((result?.items ?? []).map((item) => [item.id, item.text]));
  const locked = lockedIdSet(present);
  const touched = [];
  const nodes = present.nodes.map((node) => {
    if (!edits.has(node.id) || locked.has(node.id)) return node;
    const text = edits.get(node.id);
    // The AI only saw the first MAX_CONTEXT_TEXT characters, so a longer text is left alone rather than cut short.
    if (text === nodeText(node) || nodeText(node).trim().length > MAX_CONTEXT_TEXT) return node;
    touched.push(node.id);
    if (node.type === "frame") return { ...node, name: text };
    const { marks: _marks, ...rest } = node;
    return { ...rest, text };
  });
  return { present: { ...present, nodes }, touched };
}

/** `present` with the selected stickies moved into one titled column per group, below the selection's top-left. */
export function applyCluster(present, result) {
  const groups = result?.groups ?? [];
  const byId = new Map(present.nodes.map((node) => [node.id, node]));
  const locked = lockedIdSet(present);
  const members = groups.map((group) => ({ title: group.title, nodes: group.ids.map((id) => byId.get(id)).filter((node) => node && node.type === "sticky" && !locked.has(node.id)) }));
  const moved = members.flatMap((group) => group.nodes);
  if (!moved.length) return { present, touched: [] };
  const left = Math.min(...moved.map((node) => node.x));
  const top = Math.min(...moved.map((node) => node.y));
  const positions = new Map();
  const titles = [];
  const kept = [];
  let x = left;
  for (const group of members.filter((entry) => entry.nodes.length)) {
    const width = Math.max(...group.nodes.map((node) => node.w));
    const existing = present.nodes.find((node) => node.type === "text" && node.text === group.title && node.x === x && node.y === top - 56);
    if (existing) kept.push(existing.id);
    else titles.push({ id: newId(), type: "text", x, y: top - 56, w: Math.max(width, 200), h: 40, text: group.title, fontSize: 20, align: "left",
      color: "#f1f5f9", opacity: 1, parentId: null, groupId: null });
    let y = top;
    for (const node of group.nodes) {
      positions.set(node.id, { x, y });
      y += node.h + 24;
    }
    x += width + 48;
  }
  const nodes = present.nodes.map((node) => (positions.has(node.id) ? { ...node, ...positions.get(node.id), parentId: null } : node));
  return { present: { ...present, nodes: [...nodes, ...titles] }, touched: [...positions.keys(), ...kept, ...titles.map((title) => title.id)] };
}
