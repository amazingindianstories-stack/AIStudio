/**
 * Path-based shape catalogue for the generic `shape` node type. A `shape`
 * node stores only its kind id (`node.shape`); the outline is derived here
 * from the node's box, so resize, hit-testing and connector anchors all work
 * from one polygon. Curved kinds are flattened into dense polygons, which
 * keeps every consumer on the same simple point-in-polygon and ray math.
 *
 * Unknown kinds (for example a pack a newer client added) render and hit-test
 * as a rectangle instead of disappearing.
 */

const CURVE_STEPS = 24;

/** Kind ids the format accepts for a `shape` node; known or not. */
export const SHAPE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

function regularPolygon(sides, w, h, rotation = -Math.PI / 2) {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * 2 * Math.PI) / sides;
    points.push([Math.cos(a), Math.sin(a)]);
  }
  return fitToBox(points, w, h);
}

function star(w, h) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 1 : 0.42;
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return fitToBox(points, w, h);
}

/** Scales a unit-space polygon so its extent fills the w x h box exactly. */
function fitToBox(points, w, h) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const sx = w / (Math.max(...xs) - x0 || 1);
  const sy = h / (Math.max(...ys) - y0 || 1);
  return points.map(([x, y]) => [(x - x0) * sx, (y - y0) * sy]);
}

/** Points along an elliptical arc, excluding the start point. */
function arc(cx, cy, rx, ry, from, to, steps = CURVE_STEPS) {
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return points;
}

function roundedRect(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const steps = 6;
  return [
    [x + rr, y],
    [x + w - rr, y],
    ...arc(x + w - rr, y + rr, rr, rr, -Math.PI / 2, 0, steps),
    [x + w, y + h - rr],
    ...arc(x + w - rr, y + h - rr, rr, rr, 0, Math.PI / 2, steps),
    [x + rr, y + h],
    ...arc(x + rr, y + h - rr, rr, rr, Math.PI / 2, Math.PI, steps),
    [x, y + rr],
    ...arc(x + rr, y + rr, rr, rr, Math.PI, Math.PI * 1.5, steps),
  ];
}

function cylinderRim(w, h) {
  return Math.min(h * 0.15, w * 0.3);
}

function arrowHead(w, h, share) {
  return Math.min(w * share, h * 0.9);
}

