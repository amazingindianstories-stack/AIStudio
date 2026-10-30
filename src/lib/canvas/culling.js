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

export function hiddenDiagramLayerNodeIds(nodes = []) {
  const hiddenLayersByDiagram = new Map();
  const globalHiddenLayers = new Set();
  for (const node of nodes) {
    if (node.type === "diagram" && Array.isArray(node.layers)) {
      const set = new Set();
      for (const layer of node.layers) {
        if (layer && layer.visible === false && typeof layer.id === "string") {
          set.add(layer.id);
          globalHiddenLayers.add(layer.id);
        }
      }
      if (set.size > 0) hiddenLayersByDiagram.set(node.id, set);
    }
  }
  const hiddenNodeIds = new Set();
  if (globalHiddenLayers.size === 0) return hiddenNodeIds;
  for (const node of nodes) {
    if (!node.diagramLayerId) continue;
    if (node.parentId && hiddenLayersByDiagram.has(node.parentId)) {
      if (hiddenLayersByDiagram.get(node.parentId).has(node.diagramLayerId)) {
        hiddenNodeIds.add(node.id);
      }
    } else if (globalHiddenLayers.has(node.diagramLayerId)) {
      hiddenNodeIds.add(node.id);
    }
  }
  return hiddenNodeIds;
}

/**
 * The nodes and connectors to mount, each in board (z-)order.
 * `keep` holds the always-mounted ids: `nodeIds` (an iterable) and
 * `connectorIds` (an iterable).
 */
export function cullBoard(graph, nodesById, viewport, size, keep = {}) {
  const rect = cullRect(viewport, size);
  const hiddenNodes = hiddenDiagramLayerNodeIds(graph.nodes);
  const keptNodes = new Set(keep.nodeIds ?? []);
  const keptConnectors = new Set(keep.connectorIds ?? []);
  const connectors = graph.connectors.filter((connector) => {
    if ("nodeId" in connector.from && hiddenNodes.has(connector.from.nodeId)) return false;
    if ("nodeId" in connector.to && hiddenNodes.has(connector.to.nodeId)) return false;
    if (!keptConnectors.has(connector.id) && !connectorMeets(rect, connector, nodesById)) return false;
    if ("nodeId" in connector.from) keptNodes.add(connector.from.nodeId);
    if ("nodeId" in connector.to) keptNodes.add(connector.to.nodeId);
    return true;
  });
  const nodes = graph.nodes.filter(
    (node) =>
      !hiddenNodes.has(node.id) &&
      (keptNodes.has(node.id) || meets(rect, node.x, node.y, node.x + node.w, node.y + node.h))
  );
  return { nodes, connectors };
}
