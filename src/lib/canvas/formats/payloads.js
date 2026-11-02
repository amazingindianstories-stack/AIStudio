/**
 * Load-on-demand of format payloads (Docs blocks, HTML, draw.io XML and preview). The editor reads its board
 * with `?payloads=lazy`, so those nodes hold only `payload: { size, rev }`; the fields come from
 * `GET /api/canvas-boards/:id/payloads/:node` when a node is rendered (on screen) or opened, so a board never
 * needs every payload at once. The server keeps the stored row for a node saved without its fields, so a save
 * sends a payload only when it changed (`slimGraph`), and the save's stamps carry the node's new reference.
 */
export const PAYLOAD_PROBE = { doc: "blocks", html: "html", drawio: "xml" };
export const PAYLOAD_FIELDS = { doc: ["blocks", "suggestions"], html: ["html"], drawio: ["xml", "preview"] };

function stored(node) {
  return node?.type === "format" && Boolean(node.payload) && Boolean(PAYLOAD_PROBE[node.format]);
}

/** True for a format node whose large fields are stored outside the board and not yet loaded. */
export function needsPayload(node) {
  return stored(node) && !(PAYLOAD_PROBE[node.format] in node);
}

/** The node with the fields of a loaded payload, shaped as validation shapes them (no empty suggestions or preview). */
export function withPayload(node, loaded) {
  if (!node || !loaded || loaded.kind !== node.format) return node;
  const next = { ...node, payload: { size: loaded.size, rev: loaded.rev } };
  for (const field of PAYLOAD_FIELDS[node.format]) {
    const value = loaded[field];
    const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
    if (!empty) next[field] = value;
    else if (field === PAYLOAD_PROBE[node.format]) next[field] = field === "blocks" ? [] : "";
  }
  return next;
}

function withoutFields(node) {
  const next = { ...node };
  for (const field of PAYLOAD_FIELDS[node.format]) delete next[field];
  return next;
}

function sameFields(a, b) {
  return PAYLOAD_FIELDS[a.format].every((field) => a[field] === b[field] || JSON.stringify(a[field]) === JSON.stringify(b[field]));
}

function mapNodes(graph, map) {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const next = map(node);
    if (next !== node) changed = true;
    return next;
  });
  return changed ? { ...graph, nodes } : graph;
}

/** `graph` with node `nodeId` filled from `loaded` where it still needs that revision of its payload. */
export function withLoadedPayload(graph, nodeId, loaded) {
  if (!graph?.nodes) return graph;
  return mapNodes(graph, (node) => (node.id === nodeId && needsPayload(node) && node.payload.rev === loaded?.rev ? withPayload(node, loaded) : node));
}

/** `graph` (a board just read without payloads) with each unloaded node filled from `base`'s loaded copy at the same revision. */
export function carryPayloads(graph, base) {
  const loaded = new Map();
  for (const node of base?.nodes ?? []) if (stored(node) && !needsPayload(node)) loaded.set(node.id, node);
  if (!loaded.size) return graph;
  return mapNodes(graph, (node) => {
    const from = needsPayload(node) ? loaded.get(node.id) : null;
    if (!from || from.format !== node.format || from.payload.rev !== node.payload.rev) return node;
    const next = { ...node };
    for (const field of PAYLOAD_FIELDS[node.format]) if (field in from) next[field] = from[field];
    return next;
  });
}

/**
 * `graph` as a save or a pending draft holds it: a node keeps its payload fields only when they differ from the
 * same node in `base` (the synced graph), so an unchanged or unloaded payload travels as its reference alone.
 */
export function slimGraph(graph, base) {
  const synced = new Map();
  for (const node of base?.nodes ?? []) if (stored(node)) synced.set(node.id, node);
  return mapNodes(graph, (node) => {
    if (!stored(node) || needsPayload(node)) return node;
    const from = synced.get(node.id);
    return from && from.format === node.format && !needsPayload(from) && sameFields(node, from) ? withoutFields(node) : node;
  });
}

/** The JSON length of `graph` without any format payload fields: what the board's 2 Mi limit measures. */
export function slimLength(graph) {
  const nodes = graph.nodes.map((node) => (node?.type === "format" && PAYLOAD_FIELDS[node.format] ? withoutFields(node) : node));
  return JSON.stringify({ ...graph, nodes }).length;
}

/**
 * A loader that asks the server once at a time per board, node and revision, however many components want the
 * same payload: `load(boardId, node)` resolves with the loaded fields (or null when there is nothing to load),
 * and a failed request may be retried. `fetchPayload(boardId, nodeId)` returns the parsed response.
 */
export function createPayloadLoader(fetchPayload) {
  const pending = new Map();
  return {
    load(boardId, node) {
      if (!boardId || !needsPayload(node)) return Promise.resolve(null);
      const key = `${boardId}/${node.id}@${node.payload.rev}`;
      if (!pending.has(key)) {
        pending.set(key, fetchPayload(boardId, node.id).finally(() => pending.delete(key)));
      }
      return pending.get(key);
    },
  };
}
