"use client";

import { inkPathD } from "@/lib/canvas/ink";

/** A freehand stroke: one SVG path in the node's own stroke space, scaled to its box. */
export function InkNode({ node }) {
  const vw = node.vw > 0 ? node.vw : node.w;
  const vh = node.vh > 0 ? node.vh : node.h;
  return (
    <svg
      className="absolute inset-0 overflow-visible"
      width={node.w}
      height={node.h}
      viewBox={`0 0 ${vw} ${vh}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {/* A wider invisible path so a thin stroke is easy to grab; only the stroke itself takes pointer events. */}
      <path
        d={inkPathD(node)}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(node.strokeWidth, 14)}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: "stroke" }}
      />
      <path
        d={inkPathD(node)}
        fill="none"
        stroke={node.stroke}
        strokeWidth={node.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className="pointer-events-none"
      />
    </svg>
  );
}
