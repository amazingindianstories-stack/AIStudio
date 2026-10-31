/**
 * Pure connector routing, waypoints, obstacle-avoiding orthogonal A* search,
 * line jumps (crossings) and position-along-path math for line labels.
 */

const CONTAINER_TYPES = new Set(["frame", "swimlane", "diagram"]);
const OBSTACLE_MARGIN = 16;
const MAX_A_STAR_OBSTACLES = 32;
const JUMP_RADIUS = 6;

const ANCHOR_DIR = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/**
 * Snaps `target` to the nearest 45-degree angle (horizontal, vertical or
 * diagonal) from `origin` when Shift is held while drawing a line.
 */
export function snapPointToAngle(origin, target) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: target.x, y: target.y };
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: Math.round((origin.x + Math.cos(snapped) * dist) * 100) / 100,
    y: Math.round((origin.y + Math.sin(snapped) * dist) * 100) / 100,
  };
}

/**
 * Exit direction vector for an endpoint (`{x, y}` unit vector or null).
 */
export function endpointDirection(ep, fromPt, toPt, nodesById, isStart) {
  if ("nodeId" in ep) {
    const anchor = ep.anchor;
    if (anchor === "top" || anchor === "right" || anchor === "bottom" || anchor === "left") {
      return ANCHOR_DIR[anchor];
    }
    if ( typeof anchor === "string" && anchor.startsWith("row:")) {
      return anchor.endsWith(":left") ? { x: -1, y: 0 } : { x: 1, y: 0 };
    }
    const node = nodesById?.[ep.nodeId];
    if (node) {
      const cx = node.x + node.w / 2;
      const cy = node.y + node.h / 2;
      const pt = isStart ? fromPt : toPt;
      const dx = pt.x - cx;
      const dy = pt.y - cy;
      if (Math.abs(dx) / (node.w || 1) >= Math.abs(dy) / (node.h || 1)) {
        return { x: dx >= 0 ? 1 : -1, y: 0 };
      }
      return { x: 0, y: dy >= 0 ? 1 : -1 };
    }
  }
  const dx = toPt.x - fromPt.x;
  const dy = toPt.y - fromPt.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: (isStart ? dx : -dx) >= 0 ? 1 : -1, y: 0 };
  }
  return { x: 0, y: (isStart ? dy : -dy) >= 0 ? 1 : -1 };
}

function pointInsideBox(pt, box) {
  return pt.x > box.left && pt.x < box.right && pt.y > box.top && pt.y < box.bottom;
}

function segmentIntersectsBox(a, b, box) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  if (maxX <= box.left + 1e-6 || minX >= box.right - 1e-6 || maxY <= box.top + 1e-6 || minY >= box.bottom - 1e-6) {
    return false;
  }
  // Orthogonal segment: if bounding intervals overlap strictly, it crosses the box interior.
  if (Math.abs(a.x - b.x) < 1e-6) {
    return a.x > box.left + 1e-6 && a.x < box.right - 1e-6 && maxY > box.top + 1e-6 && minY < box.bottom - 1e-6;
  }
  if (Math.abs(a.y - b.y) < 1e-6) {
    return a.y > box.top + 1e-6 && a.y < box.bottom - 1e-6 && maxX > box.left + 1e-6 && minX < box.right - 1e-6;
  }
  return true;
}

/**
 * Simple 3-segment or 2-segment orthogonal elbow between `from` and `to`.
 */
function simpleElbow(from, to, startDir, endDir) {
  const sHoriz = Math.abs(startDir.x) >= Math.abs(startDir.y);
  const eHoriz = Math.abs(endDir.x) >= Math.abs(endDir.y);
  if (sHoriz && eHoriz) {
    const midX = (from.x + to.x) / 2;
    return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
  }
  if (!sHoriz && !eHoriz) {
    const midY = (from.y + to.y) / 2;
    return [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to];
  }
  if (sHoriz && !eHoriz) {
    return [from, { x: to.x, y: from.y }, to];
  }
  return [from, { x: from.x, y: to.y }, to];
}

/**
 * Removes collinear intermediate points and duplicate consecutive points.
 */
