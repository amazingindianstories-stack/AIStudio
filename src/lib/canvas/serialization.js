/**
 * Defensive load/migration + defaults for the canvas board's jsonb blob.
 * `validateCanvasState` NEVER throws — any input, including non-object
 * garbage (null/undefined/a string/a number/an array), coerces to a
 * well-formed CanvasState (falling back to `emptyCanvasState()` when there
 * is nothing to coerce from). This matches "one bad board can't
 * white-screen the app" for both load AND save; the PUT route's own 400
 * for malformed bodies is a shape check it does itself before calling in
 * (see [id]/route.ts), not a thrown error from this function.
 */
import {
  CANVAS_STATE_VERSION,

} from "./types";
import { validateMarks } from "./rich-text";
import { SHAPE_KIND_PATTERN } from "./shapes";

export function emptyCanvasState() {
  return {
    version: CANVAS_STATE_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    connectors: [],
  };
}

const NODE_TYPES = new Set([
  "rect",
  "ellipse",
  "triangle",
  "diamond",
  "shape",
  "text",
  "sticky",
  "frame",
  "image",
]);
const ANCHORS = new Set([
  "auto",
  "top",
  "right",
  "bottom",
  "left",
  "center",
]);

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function str(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
function num(v, fallback) {
  return isFiniteNumber(v) ? v : fallback;
}
function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function validateViewport(raw) {
  if (raw == null || typeof raw !== "object") return { x: 0, y: 0, zoom: 1 };
  const r = raw ;
  const zoom = isFiniteNumber(r.zoom) && r.zoom > 0 ? r.zoom : 1;
  return { x: num(r.x, 0), y: num(r.y, 0), zoom };
}

function validateBase(
  r
) {
  if (typeof r.id !== "string" || !r.id) return null;
  if (
    !isFiniteNumber(r.x) ||
    !isFiniteNumber(r.y) ||
    !isFiniteNumber(r.w) ||
    !isFiniteNumber(r.h)
  ) {
    return null;
  }
  const base = {
    id: r.id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    parentId: typeof r.parentId === "string" ? r.parentId : null,
    groupId: typeof r.groupId === "string" ? r.groupId : null,
  } ;
  if (isFiniteNumber(r.opacity)) base.opacity = clamp01(r.opacity);
  // Degrees clockwise about the center, stored only when not zero.
  if (isFiniteNumber(r.rotation) && r.rotation > 0 && r.rotation < 360) base.rotation = r.rotation;
  // A lock names who set it; only a named lock can be protected (backend/apps/canvas/locks.py).
  if (r.locked === true) {
    base.locked = true;
    if (typeof r.lockedBy === "string" && r.lockedBy) {
      base.lockedBy = r.lockedBy;
      if (r.lockProtected === true) base.lockProtected = true;
    }
  }
  // Checked against the board's layers once they are known (validateCanvasState).
  if (typeof r.layerId === "string" && r.layerId) base.layerId = r.layerId;
  return base;
}

export const MAX_LAYERS = 100;
export const MAX_LAYER_NAME = 100;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Board-wide settings everyone sees: the background color, the start view
 * newly invited people open at, and the layers above the default one (bottom
 * to top). Omitted when empty, so boards without settings keep their shape.
 */
function validateSettings(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const settings = {};
  if (typeof raw.background === "string" && HEX_COLOR.test(raw.background)) settings.background = raw.background;
  const view = raw.startView;
  if (view != null && typeof view === "object" && isFiniteNumber(view.x) && isFiniteNumber(view.y) && isFiniteNumber(view.zoom) && view.zoom > 0) {
    settings.startView = { x: view.x, y: view.y, zoom: view.zoom };
  }
  if (Array.isArray(raw.layers)) {
    const layers = [];
    const seen = new Set();
    for (const entry of raw.layers.slice(0, MAX_LAYERS)) {
      if (entry == null || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const layer = { id: entry.id, name: typeof entry.name === "string" && entry.name.length <= MAX_LAYER_NAME ? entry.name : "Layer" };
      if (entry.locked === true) layer.locked = true;
      layers.push(layer);
    }
    if (layers.length) settings.layers = layers;
  }
  return Object.keys(settings).length ? settings : null;
}

/**
 * Who created and last changed an object, and when. The server writes these
 * on every save (backend/apps/canvas/activity.py) and ignores what a client
 * sends, so they only ride along here; boards saved before them have none.
 */
export const STAMP_KEYS = ["createdBy", "createdAt", "updatedBy", "updatedAt"];

function withStamps(item, r) {
  if (!item) return null;
  for (const key of ["createdBy", "updatedBy"]) if (typeof r[key] === "string") item[key] = r[key];
  for (const key of ["createdAt", "updatedAt"]) if (isFiniteNumber(r[key])) item[key] = r[key];
  return item;
}

function validateNode(raw) {
  if (raw == null || typeof raw !== "object") return null;
  return withStamps(validateNodeContent(raw), raw);
}

function validateNodeContent(raw) {
  const r = raw ;
  if (!NODE_TYPES.has(r.type )) return null;
  const base = validateBase(r);
  if (!base) return null;
  const type = r.type ;

  switch (type) {
    case "rect":
    case "ellipse":
    case "triangle":
    case "diamond":
    case "shape": {
      // A path shape names its outline from the catalogue in ./shapes; an
      // unknown but well-formed kind is kept so a newer pack survives an
      // older client's autosave.
      if (type === "shape" && !(typeof r.shape === "string" && SHAPE_KIND_PATTERN.test(r.shape))) return null;
      const node = {
        ...base,
        type,
        ...(type === "shape" ? { shape: r.shape } : {}),
        fill: str(r.fill, "#ffffff"),
        stroke: str(r.stroke, "#000000"),
        strokeWidth: num(r.strokeWidth, 1),
      };
      if (type === "rect" && isFiniteNumber(r.cornerRadius)) {
        node.cornerRadius = r.cornerRadius;
      }
      // Text inside a shape is optional; shapes without it load unchanged.
      if (typeof r.text === "string") {
        node.text = r.text;
        const marks = validateMarks(r.marks, r.text);
        if (marks) node.marks = marks;
      }
      if (isFiniteNumber(r.fontSize)) node.fontSize = r.fontSize;
      if (typeof r.color === "string") node.color = r.color;
      return node;
    }
    case "text": {
      const align = r.align === "center" || r.align === "right" ? r.align : "left";
      const node = {
        ...base,
        type,
        text: str(r.text, ""),
        fontSize: num(r.fontSize, 16),
        align,
        color: str(r.color, "#000000"),
      };
      const marks = validateMarks(r.marks, node.text);
      if (marks) node.marks = marks;
      return node;
    }
    case "sticky": {
      const node = {
        ...base,
        type,
        text: str(r.text, ""),
        fill: str(r.fill, "#fff59d"),
        fontSize: num(r.fontSize, 16),
        color: str(r.color, "#000000"),
      };
      const marks = validateMarks(r.marks, node.text);
      if (marks) node.marks = marks;
      return node;
    }
    case "frame": {
      const node = {
        ...base,
        type,
        name: str(r.name, "Frame"),
        fill: str(r.fill, "transparent"),
        stroke: str(r.stroke, "#000000"),
      };
      return node;
    }
    case "image": {
      const src = str(r.src, "");
      // Only ever our own media proxy: never embedded base64 (design.md
      // Risks: blob bloat), and never an arbitrary external URL (a stored,
      // auto-loading <img src> to attacker infra would leak IP/UA/referrer
      // to anyone who opens the board — security review finding).
      if (!src || !src.startsWith("/api/media/")) return null;
      const node = {
        ...base,
        type,
        src,
        aspectLocked: r.aspectLocked !== false,
      };
      if (typeof r.alt === "string") node.alt = r.alt;
      if (isFiniteNumber(r.naturalW)) node.naturalW = r.naturalW;
      if (isFiniteNumber(r.naturalH)) node.naturalH = r.naturalH;
      if (r.crop && typeof r.crop === "object") {
        node.crop = {
          x: clamp01(num(r.crop.x, 0.5)),
          y: clamp01(num(r.crop.y, 0.5)),
          zoom: Math.min(8, Math.max(1, num(r.crop.zoom, 1))),
        };
      }
      return node;
    }
    default:
      return null;
  }
}

function validateEndpoint(raw, nodeIds) {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw ;
  if (typeof r.nodeId === "string") {
    if (!nodeIds.has(r.nodeId)) return null; // dangling reference dropped
    const anchor = ANCHORS.has(r.anchor ) ? (r.anchor ) : "auto";
    return { nodeId: r.nodeId, anchor };
  }
  if (isFiniteNumber(r.x) && isFiniteNumber(r.y)) return { x: r.x, y: r.y };
  return null;
}

function validateConnector(raw, nodeIds) {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw ;
  if (typeof r.id !== "string" || !r.id) return null;
  const from = validateEndpoint(r.from, nodeIds);
  const to = validateEndpoint(r.to, nodeIds);
  if (!from || !to) return null;
  const connector = {
    id: r.id,
    from,
    to,
    kind: r.kind === "line" ? "line" : "arrow",
    stroke: str(r.stroke, "#000000"),
    strokeWidth: num(r.strokeWidth, 2),
  };
  if (isFiniteNumber(r.opacity)) connector.opacity = clamp01(r.opacity);
  return withStamps(connector, r);
}

export function validateCanvasState(raw) {
  if (raw == null || typeof raw !== "object") {
    return emptyCanvasState();
  }
  const obj = raw ;

  const viewport = validateViewport(obj.viewport);

  const nodes = Array.isArray(obj.nodes)
    ? obj.nodes.map(validateNode).filter((n) => n !== null)
    : [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const settings = validateSettings(obj.settings);
  const layerIds = new Set((settings?.layers ?? []).map((layer) => layer.id));
  for (const n of nodes) {
    if (n.parentId && !nodeIds.has(n.parentId)) n.parentId = null;
    if (n.layerId && !layerIds.has(n.layerId)) delete n.layerId;
  }

  const connectors = Array.isArray(obj.connectors)
    ? obj.connectors
        .map((c) => validateConnector(c, nodeIds))
        .filter((c) => c !== null)
    : [];

  const state = { version: CANVAS_STATE_VERSION, viewport, nodes, connectors };
  if (settings) state.settings = settings;
  return state;
}
