import { useCanvasStore } from "../../canvas-store";
import { isLocked } from "../locks";
import { defaultViewPatches } from "./model";

/** Edits format `id` with `compute(node)`; a locked format is left as it is. */
export function patchFormat(id, compute, opts) {
  useCanvasStore.getState().editBoard((graph) => ({ ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== id || isLocked(graph, node)) return node;
      const next = { ...node, ...compute(node) };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return next;
    }),
  }), opts);
}

export function setDefaultFormat(id, on, locked) {
  useCanvasStore.getState().editBoard((graph) => {
    const patches = defaultViewPatches(graph.nodes, id, { on, locked });
    if (patches.some((item) => isLocked(graph, item.id))) return graph;
    return { ...graph, nodes: graph.nodes.map((node) => {
      const patch = patches.find((item) => item.id === node.id)?.patch;
      if (!patch) return node;
      const next = { ...node, ...patch };
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
      return next;
    }) };
  });
}

export function openFormat(id) {
  window.dispatchEvent(new CustomEvent("board-format-open", { detail: id }));
}

export function formatUrl(boardId, id) {
  const url = new URL(window.location.href);
  url.searchParams.set("board", boardId);
  url.searchParams.set("focus", id);
  return url.href;
}
