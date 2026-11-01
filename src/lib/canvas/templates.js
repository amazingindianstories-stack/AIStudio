/**
 * Board templates on the client: the pure graph helpers (insert with fresh ids, clear content, graph of a selection,
 * size check) and the API calls. Mirrors backend/apps/canvas/templates.py. Everything works from the board data,
 * never from the DOM, so it behaves the same for objects the viewport culling is not drawing.
 */
import { apiFetch } from "../api";
import { MAX_TAGS } from "./tags";
import { STAMP_KEYS } from "./serialization";
import { unstamped } from "./stamps";

/** A board's data may not exceed 2 Mi UTF-16 units of JSON (backend MAX_BOARD_JSON_UNITS). */
export const MAX_BOARD_UNITS = 2 * 1024 * 1024;
/** Clearing a selection blanks these (a blank template, which only blanks stickies, is made on the server). */
export const CLEAR_TYPES = ["sticky", "text", "shape"];
const CLEAR_KEYS = ["tagIds", "reactions", "marks", "showAuthor", ...STAMP_KEYS];
export const TEMPLATE_CATEGORY_LABELS = {
  "research-design": "Research and design",
  "strategy-planning": "Strategy and planning",
  diagramming: "Diagramming",
  ideation: "Ideation and brainstorming",
  agile: "Agile workflows",
  presentation: "Presentations",
  meetings: "Meetings and workshops",
  wireframing: "Wireframing",
  "image-creation": "Image and video creation",
  other: "Other",
};
export const TEMPLATE_COLLECTIONS = [
  { id: "all", label: "All templates" },
  { id: "featured", label: "Featured" },
  { id: "new", label: "New" },
  { id: "popular", label: "Popular" },
  { id: "ai-accelerated", label: "AI-accelerated" },
];
export const SHOW_PICKER_KEY = "veevee.canvas.showTemplatePicker";

/** `nodes` with the text, tags, emoji votes and stamps of those of `types` removed, styles kept. */
export function clearNodeContent(nodes, types) {
  return nodes.map((node) => {
    if (!types.includes(node.type)) return node;
    if (!node.text && !CLEAR_KEYS.some((key) => key in node)) return node;
    const next = { ...node };
    for (const key of CLEAR_KEYS) delete next[key];
    if ("text" in next) next.text = "";
    return next;
  });
}

function bounds(nodes) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.w);
    bottom = Math.max(bottom, node.y + node.h);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * What inserting `graph` adds to `present`: copies with fresh node, connector and group ids (every parent, group,
 * tail and connector end remapped), centred on `center`, with the graph's tags merged into the board's by name.
 * Returns `{ nodes, connectors, tags, ids }`; `ids` are the new node ids, for selecting them.
 */
export function templateInsertion(present, graph, center, newId = () => crypto.randomUUID()) {
  const source = graph.nodes;
  const box = source.length ? bounds(source) : { left: 0, top: 0, width: 0, height: 0 };
  const dx = Math.round(center.x - (box.left + box.width / 2));
  const dy = Math.round(center.y - (box.top + box.height / 2));
  const ids = new Map(source.map((node) => [node.id, newId()]));
  const groups = new Map();
  const tags = [...(present.tags ?? [])];
  const tagIds = new Map();
  for (const tag of graph.tags ?? []) {
    const existing = tags.find((item) => item.name.trim().toLowerCase() === tag.name.trim().toLowerCase());
    if (existing) tagIds.set(tag.id, existing.id);
    else if (tags.length < MAX_TAGS) {
      const id = newId();
      tags.push({ ...tag, id });
      tagIds.set(tag.id, id);
    }
  }
  const nodes = source.map((node) => {
    const copy = { ...unstamped(node), id: ids.get(node.id), x: node.x + dx, y: node.y + dy };
    copy.parentId = node.parentId ? ids.get(node.parentId) ?? null : null;
    if (node.groupId) {
      if (!groups.has(node.groupId)) groups.set(node.groupId, newId());
      copy.groupId = groups.get(node.groupId);
    } else copy.groupId = null;
    if (node.tail && typeof node.tail === "object" && "nodeId" in node.tail) {
      if (ids.has(node.tail.nodeId)) copy.tail = { ...node.tail, nodeId: ids.get(node.tail.nodeId) };
      else delete copy.tail;
    }
    if (Array.isArray(node.tagIds)) copy.tagIds = node.tagIds.map((id) => tagIds.get(id)).filter(Boolean);
    return copy;
  });
  const connectors = (graph.connectors ?? []).map((connector) => {
    const copy = { ...unstamped(connector), id: newId() };
    for (const end of ["from", "to"]) {
      if ("nodeId" in connector[end]) copy[end] = { ...connector[end], nodeId: ids.get(connector[end].nodeId) };
      else copy[end] = { ...connector[end], x: connector[end].x + dx, y: connector[end].y + dy };
    }
    return copy;
  });
  return { nodes, connectors, tags, ids: nodes.map((node) => node.id) };
}

/** The board after inserting a template (`next`, the new node `ids`), and whether it would pass the 2 Mi board size cap. */
export function insertTemplate(present, graph, center, newId) {
  const added = templateInsertion(present, graph, center, newId);
  const next = {
    ...present,
    nodes: [...present.nodes, ...added.nodes],
    connectors: [...present.connectors, ...added.connectors],
    ...(added.tags.length ? { tags: added.tags } : {}),
  };
  return { next, ids: added.ids, tooLarge: JSON.stringify(next).length > MAX_BOARD_UNITS };
}

