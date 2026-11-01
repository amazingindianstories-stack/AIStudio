/**
 * Mermaid-style diagram text -> native board shapes and connectors, with a small
 * hand-written parser (no eval, no remote renderer, no dependency).
 *
 * Supported: `graph` / `flowchart` (TB TD BT LR RL) with node shapes, link styles, link labels,
 * chains, `&` groups and subgraphs; and `stateDiagram` / `stateDiagram-v2` transitions.
 * Unknown lines are ignored and reported as warnings. `diagramToMermaid` writes the visual
 * diagram back as source, so code and shapes edit each other.
 */

import { MAX_ID } from "./model";

export const MAX_MERMAID_SOURCE = 20000;
export const MAX_MERMAID_NODES = 150;
export const MAX_MERMAID_EDGES = 300;

const NODE_W = 160;
const NODE_H = 64;
const GAP_X = 70;
const GAP_Y = 60;

const SHAPES = [
  // [open, close, shape]
  ["(((", ")))", "circle"],
  ["((", "))", "circle"],
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["{{", "}}", "hexagon"],
  ["[(", ")]", "cylinder"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "rhombus"],
  [">", "]", "flag"],
];

const ID = "[\\w\\u00C0-\\uFFFF]+(?:-[\\w\\u00C0-\\uFFFF]+)*";
const NODE_ID = new RegExp(`^\\s*(${ID})`);
const STATE_TRANSITION = new RegExp(`^(\\[\\*\\]|${ID})\\s*-->\\s*(\\[\\*\\]|${ID})\\s*(?::\\s*(.*))?$`);
const LINK = /(<?)(-{2,}>|--[xo]|-{2,}|={2,}>|={2,}|-\.+->|-\.+-|~{3,})/;

function unquote(text) {
  const t = text.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1);
  return t;
}

