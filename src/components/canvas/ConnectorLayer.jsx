"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

import {
  connectorEndTangents,
  connectorPath,
  connectorPointAt,
  connectorPoints,
  resolveEndpoint,
} from "@/lib/canvas/geometry";
import { strokeDasharrayFor } from "./nodes/ShapeNode";

/**
 * Overlaid `<svg>` living INSIDE the world-transformed layer (so it pans/
 * zooms with everything else) rendering every connector + the live marquee
 * rectangle. `connectorPath`/`resolveEndpoint` are the pure functions owned
 * by `src/lib/canvas/geometry.js` - this component only draws what they
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
  onWaypointPointerDown,
  onResetWaypoints,
  onLabelPointerDown,
  onLabelDoubleClick,
  onConnectorContextMenu,
}) {
  const selectedSet = new Set(selectedConnectorIds);
  const earlierSegments = [];

  return (
    <svg
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
        const selected = selectedSet.has(c.id);
        let d = "";
        let pts = [];
        try {
          d = connectorPath(c, nodesById, earlierSegments);
          pts = connectorPoints(c, nodesById);
          const shape = c.shape || "curved";
          if (shape === "straight" || shape === "orthogonal") {
            for (let i = 0; i < pts.length - 1; i++) {
              earlierSegments.push([pts[i], pts[i + 1]]);
            }
          }
        } catch {
          return null;
        }
        const from = safeResolve(c.from, nodesById);
        const to = safeResolve(c.to, nodesById);
        const dash = strokeDasharrayFor(c.strokeStyle, c.strokeWidth);
        const tangents = connectorEndTangents(c, nodesById);
        const startCap = c.startCap ?? "none";
        const endCap = c.endCap ?? (c.kind === "arrow" ? "arrow" : "none");
        const useDefaultMarker = startCap === "none" && endCap === "arrow" && !c.endCap;
        const waypoints = Array.isArray(c.waypoints) ? c.waypoints : [];
        const labels = Array.isArray(c.labels) ? c.labels : [];
        const midPt = connectorPointAt(c, nodesById, 0.5);

        return (
          <g key={c.id} data-connector-id={c.id}>
            {/* fat invisible hit-target so thin strokes stay easy to click */}
            {onSelectConnector && (
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
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (waypoints.length > 0 && onResetWaypoints) {
                    onResetWaypoints(c.id);
                  } else if (onLabelDoubleClick) {
                    onLabelDoubleClick(c.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onConnectorContextMenu?.(e, c.id);
                }}
              />
            )}
            <path
              d={d}
              fill="none"
              stroke={c.stroke}
              strokeWidth={c.strokeWidth}
              strokeOpacity={c.opacity ?? 1}
              strokeDasharray={dash}
              strokeLinecap={c.strokeStyle === "dotted" ? "round" : "butt"}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              markerEnd={useDefaultMarker ? "url(#canvas-arrowhead)" : undefined}
              className={cn(selected && "drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]")}
            />

            {startCap !== "none" && (
              <ConnectorCap
                cap={startCap}
                tip={tangents.start}
                backX={tangents.start.ux}
                backY={tangents.start.uy}
                stroke={c.stroke}
                strokeWidth={c.strokeWidth}
                dataCapEnd="start"
              />
            )}

            {!useDefaultMarker && endCap !== "none" && (
              <ConnectorCap
                cap={endCap}
                tip={tangents.end}
                backX={-tangents.end.ux}
                backY={-tangents.end.uy}
                stroke={c.stroke}
                strokeWidth={c.strokeWidth}
                dataCapEnd="end"
              />
            )}

            {/* Text labels along the connector */}
            {labels.map((label) => {
              const pt = connectorPointAt(c, nodesById, label.t ?? 0.5);
              let rot = label.align === "aligned" ? pt.angle : 0;
              if (rot > 90) rot -= 180;
              if (rot < -90) rot += 180;
              const text = label.text || "";
              const boxW = Math.max(36, text.length * 6.8 + 14);
              const boxH = 20;
              return (
                <g
                  key={label.id}
                  data-connector-label={label.id}
                  transform={`translate(${pt.x}, ${pt.y}) rotate(${rot})`}
                  className="pointer-events-auto cursor-grab"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onLabelPointerDown?.(e, c.id, label.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onLabelDoubleClick?.(c.id, label.id);
                  }}
                >
                  <rect
                    x={-boxW / 2}
                    y={-boxH / 2}
                    width={boxW}
                    height={boxH}
                    rx={4}
                    fill="#18181b"
                    stroke={selected ? "#6366f1" : "rgba(255,255,255,0.25)"}
                    strokeWidth={1}
                  />
                  <text
                    x={0}
                    y={4}
                    textAnchor="middle"
                    fill="#f4f4f5"
                    fontSize={11}
                    fontFamily="sans-serif"
                    className="select-none"
                  >
                    {text}
                  </text>
                </g>
              );
            })}

            {selected && from && to && onEndpointPointerDown && (
              <>
                <EndpointHandle point={from} connectorId={c.id} end="from" onPointerDown={onEndpointPointerDown} />
                <EndpointHandle point={to} connectorId={c.id} end="to" onPointerDown={onEndpointPointerDown} />
              </>
            )}

            {/* Custom bend-point handles (waypoints) */}
            {selected && onWaypointPointerDown && (
              <>
                {waypoints.map((wp, idx) => (
                  <WaypointHandle
                    key={`wp-${idx}`}
                    point={wp}
                    connectorId={c.id}
                    index={idx}
                    isExisting={true}
                    onPointerDown={onWaypointPointerDown}
                    onDoubleClick={() => onResetWaypoints?.(c.id)}
                  />
                ))}
                {waypoints.length === 0 && midPt && (
                  <WaypointHandle
                    point={midPt}
                    connectorId={c.id}
                    index={0}
                    isExisting={false}
                    onPointerDown={onWaypointPointerDown}
                    onDoubleClick={() => onResetWaypoints?.(c.id)}
                  />
                )}
              </>
            )}
          </g>
        );
      })}

      {draftConnector && (
        <path
          d={
            draftConnector.shape === "straight"
              ? `M ${draftConnector.fromPoint.x} ${draftConnector.fromPoint.y} L ${draftConnector.toPoint.x} ${draftConnector.toPoint.y}`
              : simpleBezier(draftConnector.fromPoint, draftConnector.toPoint)
          }
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

function ConnectorCap({ cap, tip, backX, backY, stroke, strokeWidth, dataCapEnd }) {
  const px = -backY;
  const py = backX;
  const pt = (along, perp = 0) => `${tip.x + backX * along + px * perp},${tip.y + backY * along + py * perp}`;
  const common = {
    stroke: stroke || "rgba(255,255,255,0.85)",
    strokeWidth: strokeWidth || 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    vectorEffect: "non-scaling-stroke",
  };

  switch (cap) {
    case "arrow":
      return (
        <polygon
          data-connector-cap={`${dataCapEnd}:${cap}`}
          points={`${pt(0, 0)} ${pt(10, 5)} ${pt(10, -5)}`}
          fill={stroke || "rgba(255,255,255,0.85)"}
        />
      );
    case "open-arrow":
      return (
        <polyline
          data-connector-cap={`${dataCapEnd}:${cap}`}
          points={`${pt(10, 5)} ${pt(0, 0)} ${pt(10, -5)}`}
          fill="none"
          {...common}
        />
      );
    case "diamond":
      return (
        <polygon
          data-connector-cap={`${dataCapEnd}:${cap}`}
          points={`${pt(0, 0)} ${pt(6, 4.5)} ${pt(12, 0)} ${pt(6, -4.5)}`}
          fill="#18181b"
          {...common}
        />
      );
    case "filled-diamond":
      return (
        <polygon
          data-connector-cap={`${dataCapEnd}:${cap}`}
          points={`${pt(0, 0)} ${pt(6, 4.5)} ${pt(12, 0)} ${pt(6, -4.5)}`}
          fill={stroke || "rgba(255,255,255,0.85)"}
          {...common}
        />
      );
    case "circle":
      return (
        <circle
          data-connector-cap={`${dataCapEnd}:${cap}`}
          cx={tip.x + backX * 5}
          cy={tip.y + backY * 5}
          r={4.5}
          fill="#18181b"
          {...common}
        />
      );
    case "erd-one":
      return (
        <line
          data-connector-cap={`${dataCapEnd}:${cap}`}
          x1={tip.x + backX * 6 + px * 6}
          y1={tip.y + backY * 6 + py * 6}
          x2={tip.x + backX * 6 - px * 6}
          y2={tip.y + backY * 6 - py * 6}
          {...common}
        />
      );
    case "erd-only-one":
      return (
        <g data-connector-cap={`${dataCapEnd}:${cap}`}>
          <line
            x1={tip.x + backX * 5 + px * 6}
            y1={tip.y + backY * 5 + py * 6}
            x2={tip.x + backX * 5 - px * 6}
            y2={tip.y + backY * 5 - py * 6}
            {...common}
          />
          <line
            x1={tip.x + backX * 9 + px * 6}
            y1={tip.y + backY * 9 + py * 6}
            x2={tip.x + backX * 9 - px * 6}
            y2={tip.y + backY * 9 - py * 6}
            {...common}
          />
        </g>
      );
    case "erd-many":
      return (
        <g data-connector-cap={`${dataCapEnd}:${cap}`}>
          <polyline points={`${pt(0, 6)} ${pt(11, 0)} ${pt(0, -6)}`} fill="none" {...common} />
        </g>
      );
    case "erd-one-or-many":
      return (
        <g data-connector-cap={`${dataCapEnd}:${cap}`}>
          <polyline points={`${pt(0, 6)} ${pt(11, 0)} ${pt(0, -6)}`} fill="none" {...common} />
          <line
            x1={tip.x + backX * 11 + px * 6}
            y1={tip.y + backY * 11 + py * 6}
            x2={tip.x + backX * 11 - px * 6}
            y2={tip.y + backY * 11 - py * 6}
            {...common}
          />
        </g>
      );
    case "erd-zero-or-one":
      return (
        <g data-connector-cap={`${dataCapEnd}:${cap}`}>
          <line
            x1={tip.x + backX * 5 + px * 6}
            y1={tip.y + backY * 5 + py * 6}
            x2={tip.x + backX * 5 - px * 6}
            y2={tip.y + backY * 5 - py * 6}
            {...common}
          />
          <circle cx={tip.x + backX * 11} cy={tip.y + backY * 11} r={3.5} fill="#18181b" {...common} />
        </g>
      );
    case "erd-zero-or-many":
      return (
        <g data-connector-cap={`${dataCapEnd}:${cap}`}>
          <polyline points={`${pt(0, 6)} ${pt(10, 0)} ${pt(0, -6)}`} fill="none" {...common} />
          <circle cx={tip.x + backX * 14} cy={tip.y + backY * 14} r={3.5} fill="#18181b" {...common} />
        </g>
      );
    default:
      return null;
  }
}

function WaypointHandle({ point, connectorId, index, isExisting, onPointerDown, onDoubleClick }) {
  return (
    <g>
      <circle
        cx={point.x}
        cy={point.y}
        r={8}
        fill="transparent"
        className="pointer-events-auto cursor-grab"
        aria-label={isExisting ? `Connector bend point ${index + 1}` : "Add connector bend point"}
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown?.(e, connectorId, index, point, isExisting);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick?.();
        }}
      />
      <circle
        cx={point.x}
        cy={point.y}
        r={isExisting ? 4 : 3.5}
        fill={isExisting ? "#6366f1" : "rgba(99, 102, 241, 0.7)"}
        stroke="#fff"
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
        className="pointer-events-none"
      />
    </g>
  );
}

function EndpointHandle({ point, connectorId, end, onPointerDown }) {
  const [hovered, setHovered] = useState(false);
  return (
    <g>
      <circle
        cx={point.x}
        cy={point.y}
        r={9}
        fill="transparent"
        className="pointer-events-auto cursor-grab"
        aria-label={`Connector ${end === "from" ? "start" : "end"} endpoint - drag to reattach`}
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

function safeResolve(ep, nodesById) {
  try {
    return resolveEndpoint(ep, nodesById);
  } catch {
    return null;
  }
}

function simpleBezier(a, b) {
  const midX = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`;
}