/**
 * The graph of the selected objects: those objects, everything inside a selected frame, the connectors between them,
 * and the tags they use. Stamps are dropped; ids stay (instantiation gives new ones).
 */
export function selectionGraph(present, selection) {
  const wanted = new Set(selection);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of present.nodes) {
      if (!wanted.has(node.id) && node.parentId && wanted.has(node.parentId)) {
        wanted.add(node.id);
        grew = true;
      }
    }
  }
  const nodes = present.nodes.filter((node) => wanted.has(node.id)).map(unstamped);
  const connectors = present.connectors
    .filter((connector) => {
      const ends = [connector.from, connector.to].filter((end) => "nodeId" in end);
      return ends.length > 0 && ends.every((end) => wanted.has(end.nodeId));
    })
    .map(unstamped);
  const used = new Set(nodes.flatMap((node) => node.tagIds ?? []));
  const tags = (present.tags ?? []).filter((tag) => used.has(tag.id));
  return { version: 1, nodes, connectors, ...(tags.length ? { tags } : {}) };
}

/** `present` with the text, tags and votes of the selected sticky, text and shape objects cleared; other selected objects stay as they are. */
export function clearSelection(present, selection) {
  const wanted = new Set(selection);
  const nodes = present.nodes.map((node) => (wanted.has(node.id) ? clearNodeContent([node], CLEAR_TYPES)[0] : node));
  return nodes.some((node, index) => node !== present.nodes[index]) ? { ...present, nodes } : present;
}

/** The picker category each tool panel's shortcut opens on. Table and mind map tools depend on the Docs and media slice. */
export const TOOL_CATEGORIES = { shapes: "diagramming", sticky: "ideation", ai: "image-creation", frame: "strategy-planning" };

/** The templates a tool panel's shortcut offers: those of the tool's category. */
export function templatesForTool(templates, tool) {
  const category = TOOL_CATEGORIES[tool];
  return category ? templates.filter((template) => template.category === category) : templates;
}

/** The view of the picker: filters `templates` by `collection` or `category`, then by `query` over name, tags and description. */
export function filterTemplates(templates, { query = "", category = "all", collection = "all", mine = false } = {}) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    if (mine && template.kind !== "custom") return false;
    if (collection === "featured" && !template.featured) return false;
    if (collection === "new" && !template.collections.includes("new") && !template.featured) return false;
    if (collection === "popular" && !(template.collections.includes("popular") || template.uses > 0)) return false;
    if (collection === "ai-accelerated" && !template.collections.includes("ai-accelerated")) return false;
    if (category !== "all" && template.category !== category) return false;
    const haystack = `${template.name} ${template.description} ${template.tags.join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The `?template=<id>` link to a template. */
export function templateLink(origin, ref) {
  return `${origin}/?template=${encodeURIComponent(ref)}`;
}

/** The template ref a page address asks for (`?template=<id>`), or null. */
export function templateRefFromSearch(search) {
  const ref = new URLSearchParams(search).get("template");
  return ref && /^(builtin:[a-z0-9-]+|[0-9a-f-]{36})$/.test(ref) ? ref : null;
}

// ---- API ------------------------------------------------------------------------------------------------------

async function call(path, { method = "GET", body } = {}) {
  const response = await apiFetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error || "Something went wrong."), { status: response.status });
  return json;
}

export const templateApi = {
  list: (projectId) => call(`/api/canvas-templates${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  get: (ref) => call(`/api/canvas-templates/${encodeURIComponent(ref)}`),
  create: (body) => call("/api/canvas-templates", { method: "POST", body }),
  update: (ref, body) => call(`/api/canvas-templates/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  remove: (ref) => call(`/api/canvas-templates/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  restore: (ref) => call(`/api/canvas-templates/${encodeURIComponent(ref)}`, { method: "PATCH", body: { deleted: false } }),
  forBoard: (boardId) => call(`/api/canvas-templates/by-board/${encodeURIComponent(boardId)}`),
  editBoard: (ref, projectId) => call(`/api/canvas-templates/${encodeURIComponent(ref)}/edit-board`, { method: "POST", body: { projectId } }),
  use: (ref, boardId) => call(`/api/canvas-templates/${encodeURIComponent(ref)}/use`, { method: "POST", body: { boardId } }),
  like: (ref, liked) => call(`/api/canvas-templates/${encodeURIComponent(ref)}/like`, { method: "POST", body: { liked } }),
  comments: (ref) => call(`/api/canvas-templates/${encodeURIComponent(ref)}/comments`),
  addComment: (ref, body) => call(`/api/canvas-templates/${encodeURIComponent(ref)}/comments`, { method: "POST", body: { body } }),
  usage: () => call("/api/admin/template-usage"),
  blueprints: (projectId) => call(`/api/canvas-blueprints${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createBlueprint: (body) => call("/api/canvas-blueprints", { method: "POST", body }),
  updateBlueprint: (ref, body) => call(`/api/canvas-blueprints/${encodeURIComponent(ref)}`, { method: "PATCH", body }),
  removeBlueprint: (ref) => call(`/api/canvas-blueprints/${encodeURIComponent(ref)}`, { method: "DELETE" }),
  useBlueprint: (ref, name) => call(`/api/canvas-blueprints/${encodeURIComponent(ref)}/use`, { method: "POST", body: { name } }),
};

/** Whether the picker opens on every new board (a personal preference, kept in this browser). */
export function readShowPicker(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    return storage?.getItem(SHOW_PICKER_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowPicker(value, storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    storage?.setItem(SHOW_PICKER_KEY, value ? "1" : "0");
  } catch {
    // Private mode: the preference just does not stick.
  }
}
