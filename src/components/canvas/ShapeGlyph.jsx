"use client";

import { pointsToPath, shapeDetails, shapeKindOfTool, shapeOutline } from "@/lib/canvas/shapes";

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
export function ShapeGlyph({ tool, className, customSvg, customViewBox }) {
  if (customSvg) {
    return (
      <svg
        viewBox={customViewBox || "0 0 100 100"}
        className={className}
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        dangerouslySetInnerHTML={{ __html: customSvg }}
      />
    );
  }
  const [w, h] = GLYPH_BOX[tool] ?? [15, 13];
  const x = (18 - w) / 2;
  const y = (18 - h) / 2;
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round" };
  let body;
  if (tool === "rect" || tool === "rect-rounded") {
    body = <rect x={x} y={y} width={w} height={h} rx={tool === "rect-rounded" ? 3.5 : 0.5} {...common} />;
  } else if (tool === "ellipse") {
    body = <ellipse cx={9} cy={9} rx={w / 2} ry={h / 2} {...common} />;
  } else if (tool === "triangle") {
    body = <polygon points={`9,${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />;
  } else if (tool === "diamond") {
    body = <polygon points={`9,${y} ${x + w},9 9,${y + h} ${x},9`} {...common} />;
  } else if (tool === "erd") {
    body = (
      <>
        <rect x={2} y={2.5} width={14} height={13} rx={1.5} {...common} />
        <line x1={2} y1={6.5} x2={16} y2={6.5} {...common} />
        <line x1={6.5} y1={6.5} x2={6.5} y2={15.5} {...common} />
      </>
    );
  } else if (tool === "swimlane") {
    body = (
      <>
        <rect x={1.5} y={2.5} width={15} height={13} rx={1} {...common} />
        <line x1={1.5} y1={9} x2={16.5} y2={9} {...common} />
        <line x1={5} y1={2.5} x2={5} y2={15.5} {...common} />
      </>
    );
  } else if (tool === "swimlane-vertical") {
    body = (
      <>
        <rect x={2.5} y={1.5} width={13} height={15} rx={1} {...common} />
        <line x1={9} y1={1.5} x2={9} y2={16.5} {...common} />
        <line x1={2.5} y1={5} x2={15.5} y2={5} {...common} />
      </>
    );
  } else if (tool === "diagram") {
    body = (
      <>
        <rect x={1.5} y={2.5} width={15} height={13} rx={1.5} strokeDasharray="2.5 1.5" {...common} />
        <rect x={4} y={6} width={4} height={3.5} {...common} />
        <rect x={10} y={9.5} width={4} height={3.5} {...common} />
      </>
    );
  } else {
    const kind = shapeKindOfTool(tool);
    const shift = (points) => points.map(([px, py]) => [px + x, py + y]);
    const details = shapeDetails(kind, w, h);
    body = (
      <>
        <path d={pointsToPath(shift(shapeOutline(kind, w, h)))} {...common} />
        {details.map((poly, idx) => (
          <path key={idx} d={pointsToPath(shift(poly), false)} {...common} />
        ))}
      </>
    );
  }
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden="true">
      {body}
    </svg>
  );
}
