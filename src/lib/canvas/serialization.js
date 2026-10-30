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
import { FONT_FAMILY_PATTERN } from "./fonts";
import { uniqueStrings, validateReactions } from "./reactions";
import { MAX_NODE_TAGS, MAX_TAG_ID, validateTags } from "./tags";

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
  "stack",
  "frame",
  "image",
  "erd",
  "swimlane",
  "diagram",
]);
const TEXT_ALIGNS = ["left", "center", "right"];

const ANCHORS = new Set([
  "auto",
  "top",
  "right",
  "bottom",
  "left",
  "center",
]);
const ROW_ANCHOR_PATTERN = /^row:[a-zA-Z0-9_-]{1,64}:(?:left|right)$/;
const STROKE_STYLES = new Set(["dashed", "dotted"]);
const CONNECTOR_SHAPES = new Set(["curved", "straight", "orthogonal"]);
export const CONNECTOR_CAPS = new Set([
  "none",
  "arrow",
  "open-arrow",
  "diamond",
  "filled-diamond",
  "circle",
  "erd-one",
  "erd-many",
  "erd-only-one",
  "erd-zero-or-one",
  "erd-one-or-many",
  "erd-zero-or-many",
]);
const VIEWBOX_PATTERN = /^-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}$/;
const MAX_CUSTOM_SVG_UNITS = 51200;

function isValidAnchor(anchor) {
  return typeof anchor === "string" && (ANCHORS.has(anchor) || ROW_ANCHOR_PATTERN.test(anchor));
}

function isCustomSvg(svg) {
  return typeof svg === "string" && svg.length > 0 && svg.length <= MAX_CUSTOM_SVG_UNITS;
}

function withStructuredTheme(node, r) {
  if (STROKE_STYLES.has(r.strokeStyle)) node.strokeStyle = r.strokeStyle;
  if (typeof r.headerFill === "string") node.headerFill = r.headerFill;
  if (typeof r.color === "string") node.color = r.color;
}

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
  if (typeof r.diagramLayerId === "string" && r.diagramLayerId && r.diagramLayerId.length <= 64) {
    base.diagramLayerId = r.diagramLayerId;
  }
  return base;
}

/**
 * Who created and last changed an object, and when. The server writes these
 * on every save (backend/apps/canvas/activity.py) and ignores what a client
 * sends, so they only ride along here; boards saved before them have none.
 */
export const STAMP_KEYS = ["createdBy", "createdAt", "updatedBy", "updatedAt", "textBy"];

function withStamps(item, r) {
  if (!item) return null;
  // `textBy` is who last replaced the text, for sticky author labels.
  for (const key of ["createdBy", "updatedBy", "textBy"]) if (typeof r[key] === "string") item[key] = r[key];
  for (const key of ["createdAt", "updatedAt"]) if (isFiniteNumber(r[key])) item[key] = r[key];
  return item;
}

function withFont(node, r) {
  if (typeof r.fontFamily === "string" && FONT_FAMILY_PATTERN.test(r.fontFamily)) node.fontFamily = r.fontFamily;
}