export function simplifyOrthogonalPolyline(points) {
  if (points.length <= 2) return points;
  const deduped = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = deduped[deduped.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) > 0.5) {
      deduped.push(points[i]);
    }
  }
  if (deduped.length <= 2) return deduped;
  const out = [deduped[0]];
  for (let i = 1; i < deduped.length - 1; i++) {
    const a = out[out.length - 1];
    const b = deduped[i];
    const c = deduped[i + 1];
    const collinearX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    const collinearY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    if (!collinearX && !collinearY) out.push(b);
  }
  out.push(deduped[deduped.length - 1]);
  return out;
}

/**
 * Obstacle-avoiding shortest-path orthogonal router using A* on a sparse
 * visibility grid around board nodes.
 */
export function routeOrthogonal(c, from, to, nodesById) {
  const startDir = endpointDirection(c.from, from, to, nodesById, true);
  const endDir = endpointDirection(c.to, from, to, nodesById, false);

  // If custom waypoints are set on the connector, route orthogonally through them.
  if (Array.isArray(c.waypoints) && c.waypoints.length > 0) {
    const chain = [from, ...c.waypoints, to];
    const full = [from];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const d1 = i === 0 ? startDir : { x: Math.sign(b.x - a.x) || 1, y: 0 };
      const d2 = i === chain.length - 2 ? endDir : { x: -Math.sign(b.x - a.x) || -1, y: 0 };
      const seg = simpleElbow(a, b, d1, d2);
      full.push(...seg.slice(1));
    }
    return simplifyOrthogonalPolyline(full);
  }

  const startLead = "nodeId" in c.from
    ? { x: from.x + startDir.x * OBSTACLE_MARGIN, y: from.y + startDir.y * OBSTACLE_MARGIN }
    : from;
  const endLead = "nodeId" in c.to
    ? { x: to.x + endDir.x * OBSTACLE_MARGIN, y: to.y + endDir.y * OBSTACLE_MARGIN }
    : to;

  // Gather candidate obstacles near the corridor between from and to.
  const corridorLeft = Math.min(from.x, to.x, startLead.x, endLead.x) - 240;
  const corridorRight = Math.max(from.x, to.x, startLead.x, endLead.x) + 240;
  const corridorTop = Math.min(from.y, to.y, startLead.y, endLead.y) - 240;
  const corridorBottom = Math.max(from.y, to.y, startLead.y, endLead.y) + 240;

  const obstacles = [];
  if (nodesById) {
    for (const id of Object.keys(nodesById)) {
      const n = nodesById[id];
      if (!n || CONTAINER_TYPES.has(n.type)) continue;
      if (n.x + n.w < corridorLeft || n.x > corridorRight || n.y + n.h < corridorTop || n.y > corridorBottom) {
        continue;
      }
      const pad = id === c.from?.nodeId || id === c.to?.nodeId ? 4 : OBSTACLE_MARGIN;
      const box = {
        id,
        left: n.x - pad,
        top: n.y - pad,
        right: n.x + n.w + pad,
        bottom: n.y + n.h + pad,
      };
      // Don't let an inflated box swallow startLead or endLead.
      if (pointInsideBox(startLead, box) || pointInsideBox(endLead, box)) continue;
      obstacles.push(box);
      if (obstacles.length >= MAX_A_STAR_OBSTACLES) break;
    }
  }

  // Fast path: check if the simple direct elbow is completely clear of obstacles.
  const directInner = simpleElbow(startLead, endLead, startDir, endDir);
  const directClear = directInner.every((pt, idx) => {
    if (idx === 0) return true;
    const prev = directInner[idx - 1];
    return !obstacles.some((box) => segmentIntersectsBox(prev, pt, box));
  });
  if (directClear) {
    return simplifyOrthogonalPolyline([from, ...directInner, to]);
  }

  // Build sparse orthogonal grid coordinates from leads, midpoints and obstacle boundaries.
  const xsSet = new Set([startLead.x, endLead.x, (startLead.x + endLead.x) / 2]);
  const ysSet = new Set([startLead.y, endLead.y, (startLead.y + endLead.y) / 2]);
  for (const box of obstacles) {
    xsSet.add(box.left);
    xsSet.add(box.right);
    ysSet.add(box.top);
    ysSet.add(box.bottom);
  }
  const xs = Array.from(xsSet).sort((a, b) => a - b);
  const ys = Array.from(ysSet).sort((a, b) => a - b);
  const xiMap = new Map(xs.map((v, i) => [v, i]));
  const yiMap = new Map(ys.map((v, i) => [v, i]));

  const W = xs.length;
  const H = ys.length;
  const startIdx = yiMap.get(startLead.y) * W + xiMap.get(startLead.x);
  const goalIdx = yiMap.get(endLead.y) * W + xiMap.get(endLead.x);

  const blocked = new Uint8Array(W * H);
  for (let yi = 0; yi < H; yi++) {
    const y = ys[yi];
    for (let xi = 0; xi < W; xi++) {
      const idx = yi * W + xi;
      if (idx === startIdx || idx === goalIdx) continue;
      const pt = { x: xs[xi], y };
      if (obstacles.some((box) => pointInsideBox(pt, box))) {
        blocked[idx] = 1;
      }
    }
  }

  // A* search with state = (gridIdx * 2 + dirAxis), dirAxis: 0 = horiz, 1 = vert
  const BEND_PENALTY = 18;
  const stateCount = W * H * 2;
  const gScore = new Float64Array(stateCount).fill(Infinity);
  const cameFrom = new Int32Array(stateCount).fill(-1);
  const closed = new Uint8Array(stateCount);

  const initAxis = Math.abs(startDir.x) >= Math.abs(startDir.y) ? 0 : 1;
  const s0 = startIdx * 2 + initAxis;
  const s1 = startIdx * 2 + (1 - initAxis);
  gScore[s0] = 0;
  gScore[s1] = BEND_PENALTY * 0.5;

  const hFunc = (idx) => {
    const xi = idx % W;
    const yi = (idx / W) | 0;
    return Math.abs(xs[xi] - endLead.x) + Math.abs(ys[yi] - endLead.y);
  };

  const open = [s0, s1];
  let bestGoalState = -1;

  const DIRS = [
    { dx: 1, dy: 0, axis: 0 },
    { dx: -1, dy: 0, axis: 0 },
    { dx: 0, dy: 1, axis: 1 },
    { dx: 0, dy: -1, axis: 1 },
  ];

  while (open.length > 0) {
    let bestPos = 0;
    let bestF = gScore[open[0]] + hFunc(open[0] >> 1);
    for (let i = 1; i < open.length; i++) {
      const st = open[i];
      const f = gScore[st] + hFunc(st >> 1);
      if (f < bestF) {
        bestF = f;
        bestPos = i;
      }
    }
    const current = open[bestPos];
    open[bestPos] = open[open.length - 1];
    open.pop();

    if (closed[current]) continue;
    closed[current] = 1;

    const idx = current >> 1;
    const axis = current & 1;
    if (idx === goalIdx) {
      bestGoalState = current;
      break;
    }

    const xi = idx % W;
    const yi = (idx / W) | 0;
    const curPt = { x: xs[xi], y: ys[yi] };

    for (const d of DIRS) {
      const nxi = xi + d.dx;
      const nyi = yi + d.dy;
      if (nxi < 0 || nxi >= W || nyi < 0 || nyi >= H) continue;
      const nIdx = nyi * W + nxi;
      if (blocked[nIdx]) continue;
      const nextPt = { x: xs[nxi], y: ys[nyi] };
      if (obstacles.some((box) => segmentIntersectsBox(curPt, nextPt, box))) continue;

      const stepDist = Math.abs(nextPt.x - curPt.x) + Math.abs(nextPt.y - curPt.y);
      const turnCost = d.axis === axis ? 0 : BEND_PENALTY;
      const tentativeG = gScore[current] + stepDist + turnCost;
      const nextState = nIdx * 2 + d.axis;
      if (tentativeG < gScore[nextState]) {
        gScore[nextState] = tentativeG;
        cameFrom[nextState] = current;
        open.push(nextState);
      }
    }
  }

  if (bestGoalState === -1) {
    return simplifyOrthogonalPolyline([from, ...directInner, to]);
  }

  const path = [];
  let cur = bestGoalState;
  while (cur !== -1) {
    const idx = cur >> 1;
    const xi = idx % W;
    const yi = (idx / W) | 0;
    path.push({ x: xs[xi], y: ys[yi] });
    cur = cameFrom[cur];
  }
  path.reverse();
  return simplifyOrthogonalPolyline([from, ...path, to]);
}

