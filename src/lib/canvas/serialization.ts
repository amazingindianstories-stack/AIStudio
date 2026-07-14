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
  type Anchor,
  type CanvasNode,
  type CanvasState,
  type Connector,
  type Endpoint,
  type FrameNode,
  type ImageNode,
  type NodeType,
  type ShapeNode,
  type StickyNode,
  type TextNode,
  type Viewport,
} from "./types";

export function emptyCanvasState(): CanvasState {
  return {
    version: CANVAS_STATE_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    connectors: [],
  };
}

const NODE_TYPES: ReadonlySet<NodeType> = new Set([
  "rect",
  "ellipse",
  "triangle",
  "diamond",
  "text",
  "sticky",
  "frame",
  "image",
]);
const ANCHORS: ReadonlySet<Anchor> = new Set([
  "auto",
  "top",
  "right",
  "bottom",
  "left",
  "center",
]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return isFiniteNumber(v) ? v : fallback;
}
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function validateViewport(raw: unknown): Viewport {
  if (raw == null || typeof raw !== "object") return { x: 0, y: 0, zoom: 1 };
  const r = raw as Record<string, unknown>;
  const zoom = isFiniteNumber(r.zoom) && r.zoom > 0 ? r.zoom : 1;
  return { x: num(r.x, 0), y: num(r.y, 0), zoom };
}

function validateBase(
  r: Record<string, unknown>
): Omit<CanvasNode, "type"> | null {
  if (typeof r.id !== "string" || !r.id) return null;
  if (
    !isFiniteNumber(r.x) ||
    !isFiniteNumber(r.y) ||
    !isFiniteNumber(r.w) ||
    !isFiniteNumber(r.h)
  ) {
    return null;
  }
  const base: Omit<CanvasNode, "type"> = {
    id: r.id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    parentId: typeof r.parentId === "string" ? r.parentId : null,
    groupId: typeof r.groupId === "string" ? r.groupId : null,
  } as Omit<CanvasNode, "type">;
  if (isFiniteNumber(r.opacity)) base.opacity = clamp01(r.opacity);
  return base;
}

function validateNode(raw: unknown): CanvasNode | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!NODE_TYPES.has(r.type as NodeType)) return null;
  const base = validateBase(r);
  if (!base) return null;
  const type = r.type as NodeType;

  switch (type) {
    case "rect":
    case "ellipse":
    case "triangle":
    case "diamond": {
      const node: ShapeNode = {
        ...base,
        type,
        fill: str(r.fill, "#ffffff"),
        stroke: str(r.stroke, "#000000"),
        strokeWidth: num(r.strokeWidth, 1),
      };
      if (type === "rect" && isFiniteNumber(r.cornerRadius)) {
        node.cornerRadius = r.cornerRadius;
      }
      return node;
    }
    case "text": {
      const align = r.align === "center" || r.align === "right" ? r.align : "left";
      const node: TextNode = {
        ...base,
        type,
        text: str(r.text, ""),
        fontSize: num(r.fontSize, 16),
        align,
        color: str(r.color, "#000000"),
      };
      return node;
    }
    case "sticky": {
      const node: StickyNode = {
        ...base,
        type,
        text: str(r.text, ""),
        fill: str(r.fill, "#fff59d"),
        fontSize: num(r.fontSize, 16),
        color: str(r.color, "#000000"),
      };
      return node;
    }
    case "frame": {
      const node: FrameNode = {
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
      const node: ImageNode = {
        ...base,
        type,
        src,
        aspectLocked: r.aspectLocked !== false,
      };
      if (typeof r.alt === "string") node.alt = r.alt;
      if (isFiniteNumber(r.naturalW)) node.naturalW = r.naturalW;
      if (isFiniteNumber(r.naturalH)) node.naturalH = r.naturalH;
      return node;
    }
    default:
      return null;
  }
}

function validateEndpoint(raw: unknown, nodeIds: Set<string>): Endpoint | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.nodeId === "string") {
    if (!nodeIds.has(r.nodeId)) return null; // dangling reference dropped
    const anchor = ANCHORS.has(r.anchor as Anchor) ? (r.anchor as Anchor) : "auto";
    return { nodeId: r.nodeId, anchor };
  }
  if (isFiniteNumber(r.x) && isFiniteNumber(r.y)) return { x: r.x, y: r.y };
  return null;
}

function validateConnector(raw: unknown, nodeIds: Set<string>): Connector | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  const from = validateEndpoint(r.from, nodeIds);
  const to = validateEndpoint(r.to, nodeIds);
  if (!from || !to) return null;
  const connector: Connector = {
    id: r.id,
    from,
    to,
    kind: r.kind === "line" ? "line" : "arrow",
    stroke: str(r.stroke, "#000000"),
    strokeWidth: num(r.strokeWidth, 2),
  };
  if (isFiniteNumber(r.opacity)) connector.opacity = clamp01(r.opacity);
  return connector;
}

export function validateCanvasState(raw: unknown): CanvasState {
  if (raw == null || typeof raw !== "object") {
    return emptyCanvasState();
  }
  const obj = raw as Record<string, unknown>;

  const viewport = validateViewport(obj.viewport);

  const nodes: CanvasNode[] = Array.isArray(obj.nodes)
    ? obj.nodes.map(validateNode).filter((n): n is CanvasNode => n !== null)
    : [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.parentId && !nodeIds.has(n.parentId)) n.parentId = null;
  }

  const connectors: Connector[] = Array.isArray(obj.connectors)
    ? obj.connectors
        .map((c) => validateConnector(c, nodeIds))
        .filter((c): c is Connector => c !== null)
    : [];

  return { version: CANVAS_STATE_VERSION, viewport, nodes, connectors };
}