function cleanLabel(text) {
  return unquote(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();
}

/** Reads `id`, `id[text]`, `id((text))`... at the start of `text`; returns the node and what is left. */
function readNode(text) {
  const m = NODE_ID.exec(text);
  if (!m) return null;
  const id = m[1];
  let rest = text.slice(m[0].length);
  let label = null;
  let shape = "rect";
  for (const [open, close, name] of SHAPES) {
    if (rest.startsWith(open)) {
      const end = rest.indexOf(close, open.length);
      if (end > 0) {
        label = cleanLabel(rest.slice(open.length, end));
        shape = name;
        rest = rest.slice(end + close.length);
        break;
      }
    }
  }
  rest = rest.replace(/^:::\w+/, "");
  return { id, label, shape, rest };
}

function linkStyle(op) {
  if (op.includes(".")) return "dashed";
  if (op.startsWith("=") || op.includes("==")) return "thick";
  return "solid";
}

/**
 * Splits `A --> B -- text --> C` style statements. Returns segments of node groups and links.
 */
function parseStatement(line, onNode, onEdge) {
  let rest = line;
  let previous = null; // array of node ids
  let pendingLink = null;
  let guard = 0;
  while (rest.trim() && guard++ < 200) {
    // a group of nodes joined by &
    const group = [];
    for (;;) {
      const node = readNode(rest);
      if (!node) return false;
      onNode(node);
      group.push(node.id);
      rest = node.rest;
      const amp = /^\s*&\s*/.exec(rest);
      if (!amp) break;
      rest = rest.slice(amp[0].length);
    }
    if (pendingLink && previous) {
      for (const from of previous) for (const to of group) onEdge({ from, to, ...pendingLink });
    }
    previous = group;
    pendingLink = null;
    if (!rest.trim()) break;
    // a link with an optional label: -->|text|  or  -- text -->
    const textual = /^\s*(--|==|-\.)\s+([^->=.][^]*?)\s+(-{2,}>|-{2,}|={2,}>|={2,}|\.+->|\.+-)/.exec(rest);
    if (textual) {
      const op = textual[3];
      pendingLink = { label: cleanLabel(textual[2]), style: linkStyle(textual[1] + op), arrow: op.endsWith(">"), line: false };
      rest = rest.slice(textual[0].length);
      continue;
    }
    const lm = LINK.exec(rest);
    if (!lm || lm.index > 2) return false;
    const op = lm[2];
    pendingLink = { label: "", style: linkStyle(op), arrow: op.endsWith(">") || op.endsWith("x") || op.endsWith("o"), line: !op.endsWith(">") };
    rest = rest.slice(lm.index + lm[0].length);
    const labelMatch = /^\|([^|]*)\|/.exec(rest);
    if (labelMatch) {
      pendingLink.label = cleanLabel(labelMatch[1]);
      rest = rest.slice(labelMatch[0].length);
    }
  }
  return true;
}

/**
 * Parses diagram text. Returns `{ ok, error?, direction, nodes, edges, groups, warnings }`;
 * nodes `{id, label, shape, group}`, edges `{from, to, label, style, arrow, line}`,
 * groups `{id, title, parent}`.
 */
export function parseMermaid(source) {
  const empty = { ok: false, direction: "TB", nodes: [], edges: [], groups: [], warnings: [] };
  if (typeof source !== "string" || !source.trim()) return { ...empty, error: "Enter some diagram text." };
  if (source.length > MAX_MERMAID_SOURCE) return { ...empty, error: `The text is longer than ${MAX_MERMAID_SOURCE} characters.` };
  const lines = source
    .replace(/\r/g, "")
    .split(/\n|;/)
    .map((l) => l.replace(/%%.*$/, "").trim())
    .filter(Boolean);
  const head = /^(graph|flowchart|stateDiagram(?:-v2)?)\b\s*(TB|TD|BT|LR|RL)?/.exec(lines[0] ?? "");
  if (!head) return { ...empty, error: "Start with graph TD, flowchart LR or stateDiagram-v2. Other diagram types are not supported yet." };
  const state = head[1].startsWith("stateDiagram");
  const direction = head[2] === "TD" || !head[2] ? "TB" : head[2];
  const nodes = new Map();
  const edges = [];
  const groups = [];
  const warnings = [];
  const stack = [];
  let startCount = 0;
  let endCount = 0;

  const touch = (node) => {
    let existing = nodes.get(node.id);
    if (!existing) {
      existing = { id: node.id, label: node.id, shape: "rect", group: stack[stack.length - 1] ?? null };
      nodes.set(node.id, existing);
    }
    if (node.label != null) {
      existing.label = node.label;
      existing.shape = node.shape;
    }
  };

  for (const line of lines.slice(1)) {
    if (nodes.size > MAX_MERMAID_NODES) return { ...empty, error: `Too many nodes (limit ${MAX_MERMAID_NODES}).` };
    if (edges.length > MAX_MERMAID_EDGES) return { ...empty, error: `Too many links (limit ${MAX_MERMAID_EDGES}).` };
    if (/^(style|classDef|class|linkStyle|click|direction|accTitle|accDescr|title)\b/.test(line)) continue;
    if (state) {
      const sub = /^state\s+(?:"([^"]+)"\s+as\s+)?(\w+)\s*\{$/.exec(line);
      if (sub) {
        groups.push({ id: sub[2], title: sub[1] ?? sub[2], parent: stack[stack.length - 1] ?? null });
        stack.push(sub[2]);
        continue;
      }
      if (line === "}") {
        stack.pop();
        continue;
      }
      const decl = /^state\s+"([^"]+)"\s+as\s+(\w+)$/.exec(line);
      if (decl) {
        touch({ id: decl[2], label: decl[1], shape: "round" });
        continue;
      }
      const tr = STATE_TRANSITION.exec(line);
      if (tr) {
        const ids = [tr[1], tr[2]].map((raw, i) => {
          if (raw !== "[*]") return raw;
          return i === 0 ? `start${startCount || ""}` : `end${endCount || ""}`;
        });
        if (tr[1] === "[*]") {
          touch({ id: ids[0], label: "Start", shape: "circle" });
          startCount += 1;
        }
        if (tr[2] === "[*]") {
          touch({ id: ids[1], label: "End", shape: "circle" });
          endCount += 1;
        }
        touch({ id: ids[0], label: null });
        touch({ id: ids[1], label: null });
        for (const n of ids) {
          const item = nodes.get(n);
          if (item.label === n) item.shape = "round";
        }
        edges.push({ from: ids[0], to: ids[1], label: cleanLabel(tr[3] ?? ""), style: "solid", arrow: true, line: false });
        continue;
      }
      const described = /^(\w+)\s*:\s*(.+)$/.exec(line);
      if (described) {
        touch({ id: described[1], label: cleanLabel(described[2]), shape: "round" });
        continue;
      }
      warnings.push(line);
      continue;
    }
    const sg = /^subgraph\s+(.+)$/.exec(line);
    if (sg) {
      const parsed = readNode(sg[1].replace(/^(\S+)\s+(\[)/, "$1$2"));
      const id = parsed?.id ?? `group${groups.length + 1}`;
      groups.push({ id, title: parsed?.label ?? cleanLabel(sg[1]), parent: stack[stack.length - 1] ?? null });
      stack.push(id);
      continue;
    }
    if (line === "end") {
      stack.pop();
      continue;
    }
    if (!parseStatement(line, touch, (edge) => edges.push(edge))) warnings.push(line);
  }
  if (!nodes.size) return { ...empty, error: "No nodes found in the diagram text." };
  const long = [...nodes.keys()].find((id) => id.length > MAX_ID);
  if (long) return { ...empty, error: `Node id ${long.slice(0, 20)}… is longer than ${MAX_ID} characters.` };
  return { ok: true, direction, nodes: [...nodes.values()], edges, groups, warnings };
}

