"use client";

import { cn } from "@/lib/utils";

const KIND_FILL = { f: "none", s: "#fde68a", t: "#9ca3af", i: "#6b7280", o: "#60a5fa" };

/** A template's thumbnail, drawn from the boxes of its `preview` (never a stored image). */
export function TemplateThumb({ preview, className }) {
  const { w = 1000, h = 750, rects = [] } = preview ?? {};
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Template preview" className={cn("h-full w-full", className)}>
      {rects.map(([x, y, width, height, kind, color], index) => (
        <rect
          key={index}
          x={x}
          y={y}
          width={width}
          height={height}
          rx={kind === "f" ? 6 : 3}
          fill={kind === "t" ? "#9ca3af" : color && kind !== "f" ? color : KIND_FILL[kind] ?? KIND_FILL.o}
          fillOpacity={kind === "t" ? 0.45 : kind === "f" ? 0 : 0.9}
          stroke={kind === "f" ? "#ffffff" : "none"}
          strokeOpacity={0.35}
          strokeWidth={kind === "f" ? 4 : 0}
        />
      ))}
    </svg>
  );
}
