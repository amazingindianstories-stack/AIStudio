import { useCanvasStore } from "../../canvas-store";
import { defaultViewPatches } from "./model";

export function patchFormat(id, compute, opts) {
  useCanvasStore.getState().editBoard((graph) => ({ ...graph,
    nodes: graph.nodes.map((node) => node.id === id ? { ...node, ...compute(node) } : node),
  }), opts);
}

export function setDefaultFormat(id, on, locked) {
  useCanvasStore.getState().editBoard((graph) => {
    const patches = defaultViewPatches(graph.nodes, id, { on, locked });
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