// ---- layout: layered, with barycenter ordering ----

function layerOf(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to) && e.from !== e.to) out.get(e.from).push(e.to);
  // depth-first: back edges (cycles) are ignored for layering
  const layer = new Map();
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const to of out.get(id)) {
      if (state.get(to) === 1) back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  const incoming = new Set(edges.map((e) => e.to));
  for (const n of nodes) if (!incoming.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  const forward = new Map(nodes.map((n) => [n.id, []]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const [from, tos] of out) {
    for (const to of tos) {
      if (back.has(`${from}>${to}`)) continue;
      forward.get(from).push(to);
      indegree.set(to, indegree.get(to) + 1);
    }
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const to of forward.get(id)) {
      layer.set(to, Math.max(layer.get(to) ?? 0, layer.get(id) + 1));
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  return layer;
}

/** Positions every node; returns `{ positions: Map(id -> {x, y, w, h}), width, height }` from (0, 0). */
export function layoutMermaid(parsed) {
  const { nodes, edges, direction } = parsed;
  const layer = layerOf(nodes, edges);
  const layers = [];
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    (layers[l] ??= []).push(n.id);
  }
  const compact = layers.filter(Boolean);
  const order = new Map();
  compact.forEach((ids) => ids.forEach((id, i) => order.set(id, i)));
  const neighbours = (id, toward) => {
    const list = [];
    for (const e of edges) {
      if (toward === "prev" && e.to === id) list.push(e.from);
      if (toward === "next" && e.from === id) list.push(e.to);
    }
    return list.filter((other) => order.has(other));
  };
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const down = sweep % 2 === 0;
    const sequence = down ? compact : [...compact].reverse();
    for (const ids of sequence) {
      const score = (id) => {
        const near = neighbours(id, down ? "prev" : "next");
        return near.length ? near.reduce((sum, other) => sum + order.get(other), 0) / near.length : order.get(id);
      };
      ids.sort((a, b) => score(a) - score(b) || order.get(a) - order.get(b));
      ids.forEach((id, i) => order.set(id, i));
    }
  }
  const horizontal = direction === "LR" || direction === "RL";
  const size = (n) => {
    const lines = n.label.split("\n");
    const longest = Math.max(...lines.map((l) => l.length), 4);
    const w = Math.min(280, Math.max(NODE_W - 40, longest * 8 + 40));
    const h = Math.max(NODE_H, lines.length * 22 + 28);
    return n.shape === "circle" ? { w: 96, h: 96 } : n.shape === "rhombus" ? { w: w + 40, h: h + 24 } : { w, h };
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const positions = new Map();
  let cursor = 0;
  let across = 0;
  const layerExtent = [];
  compact.forEach((ids) => {
    const sizes = ids.map((id) => size(byId.get(id)));
    const depth = Math.max(...sizes.map((s) => (horizontal ? s.w : s.h)));
    let offset = 0;
    ids.forEach((id, i) => {
      const s = sizes[i];
      positions.set(id, { ...s, a: offset, b: cursor, depth });
      offset += (horizontal ? s.h : s.w) + (horizontal ? GAP_Y : GAP_X);
    });
    across = Math.max(across, offset - (horizontal ? GAP_Y : GAP_X));
    layerExtent.push(offset - (horizontal ? GAP_Y : GAP_X));
    cursor += depth + (horizontal ? GAP_X + 40 : GAP_Y + 20);
  });
  const total = cursor - (horizontal ? GAP_X + 40 : GAP_Y + 20);
  const result = new Map();
  compact.forEach((ids, li) => {
    const shift = (across - layerExtent[li]) / 2; // centre each layer
    for (const id of ids) {
      const p = positions.get(id);
      let x = horizontal ? p.b + (p.depth - p.w) / 2 : p.a + shift;
      let y = horizontal ? p.a + shift : p.b + (p.depth - p.h) / 2;
      if (direction === "BT") y = total - y - p.h;
      if (direction === "RL") x = total - x - p.w;
      result.set(id, { x: Math.round(x), y: Math.round(y), w: p.w, h: p.h });
    }
  });
  return { positions: result, width: horizontal ? total : across, height: horizontal ? across : total };
}

// ---- board objects ----

const SHAPE_NODE = {
  rect: { type: "rect" },
  round: { type: "rect", cornerRadius: 14 },
  stadium: { type: "rect", cornerRadius: 32 },
  subroutine: { type: "rect" },
  cylinder: { type: "rect", cornerRadius: 8 },
  flag: { type: "rect" },
  hexagon: { type: "rect", cornerRadius: 22 },
  circle: { type: "ellipse" },
  rhombus: { type: "diamond" },
};

const CODE_SHAPE_TYPES = new Set(Object.values(SHAPE_NODE).map((spec) => spec.type));

/**
 * The Mermaid key of every shape inside `diagramId`, in board order: the key its code gave it, or
 * (for shapes drawn by hand, or a copy whose key is already taken) one derived from its id.
 */
function shapeKeys(nodes, diagramId) {
  const keys = new Map();
  const used = new Set();
  for (const n of nodes) {
    if (n.parentId !== diagramId || !CODE_SHAPE_TYPES.has(n.type)) continue;
    const key = n.mermaidKey && !used.has(n.mermaidKey) ? n.mermaidKey : `id_${n.id.replace(/\W/g, "_")}`;
    used.add(key);
    keys.set(n.id, key);
  }
  return keys;
}

function uuid() {
  return globalThis.crypto.randomUUID();
}

/**
 * Board objects for a parsed diagram: a `diagram` container carrying the source (so it can be
 * edited as text again), its shapes as children and its connectors. `origin` is the world
 * point of the container's top-left corner; `keepId` rebuilds an existing container and `shapeIds`
 * (Mermaid key -> node id) keeps the identity of shapes that survive the rebuild.
 */
export function mermaidToBoardObjects(parsed, origin, { keepId, shapeIds, name = "Mermaid diagram", source = "", status } = {}) {
  const { positions, width, height } = layoutMermaid(parsed);
  const PAD_X = 40;
  const PAD_TOP = 60;
  const PAD_BOTTOM = 40;
  const diagramId = keepId ?? uuid();
  const ids = new Map(parsed.nodes.map((n) => [n.id, shapeIds?.get(n.id) ?? uuid()]));
  const diagram = {
    id: diagramId,
    type: "diagram",
    x: origin.x,
    y: origin.y,
    w: Math.max(320, Math.round(width + PAD_X * 2)),
    h: Math.max(240, Math.round(height + PAD_TOP + PAD_BOTTOM)),
    name,
    fill: "rgba(15, 23, 42, 0.35)",
    stroke: "#6f9bd1",
    strokeWidth: 2,
    layers: [{ id: "layer-main", name: "Core flow", visible: true }],
    containers: [],
    sourceKind: "mermaid",
    source,
    parentId: null,
    groupId: null,
  };
  if (status) diagram.status = status;
  const nodes = [];
  for (const n of parsed.nodes) {
    const p = positions.get(n.id);
    const spec = SHAPE_NODE[n.shape] ?? SHAPE_NODE.rect;
    const node = {
      id: ids.get(n.id),
      type: spec.type,
      x: origin.x + PAD_X + p.x,
      y: origin.y + PAD_TOP + p.y,
      w: p.w,
      h: p.h,
      fill: "#1e293b",
      stroke: "#6f9bd1",
      strokeWidth: 2,
      text: n.label,
      color: "#e2e8f0",
      fontSize: 14,
      align: "center",
      parentId: diagramId,
      groupId: null,
      diagramLayerId: "layer-main",
      mermaidKey: n.id,
    };
    if (spec.cornerRadius) node.cornerRadius = spec.cornerRadius;
    nodes.push(node);
  }
  // subgraphs become sub-containers around their members
  for (const g of parsed.groups) {
    const members = parsed.nodes.filter((n) => insideGroup(n.group, g.id, parsed.groups)).map((n) => positions.get(n.id));
    if (!members.length) continue;
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.w));
    const maxY = Math.max(...members.map((m) => m.y + m.h));
    diagram.containers.push({
      id: `sub-${uuid().slice(0, 8)}`,
      name: g.title,
      x: PAD_X + minX - 16,
      y: PAD_TOP + minY - 28,
      w: maxX - minX + 32,
      h: maxY - minY + 44,
      layerId: "layer-main",
    });
  }
  const connectors = parsed.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      id: uuid(),
      from: { nodeId: ids.get(e.from), anchor: "auto" },
      to: { nodeId: ids.get(e.to), anchor: "auto" },
      kind: e.line && !e.arrow ? "line" : "arrow",
      stroke: "#94a3b8",
      strokeWidth: e.style === "thick" ? 4 : 2,
      shape: "orthogonal",
      ...(e.style === "dashed" ? { strokeStyle: "dashed" } : {}),
      ...(e.arrow ? { endCap: "arrow" } : {}),
      ...(e.label ? { labels: [{ id: uuid(), text: e.label, position: 0.5, orientation: "horizontal" }] } : {}),
    }));
  return { diagram, nodes, connectors, keyToId: ids };
}

