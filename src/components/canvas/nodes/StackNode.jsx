"use client";

import { STICKY_COLORS } from "@/lib/canvas/stickies";

/**
 * A sticky stack: a pad of blank stickies in one color. Dragging from it
 * peels off a new sticky (CanvasSurface); the stack itself moves once selected.
 */
export function StackNode({ node }) {
  const ink = STICKY_COLORS.find((color) => color.value === node.fill)?.ink ?? "#1c1a12";
  return (
    <div className="relative h-full w-full" data-sticky-stack="">
      {[8, 4].map((offset) => (
        <div
          key={offset}
          className="absolute inset-0 rounded-md shadow-[0_2px_6px_rgba(0,0,0,0.3)]"
          style={{ background: node.fill, transform: `translate(${offset}px, ${offset}px)`, filter: "brightness(0.82)" }}
        />
      ))}
      <div
        className="absolute inset-0 flex items-end justify-center rounded-md p-3 text-xs font-medium shadow-[0_6px_16px_rgba(0,0,0,0.35)]"
        style={{ background: node.fill, color: ink }}
      >
        <span className="opacity-60">Drag to add a sticky</span>
      </div>
    </div>
  );
}