/** Sticky-only options, each present only when set. */
function withStickyExtras(node, r) {
  for (const key of ["autoFit", "showAuthor"]) if (r[key] === true) node[key] = true;
  const tagIds = uniqueStrings(r.tagIds, MAX_NODE_TAGS, MAX_TAG_ID);
  if (tagIds.length) node.tagIds = tagIds;
  const reactions = validateReactions(r.reactions);
  if (reactions) node.reactions = reactions;
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
      if (STROKE_STYLES.has(r.strokeStyle)) {
        node.strokeStyle = r.strokeStyle;
      }
      if (type === "shape") {
        if (r.tail && typeof r.tail === "object") {
          if (typeof r.tail.nodeId === "string" && r.tail.nodeId) {
            node.tail = {
              nodeId: r.tail.nodeId,
              anchor: isValidAnchor(r.tail.anchor) ? r.tail.anchor : "auto",
            };
          } else if (isFiniteNumber(r.tail.x) && isFiniteNumber(r.tail.y)) {
            node.tail = { x: r.tail.x, y: r.tail.y };
          }
        }
        if (isCustomSvg(r.svg)) {
          node.svg = r.svg;
          if (typeof r.svgViewBox === "string" && r.svgViewBox.length <= 64 && VIEWBOX_PATTERN.test(r.svgViewBox)) {
            node.svgViewBox = r.svgViewBox;
          }
          if (typeof r.shapeName === "string" && r.shapeName && r.shapeName.length <= 120) {
            node.shapeName = r.shapeName;
          }
        }
      }
      // Text inside a shape is optional; shapes without it load unchanged.
      if (typeof r.text === "string") {
        node.text = r.text;
        const marks = validateMarks(r.marks, r.text);
        if (marks) node.marks = marks;
      }
      if (isFiniteNumber(r.fontSize)) node.fontSize = r.fontSize;
      if (typeof r.color === "string") node.color = r.color;
      // Shape text is centered unless aligned otherwise.
      if (TEXT_ALIGNS.includes(r.align)) node.align = r.align;
      withFont(node, r);
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
      withFont(node, r);
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
      withFont(node, r);
      withStickyExtras(node, r);
      return node;
    }
    case "stack":
      // A pile of blank stickies; dragging from it adds one (./stickies.js).
      return { ...base, type, fill: str(r.fill, "#fff59d") };
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
    case "erd": {
      const cols = r.columns === 1 || r.columns === 2 || r.columns === 3 ? r.columns : 3;
      const rawRows = Array.isArray(r.rows) ? r.rows.slice(0, 100) : [];
      const rows = [];
      for (const item of rawRows) {
        if (item == null || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
        const cells = Array.isArray(item.cells)
          ? [str(item.cells[0], ""), str(item.cells[1], ""), str(item.cells[2], "")]
          : ["", "", ""];
        rows.push({ id: item.id, cells });
      }
      if (rows.length === 0) {
        rows.push({ id: "r1", cells: ["PK", "id", "uuid"] });
      }
      const node = {
        ...base,
        type,
        name: str(r.name, "Entity"),
        columns: cols,
        rows,
        fill: str(r.fill, "#18181f"),
        stroke: str(r.stroke, "#6f9bd1"),
        strokeWidth: num(r.strokeWidth, 2),
      };
      withStructuredTheme(node, r);
      return node;
    }
    case "swimlane": {
      const orientation = r.orientation === "vertical" ? "vertical" : "horizontal";
      const rawLanes = Array.isArray(r.lanes) ? r.lanes.slice(0, 50) : [];
      const lanes = [];
      for (const item of rawLanes) {
        if (item == null || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
        lanes.push({
          id: item.id,
          name: str(item.name, "Lane"),
          size: Math.max(40, num(item.size, 180)),
        });
      }
      if (lanes.length === 0) {
        lanes.push(
          { id: "lane-1", name: "Lane 1", size: 180 },
          { id: "lane-2", name: "Lane 2", size: 180 }
        );
      }
      const node = {
        ...base,
        type,
        name: str(r.name, "Pool"),
        orientation,
        lanes,
        fill: str(r.fill, "transparent"),
        stroke: str(r.stroke, "#6b7280"),
        strokeWidth: num(r.strokeWidth, 2),
      };
      withStructuredTheme(node, r);
      return node;
    }
    case "diagram": {
      const rawLayers = Array.isArray(r.layers) ? r.layers.slice(0, 30) : [];
      const layers = [];
      for (const item of rawLayers) {
        if (item == null || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
        layers.push({
          id: item.id,
          name: str(item.name, "Layer"),
          visible: item.visible !== false,
        });
      }
      if (layers.length === 0) {
        layers.push({ id: "default", name: "Main layer", visible: true });
      }
      const node = {
        ...base,
        type,
        name: str(r.name, "Diagram"),
        layers,
        fill: str(r.fill, "rgba(15,23,42,0.45)"),
        stroke: str(r.stroke, "#6f9bd1"),
        strokeWidth: num(r.strokeWidth, 2),
      };
      withStructuredTheme(node, r);
      if (Array.isArray(r.containers)) {
        const containers = [];
        for (const c of r.containers.slice(0, 50)) {
          if (c == null || typeof c !== "object" || typeof c.id !== "string" || !c.id) continue;
          if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y) || !isFiniteNumber(c.w) || !isFiniteNumber(c.h)) continue;
          containers.push({
            id: c.id,
            name: str(c.name, "Container"),
            x: c.x,
            y: c.y,
            w: Math.max(40, c.w),
            h: Math.max(40, c.h),
            layerId: typeof c.layerId === "string" && c.layerId ? c.layerId : "default",
          });
        }
        if (containers.length > 0) node.containers = containers;
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
    const anchor = isValidAnchor(r.anchor) ? r.anchor : "auto";
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
  if (CONNECTOR_SHAPES.has(r.shape)) connector.shape = r.shape;
  if (STROKE_STYLES.has(r.strokeStyle)) connector.strokeStyle = r.strokeStyle;
  if (CONNECTOR_CAPS.has(r.startCap)) connector.startCap = r.startCap;
  if (CONNECTOR_CAPS.has(r.endCap)) connector.endCap = r.endCap;
  if (Array.isArray(r.waypoints)) {
    const waypoints = [];
    for (const pt of r.waypoints.slice(0, 64)) {
      if (pt && typeof pt === "object" && isFiniteNumber(pt.x) && isFiniteNumber(pt.y)) {
        waypoints.push({ x: pt.x, y: pt.y });
      }
    }
    if (waypoints.length > 0) connector.waypoints = waypoints;
  }
  if (Array.isArray(r.labels)) {
    const labels = [];
    for (const lbl of r.labels.slice(0, 16)) {
      if (lbl == null || typeof lbl !== "object" || typeof lbl.id !== "string" || !lbl.id) continue;
      labels.push({
        id: lbl.id,
        text: str(lbl.text, ""),
        position: clamp01(num(lbl.position, 0.5)),
        orientation: lbl.orientation === "aligned" ? "aligned" : "horizontal",
      });
    }
    if (labels.length > 0) connector.labels = labels;
  }
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

  const tags = validateTags(obj.tags);
  const tagIds = new Set(tags.map((tag) => tag.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.parentId && !nodeIds.has(n.parentId)) n.parentId = null;
    // A tag deleted board-wide leaves no reference behind.
    if (n.tagIds) {
      n.tagIds = n.tagIds.filter((id) => tagIds.has(id));
      if (!n.tagIds.length) delete n.tagIds;
    }
    if (n.type === "shape" && n.tail && "nodeId" in n.tail && !nodeIds.has(n.tail.nodeId)) {
      delete n.tail;
    }
  }

  const connectors = Array.isArray(obj.connectors)
    ? obj.connectors
        .map((c) => validateConnector(c, nodeIds))
        .filter((c) => c !== null)
    : [];

  const state = { version: CANVAS_STATE_VERSION, viewport, nodes, connectors };
  // Present only once the board has a tag, so boards without tags keep their shape.
  if (tags.length) state.tags = tags;
  return state;
}
