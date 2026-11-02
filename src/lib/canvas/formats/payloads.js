/**
 * Load-on-demand of format payloads (Docs blocks, HTML, draw.io XML and preview). The board graph holds only
 * `payload: { size, rev }` on those nodes; the fields come from `GET /api/canvas-boards/:id/payloads/:node`
 * when a node is opened or scrolls into view, so a board never needs every payload to render. The server keeps
 * the stored row for a node saved without its fields, so an unloaded node saves safely.
 */
export const PAYLOAD_PROBE = { doc: "blocks", html: "html", drawio: "xml" };
const FIELDS = { doc: ["blocks", "suggestions"], html: ["html"], drawio: ["xml", "preview"] };

/** True for a format node whose large fields are stored outside the board and not yet loaded. */
export function needsPayload(node) {
  return node?.type === "format" && Boolean(node.payload) && Boolean(PAYLOAD_PROBE[node.format]) && !(PAYLOAD_PROBE[node.format] in node);
}

/** The node with the fields of a loaded payload, shaped as validation shapes them (no empty suggestions or preview). */
export function withPayload(node, loaded) {
  if (!node || !loaded || loaded.kind !== node.format) return node;
  const next = { ...node, payload: { size: loaded.size, rev: loaded.rev } };
  for (const field of FIELDS[node.format]) {
    const value = loaded[field];
    const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
    if (!empty) next[field] = value;
    else if (field === PAYLOAD_PROBE[node.format]) next[field] = field === "blocks" ? [] : "";
  }
  return next;
}

/**
 * A loader that asks the server once per node and revision, however many components want the same payload:
 * `load(node)` resolves with the loaded fields (or null when there is nothing to load), and a failed request
 * may be retried. `fetchPayload(nodeId)` returns the parsed response.
 */
export function createPayloadLoader(fetchPayload) {
  const pending = new Map();
  const done = new Map();
  return {
    load(node) {
      if (!node?.payload) return Promise.resolve(null);
      const key = `${node.id}@${node.payload.rev}`;
      if (done.has(key)) return Promise.resolve(done.get(key));
      if (!pending.has(key)) {
        pending.set(key, fetchPayload(node.id).then(
          (loaded) => { pending.delete(key); done.set(key, loaded); return loaded; },
          (error) => { pending.delete(key); throw error; },
        ));
      }
      return pending.get(key);
    },
    /** Forget what was loaded for a node (it changed on the server or was deleted). */
    forget(nodeId) {
      for (const key of [...done.keys(), ...pending.keys()]) if (key.startsWith(`${nodeId}@`)) { done.delete(key); pending.delete(key); }
    },
  };
}

/** The ids of nodes among `nodes` that are in view (`isVisible`) and still need their payload, at most `limit`. */
export function payloadsToLoad(nodes, isVisible, limit = 20) {
  const ids = [];
  for (const node of nodes) {
    if (ids.length >= limit) break;
    if (needsPayload(node) && isVisible(node)) ids.push(node.id);
  }
  return ids;
}
