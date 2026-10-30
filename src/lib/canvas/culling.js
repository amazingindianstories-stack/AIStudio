/**
 * Viewport culling: which nodes and connectors the board mounts.
 *
 * A board of thousands of objects mounts only those whose bounds meet the
 * visible world rectangle grown by a screen-space overscan, so panning shows
 * nearby objects at once and off-screen media never loads. Culling only
 * decides what is mounted: every feature that works on the board (select all,
 * marquee, align, copy, export, fit, minimap, search, jump-to-object, AI
 * placement) reads the whole graph from the store.
 *
 * Always mounted, wherever they are: the selection (so dragging, resizing and
 * keyboard moves keep their element), the node being text-edited or cropped,
 * any extra ids the caller pins (a connector's hover target), and both
 * endpoints of every mounted connector.
 */

/** Screen pixels mounted beyond each edge of the viewport. */
export const CULL_OVERSCAN_PX = 900;
/** How far a connector's curve can bow outside the box of its two ends (see connectorPath). */
const CONNECTOR_BOW = 60;

/** The world rectangle {left, top, right, bottom} mounted for `viewport` at screen `size`. */
export function cullRect(viewport, size, overscanPx = CULL_OVERSCAN_PX) {
  const margin = overscanPx / viewport.zoom;
  return {
    left: viewport.x - margin,
    top: viewport.y - margin,
    right: viewport.x + size.w / viewport.zoom + margin,
    bottom: viewport.y + size.h / viewport.zoom + margin,
  };
}

function meets(rect, left, top, right, bottom) {
  return right >= rect.left && left <= rect.right && bottom >= rect.top && top <= rect.bottom;
}

/** The world box an endpoint can attach anywhere in: its node's bounds, or its free point. */
function endpointBox(ep, nodesById) {
  if (!("nodeId" in ep)) return { x: ep.x, y: ep.y, w: 0, h: 0 };
  return nodesById[ep.nodeId] ?? null;
}

function connectorMeets(rect, connector, nodesById) {
  const a = endpointBox(connector.from, nodesById);
  const b = endpointBox(connector.to, nodesById);
  if (!a || !b) return false;
  return meets(
    rect,
    Math.min(a.x, b.x) - CONNECTOR_BOW,
    Math.min(a.y, b.y) - CONNECTOR_BOW,
    Math.max(a.x + a.w, b.x + b.w) + CONNECTOR_BOW,
    Math.max(a.y + a.h, b.y + b.h) + CONNECTOR_BOW
  );
}

/** `node` and its `parentId` ancestors, nearest first; stops on a missing parent or a cycle. */
function* selfAndAncestors(node, byId) {
  const seen = new Set();
  for (let current = node; current && !seen.has(current.id); current = byId.get(current.parentId)) {
    seen.add(current.id);
    yield current;
  }
}

function hasHiddenLayer(node) {
  return node.type === "diagram" && Array.isArray(node.layers) && node.layers.some((layer) => layer?.visible === false);
}

/** Nodes on a layer that their own (nearest enclosing) diagram hides. */
export function hiddenDiagramLayerNodeIds(nodes = []) {
  const hidden = new Set();
  if (!nodes.some(hasHiddenLayer)) return hidden;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (!node.diagramLayerId) continue;
    let diagram = null;
    for (const ancestor of selfAndAncestors(byId.get(node.parentId), byId)) {
      if (ancestor.type === "diagram") {
        diagram = ancestor;
        break;
      }
    }
    if (diagram && Array.isArray(diagram.layers) && diagram.layers.some((layer) => layer?.id === node.diagramLayerId && layer.visible === false)) {
      hidden.add(node.id);
    }
  }
  return hidden;
}

/**
 * The node and connector ids the board hides: nodes on a hidden diagram layer and, in Focus mode
 * (`focusDiagramId`, local view state), everything outside the focused diagram. A node is inside
 * when the diagram is one of its ancestors or its center lies within the diagram's bounds. A
 * connector hides with either end; in Focus mode a free end hides it when it lies outside the diagram.
 */
export function hiddenBoardIds(graph, focusDiagramId = null) {
  const nodes = hiddenDiagramLayerNodeIds(graph.nodes);
  const connectors = new Set();
  const focus = focusDiagramId ? graph.nodes.find((node) => node.id === focusDiagramId && node.type === "diagram") : null;
  const inFocus = (x, y) => x >= focus.x && x <= focus.x + focus.w && y >= focus.y && y <= focus.y + focus.h;
  if (focus) {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes) {
      let inside = inFocus(node.x + node.w / 2, node.y + node.h / 2);
      for (const ancestor of selfAndAncestors(node, byId)) {
        if (ancestor.id === focus.id) {
          inside = true;
          break;
        }
      }
      if (!inside) nodes.add(node.id);
    }
  } else if (nodes.size === 0) {
    return { nodes, connectors };
  }
  const endHidden = (ep) =>
    "nodeId" in ep
      ? nodes.has(ep.nodeId)
      : !!focus && !inFocus(ep.x, ep.y);
  for (const connector of graph.connectors) {
    if (endHidden(connector.from) || endHidden(connector.to)) connectors.add(connector.id);
  }
  return { nodes, connectors };
}

/**
 * The nodes and connectors to mount, each in board (z-)order.
 * `keep` holds the always-mounted ids: `nodeIds` (an iterable) and
 * `connectorIds` (an iterable). `hidden` (see hiddenBoardIds) is never mounted.
 */
export function cullBoard(graph, nodesById, viewport, size, keep = {}, hidden = hiddenBoardIds(graph)) {
  const rect = cullRect(viewport, size);
  const keptNodes = new Set(keep.nodeIds ?? []);
  const keptConnectors = new Set(keep.connectorIds ?? []);
  const connectors = graph.connectors.filter((connector) => {
    if (hidden.connectors.has(connector.id)) return false;
    if (!keptConnectors.has(connector.id) && !connectorMeets(rect, connector, nodesById)) return false;
    if ("nodeId" in connector.from) keptNodes.add(connector.from.nodeId);
    if ("nodeId" in connector.to) keptNodes.add(connector.to.nodeId);
    return true;
  });
  const nodes = graph.nodes.filter(
    (node) =>
      !hidden.nodes.has(node.id) &&
      (keptNodes.has(node.id) || meets(rect, node.x, node.y, node.x + node.w, node.y + node.h))
  );
  return { nodes, connectors };
}
