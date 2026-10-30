/**
 * Pure maths and constants behind the board's view aids: background colors,
 * the background grid, content bounds, the minimap, scroll bars and the
 * selection size label. Everything works from board data, never the DOM, so
 * it covers objects that viewport culling has not mounted.
 */
import { unionBounds } from "./geometry";
import { GRID_SIZE } from "./view-prefs";

// The board's default background (the app's ink-900); a board without a
// `settings.background` uses it and follows the app theme.
export const DEFAULT_BOARD_BACKGROUND = "#070708";

// Eleven deep tones that keep the dark app's contrast with stickies, images
// and white text. The first is the default and is stored as no setting.
export const BOARD_BACKGROUNDS = [
  { value: null, color: DEFAULT_BOARD_BACKGROUND, name: "Default" },
  { value: "#17181b", color: "#17181b", name: "Charcoal" },
  { value: "#1a2029", color: "#1a2029", name: "Slate" },
  { value: "#121a2e", color: "#121a2e", name: "Navy" },
  { value: "#1d1a35", color: "#1d1a35", name: "Indigo" },
  { value: "#28192f", color: "#28192f", name: "Plum" },
  { value: "#2c161c", color: "#2c161c", name: "Wine" },
  { value: "#2d1c14", color: "#2d1c14", name: "Rust" },
  { value: "#23251a", color: "#23251a", name: "Olive" },
  { value: "#13251c", color: "#13251c", name: "Forest" },
  { value: "#10252a", color: "#10252a", name: "Teal" },
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The color a board's background renders with. */
export function boardBackgroundColor(settings) {
  const value = settings?.background;
  return typeof value === "string" && HEX_COLOR.test(value) ? value : DEFAULT_BOARD_BACKGROUND;
}

export const GRID_STYLES = ["dots", "lines", "none"];

// Grid cells drawn closer than this on screen merge into a coarser grid
// (every 4th line), so a far zoom-out shows a calm grid instead of noise.
const MIN_GRID_PX = 8;
const GRID_INK = "rgba(255,255,255,0.06)";
const GRID_LINE_INK = "rgba(255,255,255,0.05)";

/** The screen spacing of grid cells at `zoom`. */
export function gridSpacing(zoom) {
  let spacing = GRID_SIZE * zoom;
  while (spacing > 0 && spacing < MIN_GRID_PX) spacing *= 4;
  return spacing;
}

/**
 * CSS background (image, size, position) drawing the grid for `viewport`,
 * or `{}` for no grid. The grid scales with zoom and stays fixed to the world.
 */
export function gridBackground(grid, viewport) {
  if (grid !== "dots" && grid !== "lines") return {};
  const spacing = gridSpacing(viewport.zoom);
  const position = `${-viewport.x * viewport.zoom}px ${-viewport.y * viewport.zoom}px`;
  if (grid === "dots") {
    return {
      backgroundImage: `radial-gradient(${GRID_INK} 1px, transparent 1px)`,
      backgroundSize: `${spacing}px ${spacing}px`,
      backgroundPosition: position,
    };
  }
  return {
    backgroundImage: `linear-gradient(to right, ${GRID_LINE_INK} 1px, transparent 1px), linear-gradient(to bottom, ${GRID_LINE_INK} 1px, transparent 1px)`,
    backgroundSize: `${spacing}px ${spacing}px, ${spacing}px ${spacing}px`,
    backgroundPosition: `${position}, ${position}`,
  };
}

/** The next grid style for the G key: cycles dots, lines, none. */
export function nextGridStyle(grid) {
  const index = GRID_STYLES.indexOf(grid);
  return GRID_STYLES[(index + 1) % GRID_STYLES.length];
}

/** The world rectangle the board view shows. */
export function viewRect(viewport, size) {
  return { x: viewport.x, y: viewport.y, w: size.w / viewport.zoom, h: size.h / viewport.zoom };
}

/**
 * The world area the minimap and the scroll bars span: the content (padded)
 * together with the current view, so the view is always on the map.
 */
export function navigationExtent(content, view, pad = 200) {
  const padded = content ? { x: content.x - pad, y: content.y - pad, w: content.w + pad * 2, h: content.h + pad * 2 } : null;
  return unionBounds(padded ? [padded, view] : [view]);
}

/**
 * Fits `extent` into a `width` x `height` map, centred and kept `inset` px
 * clear of the edges: `scale` (map px per world unit) and the map position
 * of the extent's top-left corner.
 */
export function minimapTransform(extent, width, height, inset = 0) {
  const innerW = Math.max(width - inset * 2, 1);
  const innerH = Math.max(height - inset * 2, 1);
  const scale = Math.min(innerW / Math.max(extent.w, 1), innerH / Math.max(extent.h, 1));
  return {
    scale,
    offsetX: (width - extent.w * scale) / 2,
    offsetY: (height - extent.h * scale) / 2,
    extent,
  };
}

/** A world box in map pixels. */
export function toMinimap(transform, box) {
  const { scale, offsetX, offsetY, extent } = transform;
  return { x: offsetX + (box.x - extent.x) * scale, y: offsetY + (box.y - extent.y) * scale, w: box.w * scale, h: box.h * scale };
}

/** The world point under a map pixel. */
export function fromMinimap(transform, point) {
  const { scale, offsetX, offsetY, extent } = transform;
  return { x: extent.x + (point.x - offsetX) / scale, y: extent.y + (point.y - offsetY) / scale };
}

/** The viewport centred on `world`, keeping the zoom. */
export function centerViewportOn(viewport, world, size) {
  return { ...viewport, x: world.x - size.w / 2 / viewport.zoom, y: world.y - size.h / 2 / viewport.zoom };
}

export const MIN_THUMB_PX = 24;

/**
 * One scroll bar's thumb: `offset` and `length` in track pixels for a view
 * at `viewStart` of `viewLength` world units inside an extent at
 * `extentStart` of `extentLength`. `ratio` turns thumb pixels into world units.
 */
export function scrollThumb(extentStart, extentLength, viewStart, viewLength, trackLength) {
  const total = Math.max(extentLength, viewLength, 1);
  const length = Math.min(trackLength, Math.max(MIN_THUMB_PX, (viewLength / total) * trackLength));
  const travel = trackLength - length;
  const room = total - viewLength;
  const offset = room > 0 ? Math.min(travel, Math.max(0, ((viewStart - extentStart) / room) * travel)) : 0;
  const ratio = travel > 0 ? room / travel : 0;
  return { offset, length, ratio };
}

/**
 * The size label for the selected nodes: one node shows its own width and
 * height; several show the box around them all. Null when none.
 */
export function selectionSize(nodes, boundsOf) {
  if (!nodes.length) return null;
  const box = unionBounds(nodes.map(boundsOf));
  if (nodes.length === 1) return { box, w: Math.round(nodes[0].w), h: Math.round(nodes[0].h) };
  return { box, w: Math.round(box.w), h: Math.round(box.h) };
}

/** The board surface's CSS background: the board color under the grid. */
export function surfaceBackground(grid, viewport, settings) {
  return { backgroundColor: boardBackgroundColor(settings), ...gridBackground(grid, viewport) };
}