function insideGroup(group, target, groups) {
  let current = group;
  while (current) {
    if (current === target) return true;
    current = groups.find((g) => g.id === current)?.parent ?? null;
  }
  return false;
}

// ---- visual -> code ----

function safeLabel(text) {
  return String(text ?? "")
    .replace(/["\n]/g, " ")
    .trim();
}

const OPEN_CLOSE = { rect: ["[", "]"], round: ["(", ")"], circle: ["((", "))"], rhombus: ["{", "}"] };

/** Mermaid source for the shapes inside `diagramId` and the connectors between them, in the direction of its code. */
export function diagramToMermaid(state, diagramId) {
  const ids = shapeKeys(state.nodes, diagramId);
  const nodes = state.nodes.filter((n) => ids.has(n.id));
  const source = state.nodes.find((n) => n.id === diagramId)?.source;
  const out = [`flowchart ${parseMermaid(source).direction}`];
  for (const n of nodes) {
    const kind = n.type === "ellipse" ? "circle" : n.type === "diamond" ? "rhombus" : n.cornerRadius ? "round" : "rect";
    const [open, close] = OPEN_CLOSE[kind];
    out.push(`  ${ids.get(n.id)}${open}"${safeLabel(n.text) || ids.get(n.id)}"${close}`);
  }
  for (const c of state.connectors) {
    const a = ids.get(c.from?.nodeId);
    const b = ids.get(c.to?.nodeId);
    if (!a || !b) continue;
    const label = safeLabel(c.labels?.[0]?.text);
    const arrow = c.kind === "line" ? (c.strokeStyle === "dashed" ? "-.-" : "---") : c.strokeStyle === "dashed" ? "-.->" : c.strokeWidth >= 4 ? "==>" : "-->";
    out.push(`  ${a} ${arrow}${label ? `|${label}|` : ""} ${b}`);
  }
  return out.join("\n");
}

/**
 * The board changes that rebuild diagram `diagramId` from new text. The code describes the shapes
 * it built and any shape whose key it names; those are rebuilt (keeping their ids when their key
 * survives) along with the connectors between them. Other children, and connectors whose ends
 * still exist, stay.
 */
export function replaceDiagramContent(state, diagramId, parsed, source) {
  const diagram = state.nodes.find((n) => n.id === diagramId);
  if (!diagram) return state;
  const newKeys = new Set(parsed.nodes.map((n) => n.id));
  const described = new Map();
  for (const [id, key] of shapeKeys(state.nodes, diagramId)) {
    const node = state.nodes.find((n) => n.id === id);
    if (key === node.mermaidKey || newKeys.has(key)) described.set(id, key);
  }
  const shapeIds = new Map([...described].filter(([, key]) => newKeys.has(key)).map(([id, key]) => [key, id]));
  const built = mermaidToBoardObjects(parsed, { x: diagram.x, y: diagram.y }, {
    keepId: diagramId,
    shapeIds,
    name: diagram.name,
    source,
    status: diagram.status,
  });
  const remaining = state.nodes.filter((n) => !described.has(n.id));
  const present = new Set([...remaining, ...built.nodes].map((n) => n.id));
  const nextDiagram = { ...diagram, w: Math.max(diagram.w, built.diagram.w), h: Math.max(diagram.h, built.diagram.h), containers: built.diagram.containers, source, sourceKind: "mermaid" };
  return {
    ...state,
    nodes: [...remaining.map((n) => (n.id === diagramId ? nextDiagram : n)), ...built.nodes],
    connectors: [
      ...state.connectors.filter((c) => {
        const [from, to] = [c.from?.nodeId, c.to?.nodeId];
        if (described.has(from) && described.has(to)) return false;
        return (from == null || present.has(from)) && (to == null || present.has(to));
      }),
      ...built.connectors,
    ],
  };
}
