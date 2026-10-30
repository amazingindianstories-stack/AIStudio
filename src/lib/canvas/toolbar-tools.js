/**
 * The creation tools in the board's tool dock and each person's own
 * arrangement of them: which are pinned and in what order. Select and Hand
 * always lead the dock; number keys 1 to 9 pick tools in dock order.
 */

export const NAVIGATION_TOOLS = ["select", "hand"];

/** Every creation tool the dock can show, in the default order. */
export const CREATION_TOOLS = [
  { id: "sticky", label: "Sticky note" },
  { id: "text", label: "Text" },
  { id: "shapes", label: "Shapes" },
  { id: "frame", label: "Frame" },
  { id: "connector", label: "Connector" },
  { id: "image", label: "Add image" },
  { id: "ai", label: "Create with AI" },
];

const KNOWN = new Set(CREATION_TOOLS.map((t) => t.id));

/**
 * All creation tools in the person's order: their saved order first (tools
 * that no longer exist dropped), then any tool they have not placed yet in
 * the default order, so a newly added tool shows up.
 */
export function orderedTools(prefs) {
  const saved = (prefs?.toolbarOrder ?? []).filter((id, i, all) => KNOWN.has(id) && all.indexOf(id) === i);
  const rest = CREATION_TOOLS.map((t) => t.id).filter((id) => !saved.includes(id));
  return [...saved, ...rest];
}

/** The pinned creation tools, in dock order. */
export function pinnedTools(prefs) {
  const hidden = new Set(prefs?.toolbarHidden ?? []);
  return orderedTools(prefs).filter((id) => !hidden.has(id));
}

/** The dock's tools in order as number keys count them; editors also get the creation tools. */
export function dockTools(prefs, canEdit) {
  return canEdit ? [...NAVIGATION_TOOLS, ...pinnedTools(prefs)] : [...NAVIGATION_TOOLS];
}

/** The preference patch that pins or unpins `id`. */
export function togglePinned(prefs, id) {
  const hidden = new Set(prefs?.toolbarHidden ?? []);
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  return { toolbarHidden: CREATION_TOOLS.map((t) => t.id).filter((tool) => hidden.has(tool)) };
}

/** The preference patch that moves `id` by `step` places (-1 earlier, 1 later) among all creation tools. */
export function moveTool(prefs, id, step) {
  const order = orderedTools(prefs);
  const from = order.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return { toolbarOrder: order };
  order.splice(from, 1);
  order.splice(to, 0, id);
  return { toolbarOrder: order };
}

/** The preference patch that puts `id` before `beforeId` (null: last), for drag and drop. */
export function placeToolBefore(prefs, id, beforeId) {
  const order = orderedTools(prefs).filter((tool) => tool !== id);
  const at = beforeId == null ? -1 : order.indexOf(beforeId);
  if (at < 0) order.push(id);
  else order.splice(at, 0, id);
  return { toolbarOrder: order };
}

export function toolLabel(id) {
  if (id === "select") return "Select";
  if (id === "hand") return "Hand";
  return CREATION_TOOLS.find((t) => t.id === id)?.label ?? id;
}