/**
 * Computes the polyline / control points for any connector (`curved`,
 * `straight` or `orthogonal`).
 */
export function connectorPolyline(c, from, to, nodesById) {
  const shape = c.shape ?? "curved";
  const waypoints = Array.isArray(c.waypoints) ? c.waypoints : [];
  if (shape === "straight") {
    return [from, ...waypoints, to];
  }
  if (shape === "orthogonal") {
    return routeOrthogonal(c, from, to, nodesById);
  }
  // Curved: sample the curve into a dense polyline for arc-length / label math.
  if (waypoints.length === 0) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return [from, to];
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const bow = Math.min(dist * 0.25, 60);
    const nx = -dy / dist;
    const ny = dx / dist;
    const ctrl = { x: midX + nx * bow, y: midY + ny * bow };
    return sampleQuadratic(from, ctrl, to, 24);
  }
  const knots = [from, ...waypoints, to];
  return sampleSmoothCurve(knots, 16);
}

function sampleQuadratic(p0, p1, p2, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
  return pts;
}

function sampleSmoothCurve(knots, stepsPerSeg) {
  if (knots.length <= 2) return knots;
  const pts = [knots[0]];
  for (let i = 0; i < knots.length - 1; i++) {
    const p0 = knots[Math.max(0, i - 1)];
    const p1 = knots[i];
    const p2 = knots[i + 1];
    const p3 = knots[Math.min(knots.length - 1, i + 2)];
    for (let s = 1; s <= stepsPerSeg; s++) {
      const t = s / stepsPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      pts.push({ x, y });
    }
  }
  return pts;
}

