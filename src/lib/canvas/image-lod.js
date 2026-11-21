/**
 * Zoom-aware Level-of-Detail (LOD) and viewport load-priority math for board images.
 *
 * Pure geometry/tier functions: kept free of DOM/React state so unit tests cover
 * every zoom boundary, hysteresis rule, and overscan threshold deterministically.
 */

import { nodeBounds } from "./geometry";
import { cullRect } from "./culling";

/** Backend derivative widths (must stay aligned with apps.media.derivatives.THUMB_WIDTHS). */
export const IMAGE_THUMB_TIERS = [256, 512, 1280];

/**
 * Screen-pixel margin beyond the visible viewport within which an ImageNode
 * actively fetches and holds a decoded bitmap. Nodes further away (still mounted
 * by cullBoard's 900px overscan for smooth drag/connector interaction) stay as
 * lightweight placeholders until they approach the screen.
 */
export const IMAGE_LOAD_OVERSCAN_PX = 180;

/** Downgrade hysteresis thresholds to reclaim large bitmaps when zooming far out without jitter. */
const DOWNGRADE_FROM_FULL_PX = 960;
const DOWNGRADE_FROM_1280_PX = 280;

export function tierRank(tier) {
  if (tier === 256) return 0;
  if (tier === 512) return 1;
  if (tier === 1280) return 2;
  return 3; // null => full-resolution original
}

/**
 * Choose the derivative width (256, 512, 1280) or `null` (full-resolution master)
 * for an image node whose drawn image element has world width `renderedW` at `zoom`.
 */
export function selectImageTier({
  renderedW,
  zoom = 1,
  dpr = 1,
  naturalW = 0,
  cropMode = false,
  currentTier = undefined,
}) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeW = Number.isFinite(renderedW) && renderedW > 0 ? renderedW : 0;
  const effectiveDpr = Math.min(Math.max(Number(dpr) || 1, 1), 2);
  const physicalPx = safeW * safeZoom * effectiveDpr;

  let desired;
  if (cropMode && physicalPx > DOWNGRADE_FROM_FULL_PX) {
    desired = null;
  } else if (physicalPx <= 256) {
    desired = 256;
  } else if (physicalPx <= 512) {
    desired = 512;
  } else if (physicalPx <= 1280) {
    desired = 1280;
  } else {
    desired = null;
  }

  // If the original itself is small (known naturalW), avoid requesting a tier
  // larger than necessary unless we explicitly want the full original.
  if (Number.isFinite(naturalW) && naturalW > 0 && desired !== null) {
    const smallestCoveringOriginal = IMAGE_THUMB_TIERS.find((t) => t >= naturalW);
    if (smallestCoveringOriginal !== undefined && smallestCoveringOriginal < desired) {
      desired = smallestCoveringOriginal;
    }
  }

  if (currentTier === undefined) return desired;

  const curRank = tierRank(currentTier);
  const nextRank = tierRank(desired);

  // Always upgrade when zooming in.
  if (nextRank >= curRank) return desired;

  // Hysteresis on zoom-out: reclaim full-res / 1280 memory once well below threshold,
  // but never churn between small thumbnail tiers.
  if (currentTier === null && physicalPx < DOWNGRADE_FROM_FULL_PX) return desired;
  if (currentTier === 1280 && physicalPx < DOWNGRADE_FROM_1280_PX) return desired;
  return currentTier;
}

/**
 * Determine whether `node` should load its image right now and compute its
 * center-first priority distance in screen-pixel squared units.
 */
export function imageLoadVisibility(node, viewport, size, overscanPx = IMAGE_LOAD_OVERSCAN_PX) {
  if (!viewport || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) {
    return { shouldLoad: true, inViewport: true, distanceSq: 0 };
  }
  const b = node.rotation ? nodeBounds(node) : node;
  const screen = { w: size && size.w > 0 ? size.w : 1600, h: size && size.h > 0 ? size.h : 900 };
  const view = cullRect(viewport, screen, 0);
  const near = cullRect(viewport, screen, overscanPx);
  const inViewport = b.x + b.w >= view.left && b.x <= view.right && b.y + b.h >= view.top && b.y <= view.bottom;
  const shouldLoad =
    inViewport || (b.x + b.w >= near.left && b.x <= near.right && b.y + b.h >= near.top && b.y <= near.bottom);

  const vcx = (view.left + view.right) / 2;
  const vcy = (view.top + view.bottom) / 2;
  const dx = (b.x + b.w / 2 - vcx) * viewport.zoom;
  const dy = (b.y + b.h / 2 - vcy) * viewport.zoom;

  return { shouldLoad, inViewport, distanceSq: dx * dx + dy * dy };
}


/**
 * Everything an image node derives from the viewport, reduced to the values that
 * can change what it loads: visibility and which tier/hysteresis band it is in.
 * Equal keys mean a pan or zoom cannot change the node's image.
 */
export function imageViewportKey(node, viewport, size, { cropZoom = 1, dpr = 1 } = {}) {
  if (!viewport) return "none";
  const { shouldLoad, inViewport } = imageLoadVisibility(node, viewport, size);
  const naturalW = node.naturalW || node.w;
  const naturalH = node.naturalH || node.h;
  const renderedW = naturalW * Math.max(node.w / naturalW, node.h / naturalH) * cropZoom;
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const physicalPx = renderedW * zoom * Math.min(Math.max(Number(dpr) || 1, 1), 2);
  const band =
    [256, 512, 1280].filter((edge) => physicalPx > edge).length +
    [DOWNGRADE_FROM_1280_PX, DOWNGRADE_FROM_FULL_PX].filter((edge) => physicalPx >= edge).length;
  return `${shouldLoad ? 1 : 0}${inViewport ? 1 : 0}:${band}`;
}
