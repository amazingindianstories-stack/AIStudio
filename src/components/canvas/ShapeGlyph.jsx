"use client";

import { pointsToPath, shapeDetail, shapeKindOfTool, shapeOutline } from "@/lib/canvas/shapes";

// Glyph boxes (w x h inside an 18 x 18 view) that echo each shape's default proportions.
const GLYPH_BOX = {
  rect: [16, 12],
  "rect-rounded": [16, 12],
  ellipse: [15, 15],
  triangle: [16, 14],
  diamond: [16, 16],
  "shape:pentagon": [15, 14.4],
  "shape:hexagon": [16, 14],
  "shape:octagon": [15, 15],
  "shape:star": [16, 15.2],
  "shape:cross": [14, 14],
  "shape:cylinder": [12, 16],
  "shape:cloud": [17, 12],
  "shape:callout": [16, 14],
};

/** A small outline icon for a shapes-panel tool, drawn from the same catalogue. */
export function ShapeGlyph({ tool, className }) {
  const [w, h] = GLYPH_BOX[tool] ?? [16, 11];
  const x = (18 - w) / 2;
  const y = (18 - h) / 2;
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" };
  let body;
  if (tool === "rect" || tool === "rect-rounded") {
    body = <rect x={x} y={y} width={w} height={h} rx={tool === "rect-rounded" ? 3.5 : 0.5} {...common} />;
  } else if (tool === "ellipse") {
    body = <ellipse cx={9} cy={9} rx={w / 2} ry={h / 2} {...common} />;
  } else if (tool === "triangle") {
    body = <polygon points={`9,${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />;
  } else if (tool === "diamond") {
    body = <polygon points={`9,${y} ${x + w},9 9,${y + h} ${x},9`} {...common} />;
  } else {
    const kind = shapeKindOfTool(tool);
    const shift = (points) => points.map(([px, py]) => [px + x, py + y]);
    const detail = shapeDetail(kind, w, h);
    body = (
      <>
        <path d={pointsToPath(shift(shapeOutline(kind, w, h)))} {...common} />
        {detail && <path d={pointsToPath(shift(detail), false)} {...common} />}
      </>
    );
  }
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden="true">
      {body}
    </svg>
  );
}
