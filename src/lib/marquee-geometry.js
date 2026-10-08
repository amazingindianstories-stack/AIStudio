/**
 * 2D Geometry helpers for Asset Library Marquee Selection
 */

/**
 * Checks if two axis-aligned bounding boxes intersect.
 *
 * @param {{ left: number, top: number, width: number, height: number }} a
 * @param {{ left: number, top: number, width: number, height: number }} b
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/**
 * Computes a normalized bounding box from two arbitrary corner coordinates.
 * Supports dragging in all four directions (top-left, bottom-right, etc.).
 *
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @returns {{ left: number, top: number, width: number, height: number, right: number, bottom: number }}
 */
export function normalizeRect(x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/**
 * Calculates candidate selection based on marquee intersections and keyboard modifiers:
 *  - Normal (no modifier): replaces selection with intersecting items.
 *  - Shift: adds intersecting items to initial selection (union).
 *  - Alt / Option: subtracts intersecting items from initial selection (difference).
 *
 * @param {string[]} initialSelectedIds
 * @param {string[]} intersectingIds
 * @param {{ shift?: boolean, alt?: boolean }} modifiers
 * @returns {string[]}
 */
export function computeMarqueeSelection(
  initialSelectedIds = [],
  intersectingIds = [],
  { shift = false, alt = false } = {}
) {
  const initial = Array.isArray(initialSelectedIds) ? initialSelectedIds : [];
  const hits = Array.isArray(intersectingIds) ? intersectingIds : [];

  if (alt) {
    // Subtract intersecting items
    const hitSet = new Set(hits);
    return initial.filter((id) => !hitSet.has(id));
  }

  if (shift) {
    // Add intersecting items (preserve order, append new)
    const set = new Set(initial);
    for (const id of hits) {
      set.add(id);
    }
    return Array.from(set);
  }

  // Normal: replace with intersecting items
  return hits;
}

/**
 * Computes autoscroll delta (pixels per frame) based on pointer position relative
 * to viewport edge.
 *
 * @param {number} pointerCoord - client coordinate of pointer
 * @param {number} edgeCoord - boundary coordinate of viewport edge (top or bottom)
 * @param {'top'|'bottom'} direction
 * @param {number} [threshold=48] - distance in pixels from edge to trigger autoscroll
 * @param {number} [maxSpeed=24] - maximum scroll speed in px/frame
 * @returns {number} signed scroll delta (negative for up, positive for down, 0 for none)
 */
export function computeAutoscrollDelta(
  pointerCoord,
  edgeCoord,
  direction,
  threshold = 48,
  maxSpeed = 24
) {
  if (direction === "top") {
    // pointerCoord is above or near top edge
    const distance = edgeCoord - pointerCoord;
    if (distance >= -threshold) {
      // Within threshold band or past top edge
      const depth = Math.max(0, distance + threshold);
      const factor = Math.min(1, depth / threshold);
      return -Math.round(Math.max(2, factor * maxSpeed));
    }
    return 0;
  }

  if (direction === "bottom") {
    // pointerCoord is below or near bottom edge
    const distance = pointerCoord - edgeCoord;
    if (distance >= -threshold) {
      // Within threshold band or past bottom edge
      const depth = Math.max(0, distance + threshold);
      const factor = Math.min(1, depth / threshold);
      return Math.round(Math.max(2, factor * maxSpeed));
    }
    return 0;
  }

  return 0;
}
