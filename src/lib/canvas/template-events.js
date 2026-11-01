/**
 * How parts of the board (toolbar, context menu, tool panels) ask the templates host to open something, without
 * the host's state living in CanvasView. `detail.action` is `open` (with an optional `tool`, `ref`),
 * `save-board`, `save-selection` or `scratch`.
 */
const EVENT = "veevee:templates";

export function requestTemplates(detail = { action: "open" }) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

export function onTemplatesRequest(handler) {
  const listener = (event) => handler(event.detail ?? { action: "open" });
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
