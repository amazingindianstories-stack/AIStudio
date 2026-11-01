import { isContainerNode, reparented } from "../geometry";
import { isLocked } from "../locks";
import { clipText } from "../rich-text";
import { MAX_NAME, MAX_SLIDES } from "./model";

export function moveSlide(slides, id, delta) {
  const from = slides.findIndex((slide) => slide.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= slides.length) return slides;
  const next = [...slides];
  const [slide] = next.splice(from, 1);
  next.splice(to, 0, slide);
  return next;
}

export function frameContents(graph, id) {
  const ids = new Set([id]);
  let previous;
  do {
    previous = ids.size;
    for (const node of graph.nodes) if (ids.has(node.parentId)) ids.add(node.id);
  } while (previous !== ids.size);
  return { nodes: graph.nodes.filter((node) => ids.has(node.id)), connectors: graph.connectors.filter((edge) => ids.has(edge.from?.nodeId) && ids.has(edge.to?.nodeId)) };
}

export function addSlide(slides, frame, lane = "main") {
  if (!frame || frame.type !== "frame" || slides.length >= MAX_SLIDES) return slides;
  return [...slides, { id: crypto.randomUUID(), title: clipText(frame.name || "Slide", MAX_NAME), frameId: frame.id, lane, notes: "" }];
}

/** Places plain, unlocked board object `id` in `frame`; containers and formats never nest inside a slide. */
export function moveIntoFrame(graph, id, frame) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || !frame || node.type === "format" || isContainerNode(node) || isLocked(graph, node)) return graph;
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...reparented(n, frame.id), x: frame.x + 40, y: frame.y + 60 } : n)) };
}