const OUTLINES = {
  rectangle: (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  parallelogram: (w, h) => {
    const s = Math.min(w * 0.25, h);
    return [[s, 0], [w, 0], [w - s, h], [0, h]];
  },
  trapezoid: (w, h) => {
    const s = Math.min(w * 0.22, h);
    return [[s, 0], [w - s, 0], [w, h], [0, h]];
  },
  pentagon: (w, h) => regularPolygon(5, w, h),
  hexagon: (w, h) => {
    const s = Math.min(w * 0.25, h * 0.5);
    return [[s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]];
  },
  octagon: (w, h) => {
    const cx = w * 0.293;
    const cy = h * 0.293;
    return [[cx, 0], [w - cx, 0], [w, cy], [w, h - cy], [w - cx, h], [cx, h], [0, h - cy], [0, cy]];
  },
  star: (w, h) => star(w, h),
  cross: (w, h) => {
    const x1 = w / 3;
    const x2 = (2 * w) / 3;
    const y1 = h / 3;
    const y2 = (2 * h) / 3;
    return [[x1, 0], [x2, 0], [x2, y1], [w, y1], [w, y2], [x2, y2], [x2, h], [x1, h], [x1, y2], [0, y2], [0, y1], [x1, y1]];
  },
  cylinder: (w, h) => {
    const ry = cylinderRim(w, h);
    return [
      [0, ry],
      ...arc(w / 2, ry, w / 2, ry, Math.PI, Math.PI * 2),
      [w, h - ry],
      ...arc(w / 2, h - ry, w / 2, ry, 0, Math.PI),
    ];
  },
  "arrow-right": (w, h) => {
    const head = arrowHead(w, h, 0.4);
    return [[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75]];
  },
  "arrow-left": (w, h) => OUTLINES["arrow-right"](w, h).map(([x, y]) => [w - x, y]).reverse(),
  "arrow-both": (w, h) => {
    const head = arrowHead(w, h, 0.3);
    return [
      [0, h / 2], [head, 0], [head, h * 0.25], [w - head, h * 0.25], [w - head, 0],
      [w, h / 2], [w - head, h], [w - head, h * 0.75], [head, h * 0.75], [head, h],
    ];
  },
  chevron: (w, h) => {
    const d = Math.min(w * 0.3, h * 0.5);
    return [[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]];
  },
  callout: (w, h) => {
    const body = h * 0.78;
    const r = Math.min(w, body) * 0.14;
    const points = roundedRect(0, 0, w, body, r);
    // Splice the tail into the bottom edge, which runs right to left from
    // the bottom-right corner arc to the bottom-left one.
    const bottomLeft = points.findIndex(([x, y]) => y === body && x === r);
    const tail = [[w * 0.42, body], [w * 0.18, h], [w * 0.24, body]];
    points.splice(bottomLeft, 0, ...tail);
    return points;
  },
  cloud: (w, h) => {
    // Scalloped ellipse: each lobe is a raised half-sine between cusps.
    const lobes = 9;
    const points = [];
    const n = lobes * 12;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const r = 0.82 + 0.18 * Math.abs(Math.sin((a + Math.PI / 2) * (lobes / 2)));
      points.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return fitToBox(points, w, h);
  },
};

/** The basic shapes panel, in display order. `tool` arms the create tool. */
export const BASIC_SHAPES = [
  { tool: "rect", label: "Rectangle" },
  { tool: "rect-rounded", label: "Rounded rectangle" },
  { tool: "ellipse", label: "Circle" },
  { tool: "triangle", label: "Triangle" },
  { tool: "diamond", label: "Diamond" },
  { tool: "shape:parallelogram", label: "Parallelogram" },
  { tool: "shape:trapezoid", label: "Trapezoid" },
  { tool: "shape:pentagon", label: "Pentagon" },
  { tool: "shape:hexagon", label: "Hexagon" },
  { tool: "shape:octagon", label: "Octagon" },
  { tool: "shape:star", label: "Star" },
  { tool: "shape:cross", label: "Cross" },
  { tool: "shape:cylinder", label: "Cylinder" },
  { tool: "shape:arrow-left", label: "Left arrow" },
  { tool: "shape:arrow-right", label: "Right arrow" },
  { tool: "shape:arrow-both", label: "Double arrow" },
  { tool: "shape:chevron", label: "Chevron" },
  { tool: "shape:callout", label: "Speech bubble" },
  { tool: "shape:cloud", label: "Cloud" },
];

const LEGACY_SHAPE_TYPES = new Set(["rect", "ellipse", "triangle", "diamond"]);

/** Every node type that renders as a shape and can hold text. */
export function isShapeNode(node) {
  return node?.type === "shape" || LEGACY_SHAPE_TYPES.has(node?.type);
}

/** Tools that place a node on click (or Enter). */
export function isCreateTool(tool) {
  return (
    LEGACY_SHAPE_TYPES.has(tool) ||
    tool === "rect-rounded" ||
    tool === "text" ||
    tool === "sticky" ||
    tool === "frame" ||
    (typeof tool === "string" && tool.startsWith("shape:") && shapeKindOfTool(tool) in OUTLINES)
  );
}

export function isShapeTool(tool) {
  return LEGACY_SHAPE_TYPES.has(tool) || tool === "rect-rounded" || (typeof tool === "string" && tool.startsWith("shape:"));
}

export function shapeKindOfTool(tool) {
  return tool.slice("shape:".length);
}

/** Polygon outline for a `shape` node of `kind`, in box-local pixels. */
export function shapeOutline(kind, w, h) {
  const build = OUTLINES[kind] ?? OUTLINES.rectangle;
  return build(Math.max(w, 0), Math.max(h, 0));
}

/** Extra open strokes drawn over the fill (the cylinder's front rim). */
export function shapeDetail(kind, w, h) {
  if (kind !== "cylinder") return null;
  const ry = cylinderRim(w, h);
  return [[0, ry], ...arc(w / 2, ry, w / 2, ry, Math.PI, 0)];
}

/**
 * Polygon inset so a stroke of `inset` px stays inside the box: the outline
 * is built for the inner box and shifted, which keeps sharp tips on the box.
 */
export function shapeRenderPoints(kind, w, h, inset) {
  const iw = Math.max(w - inset * 2, 0);
  const ih = Math.max(h - inset * 2, 0);
  return shapeOutline(kind, iw, ih).map(([x, y]) => [x + inset, y + inset]);
}

export function pointsToPath(points, close = true) {
  if (!points.length) return "";
  const body = points.map(([x, y], i) => `${i ? "L" : "M"}${round(x)} ${round(y)}`).join(" ");
  return close ? `${body} Z` : body;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/** World-space outline of any node that has a non-rectangular silhouette, or null. */
export function nodeOutline(node) {
  if (node.type !== "shape") return null;
  return shapeOutline(node.shape, node.w, node.h).map(([x, y]) => [node.x + x, node.y + y]);
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The outermost point where the ray from `origin` through `towards` crosses
 * `polygon`, so a connector attaches to the visible silhouette (a star's tip,
 * not the notch nearest the center). Returns null for a degenerate ray.
 */
export function rayExit(polygon, origin, towards) {
  const dx = towards.x - origin.x;
  const dy = towards.y - origin.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
  let best = null;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    const ex = bx - ax;
    const ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const t = ((ax - origin.x) * ey - (ay - origin.y) * ex) / denom;
    const u = ((ax - origin.x) * dy - (ay - origin.y) * dx) / denom;
    if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && (best === null || t > best)) best = t;
  }
  return best === null ? null : { x: origin.x + dx * best, y: origin.y + dy * best };
}
