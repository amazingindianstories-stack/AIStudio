"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { CanvasNode, Connector } from "@/lib/canvas/types";
import { connectorPath, resolveEndpoint } from "@/lib/canvas/geometry";

/**
 * Overlaid `<svg>` living INSIDE the world-transformed layer (so it pans/
 * zooms with everything else) rendering every connector + the live marquee
 * rectangle. `connectorPath`/`resolveEndpoint` are the pure functions owned
 * by `src/lib/canvas/geometry.ts` — this component only draws what they
 * compute, in WORLD coordinates; `vector-effect="non-scaling-stroke"` keeps
 * strokes a constant on-screen width regardless of zoom.
 */
export function ConnectorLayer({
  connectors,
  nodesById,
  selectedConnectorIds,
  onSelectConnector,
  marqueeWorldRect,
  draftConnector,
  onEndpointPointerDown,
  onConnectorContextMenu,
}: {
  connectors: Connector[];
  nodesById: Record<string, CanvasNode>;
  selectedConnectorIds: string[];
  onSelectConnector: (id: string, additive: boolean) => void;
  marqueeWorldRect: { x: number; y: number; w: number; h: number } | null;
  draftConnector: { fromPoint: { x: number; y: number }; toPoint: { x: number; y: number } } | null;
  /** (D) endpoint dots are real drag handles — fires on pointerdown on
   *  either endpoint of a SELECTED connector. */
  onEndpointPointerDown?: (e: React.PointerEvent, connectorId: string, end: "from" | "to") => void;
  /** (C) right-click on a connector's fat hit-path — selects it and opens
   *  `CanvasContextMenu` instead of letting the event bubble to the
   *  container (which would otherwise treat it as an empty-canvas click). */
  onConnectorContextMenu?: (e: React.PointerEvent | React.MouseEvent, connectorId: string) => void;
}) {
  return (
    <svg
      // A width/height of 0 disables rendering of the whole <svg> per the
      // SVG spec — `overflow: visible` does NOT override that, so every
      // child (connectors, arrowheads, the draft line, the marquee) was
      // silently painting nothing. All children draw in absolute world
      // coordinates already, so any nonzero box works; overflow:visible
      // lets them render outside this 1x1px box exactly as intended.
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={1}
      height={1}
      style={{ overflow: "visible" }}
    >
      <defs>
        <marker
          id="canvas-arrowhead"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill="rgba(255,255,255,0.85)" />
        </marker>
      </defs>

      {connectors.map((c) => {
        const selected = selectedConnectorIds.includes(c.id);
        let d = "";
        try {
          d = connectorPath(c, nodesById);
        } catch {
          return null;
        }
        const from = safeResolve(c.from, nodesById);
        const to = safeResolve(c.to, nodesById);
        return (
          <g key={c.id}>
            {/* fat invisible hit-target so thin strokes stay easy to click */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              className="pointer-events-auto cursor-pointer"
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectConnector(c.id, e.shiftKey);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onConnectorContextMenu?.(e, c.id);
              }}
            />
            <path
              d={d}
              fill="none"
              stroke={c.stroke}
              strokeWidth={c.strokeWidth}
              strokeOpacity={c.opacity ?? 1}
              vectorEffect="non-scaling-stroke"
              markerEnd={c.kind === "arrow" ? "url(#canvas-arrowhead)" : undefined}
              className={cn(selected && "drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]")}
            />
            {selected && from && to && (
              <>
                <EndpointHandle point={from} connectorId={c.id} end="from" onPointerDown={onEndpointPointerDown} />
                <EndpointHandle point={to} connectorId={c.id} end="to" onPointerDown={onEndpointPointerDown} />
              </>
            )}
          </g>
        );
      })}

      {draftConnector && (
        <path
          d={simpleBezier(draftConnector.fromPoint, draftConnector.toPoint)}
          fill="none"
          stroke="rgba(255,255,255,0.7)"
          strokeWidth={2}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          markerEnd="url(#canvas-arrowhead)"
        />
      )}

      {marqueeWorldRect && (
        <rect
          x={marqueeWorldRect.x}
          y={marqueeWorldRect.y}
          width={marqueeWorldRect.w}
          height={marqueeWorldRect.h}
          fill="rgba(255,255,255,0.1)"
          stroke="rgba(255,255,255,0.6)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/**
 * A selected connector's endpoint dot (ui-spec §D). At rest it is pixel-
 * for-pixel what shipped before (r=4 white/black dot, D.1/A4) — a larger
 * INVISIBLE hit circle underneath (r=9) is the real drag handle, mirroring
 * the connector body's own fat-invisible-hit-path pattern above. Hovering
 * the hit target adds a faint halo ring (the same `brand`-at-0.6 accent the
 * board already uses for the create-flow reattach highlight).
 */
function EndpointHandle({
  point,
  connectorId,
  end,
  onPointerDown,
}: {
  point: { x: number; y: number };
  connectorId: string;
  end: "from" | "to";
  onPointerDown?: (e: React.PointerEvent, connectorId: string, end: "from" | "to") => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <g>
      <circle
        cx={point.x}
        cy={point.y}
        r={9}
        fill="transparent"
        className="pointer-events-auto cursor-grab"
        aria-label={`Connector ${end === "from" ? "start" : "end"} endpoint — drag to reattach`}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown?.(e, connectorId, end);
        }}
      />
      {hovered && (
        <circle
          cx={point.x}
          cy={point.y}
          r={7}
          fill="none"
          stroke="rgba(255,255,255,0.6)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="pointer-events-none"
        />
      )}
      <circle
        cx={point.x}
        cy={point.y}
        r={4}
        fill="white"
        stroke="#000"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        className="pointer-events-none"
      />
    </g>
  );
}

function safeResolve(
  ep: Parameters<typeof resolveEndpoint>[0],
  nodesById: Record<string, CanvasNode>
) {
  try {
    return resolveEndpoint(ep, nodesById);
  } catch {
    return null;
  }
}

function simpleBezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const midX = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`;
}
