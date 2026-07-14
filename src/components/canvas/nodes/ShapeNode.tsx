"use client";

import type { ShapeNode as ShapeNodeData } from "@/lib/canvas/types";

/**
 * rect / ellipse / triangle / diamond — all rendered as a single inline SVG
 * sized to the node's box so fill/stroke/corner-radius restyle live without
 * any raster step.
 */
export function ShapeNode({ node }: { node: ShapeNodeData }) {
  const { w, h, fill, stroke, strokeWidth, type } = node;
  const inset = strokeWidth / 2;

  return (
    <svg
      viewBox={`0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`}
      className="h-full w-full overflow-visible"
      preserveAspectRatio="none"
    >
      {type === "rect" && (
        <rect
          x={inset}
          y={inset}
          width={Math.max(w - strokeWidth, 0)}
          height={Math.max(h - strokeWidth, 0)}
          rx={node.cornerRadius ?? 0}
          ry={node.cornerRadius ?? 0}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {type === "ellipse" && (
        <ellipse
          cx={w / 2}
          cy={h / 2}
          rx={Math.max(w / 2 - inset, 0)}
          ry={Math.max(h / 2 - inset, 0)}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {type === "triangle" && (
        <polygon
          points={`${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {type === "diamond" && (
        <polygon
          points={`${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