/**
 * SVG path `d` for curved connectors with custom waypoints.
 */
export function curvedWaypointsPath(from, waypoints, to) {
  const pts = sampleSmoothCurve([from, ...waypoints, to], 14);
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`).join(" ");
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Segment-segment intersection between [a1, a2] and [b1, b2].
 * Returns `{ x, y, t }` where `t` in (0, 1) is the parameter along [a1, a2], or null.
 */
function segmentIntersection(a1, a2, b1, b2) {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
  const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom;
  if (t <= 0.05 || t >= 0.95 || u <= 0.05 || u >= 0.95) return null;
  return { x: a1.x + t * dax, y: a1.y + t * day, t };
}

/**
 * Builds an SVG path string from a polyline (`straight` or `orthogonal`),
 * inserting semicircular line jumps where segments cross `earlierSegments`.
 */
export function polylineToPathWithJumps(points, earlierSegments = []) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const parts = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-6) continue;
    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;

    const hits = [];
    if (earlierSegments.length > 0 && segLen > JUMP_RADIUS * 3) {
      for (const [e1, e2] of earlierSegments) {
        const hit = segmentIntersection(a, b, e1, e2);
        if (hit) {
          const distFromStart = hit.t * segLen;
          if (distFromStart > JUMP_RADIUS * 1.5 && segLen - distFromStart > JUMP_RADIUS * 1.5) {
            hits.push({ ...hit, dist: distFromStart });
          }
        }
      }
      hits.sort((h1, h2) => h1.dist - h2.dist);
    }

    let lastDist = 0;
    for (const hit of hits) {
      if (hit.dist - JUMP_RADIUS <= lastDist + 2) continue;
      const pBefore = {
        x: a.x + ux * (hit.dist - JUMP_RADIUS),
        y: a.y + uy * (hit.dist - JUMP_RADIUS),
      };
      const pAfter = {
        x: a.x + ux * (hit.dist + JUMP_RADIUS),
        y: a.y + uy * (hit.dist + JUMP_RADIUS),
      };
      parts.push(`L ${round(pBefore.x)} ${round(pBefore.y)}`);
      parts.push(`A ${JUMP_RADIUS} ${JUMP_RADIUS} 0 0 1 ${round(pAfter.x)} ${round(pAfter.y)}`);
      lastDist = hit.dist + JUMP_RADIUS;
    }
    parts.push(`L ${round(b.x)} ${round(b.y)}`);
  }
  return parts.join(" ");
}

/**
 * Point and tangent angle (degrees, kept readable in [-90, 90]) at normalized
 * arc-length `t` in [0, 1] along a connector's polyline.
 */
export function pointAtPolyline(points, t) {
  if (!points || points.length === 0) return { x: 0, y: 0, angle: 0, rawAngle: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y, angle: 0, rawAngle: 0 };
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
  const lengths = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    lengths.push(len);
    total += len;
  }
  if (total < 1e-6) {
    return { x: points[0].x, y: points[0].y, angle: 0, rawAngle: 0 };
  }
  const target = clamped * total;
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    const segLen = lengths[i];
    if (acc + segLen >= target || i === lengths.length - 1) {
      const localT = segLen > 1e-6 ? (target - acc) / segLen : 0;
      const a = points[i];
      const b = points[i + 1];
      const rawDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      let readable = rawDeg;
      if (readable > 90) readable -= 180;
      if (readable < -90) readable += 180;
      return {
        x: a.x + (b.x - a.x) * localT,
        y: a.y + (b.y - a.y) * localT,
        angle: readable,
        rawAngle: rawDeg,
      };
    }
    acc += segLen;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y, angle: 0, rawAngle: 0 };
}

/**
 * Projects `worldPoint` onto `points` and returns the normalized arc-length
 * parameter `t` in [0.05, 0.95].
 */
export function nearestTOnPolyline(points, worldPoint) {
  if (!points || points.length < 2) return 0.5;
  const lengths = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    lengths.push(len);
    total += len;
  }
  if (total < 1e-6) return 0.5;
  let bestDistSq = Infinity;
  let bestArc = total * 0.5;
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = lengths[i];
    if (segLen > 1e-6) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const u = Math.min(1, Math.max(0, ((worldPoint.x - a.x) * dx + (worldPoint.y - a.y) * dy) / (segLen * segLen)));
      const px = a.x + u * dx;
      const py = a.y + u * dy;
      const dSq = (worldPoint.x - px) ** 2 + (worldPoint.y - py) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestArc = acc + u * segLen;
      }
    }
    acc += segLen;
  }
  return Math.min(0.95, Math.max(0.05, Math.round((bestArc / total) * 1000) / 1000));
}

/**
 * Tangent angles (in radians) at the start and end of a connector polyline
 * for orienting startCap and endCap markers.
 */
export function polylineEndTangents(points) {
  if (!points || points.length < 2) {
    return {
      startAngle: Math.PI,
      endAngle: 0,
      start: { x: points?.[0]?.x ?? 0, y: points?.[0]?.y ?? 0, ux: 1, uy: 0 },
      end: { x: points?.[0]?.x ?? 0, y: points?.[0]?.y ?? 0, ux: 1, uy: 0 },
    };
  }
  const first = points[0];
  let startAngle = Math.PI;
  let startUx = 1;
  let startUy = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - first.x;
    const dy = points[i].y - first.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-4) {
      startUx = dx / len;
      startUy = dy / len;
      startAngle = Math.atan2(-dy, -dx);
      break;
    }
  }
  const last = points[points.length - 1];
  let endAngle = 0;
  let endUx = 1;
  let endUy = 0;
  for (let i = points.length - 2; i >= 0; i--) {
    const dx = last.x - points[i].x;
    const dy = last.y - points[i].y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-4) {
      endUx = dx / len;
      endUy = dy / len;
      endAngle = Math.atan2(dy, dx);
      break;
    }
  }
  return {
    startAngle,
    endAngle,
    start: { x: first.x, y: first.y, ux: startUx, uy: startUy },
    end: { x: last.x, y: last.y, ux: endUx, uy: endUy },
  };
}
