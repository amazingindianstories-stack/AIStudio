"use client";

import { ArrowDown, ArrowUp, Columns, Plus, Rows, Trash2 } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas-store";

const POOL_HEADER_H = 34;
const LANE_HEADER_SIZE = 36;

export function SwimlaneNode({ node, selected, readOnly }) {
  const updateNodeFields = useCanvasStore((s) => s.updateNodeFields);
  const orientation = node.orientation === "vertical" ? "vertical" : "horizontal";
  const lanes = Array.isArray(node.lanes) && node.lanes.length > 0
    ? node.lanes
    : [
        { id: "lane-1", title: "Lane 1", size: 160 },
        { id: "lane-2", title: "Lane 2", size: 160 },
      ];

  const totalSize = lanes.reduce((acc, l) => acc + (l.size || 160), 0);

  const renameLane = (idx, title) => {
    if (readOnly) return;
    const nextLanes = lanes.map((l, i) => (i === idx ? { ...l, title } : l));
    updateNodeFields(node.id, { lanes: nextLanes });
  };

  const addLane = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const defaultSize = 150;
    const nextLanes = [
      ...lanes,
      { id: `lane-${crypto.randomUUID().slice(0, 8)}`, title: `Lane ${lanes.length + 1}`, size: defaultSize },
    ];
    if (orientation === "horizontal") {
      updateNodeFields(node.id, { lanes: nextLanes, h: node.h + defaultSize });
    } else {
      updateNodeFields(node.id, { lanes: nextLanes, w: node.w + defaultSize });
    }
  };

  const removeLane = (e, idx) => {
    e.stopPropagation();
    if (readOnly || lanes.length <= 1) return;
    const removed = lanes[idx];
    const nextLanes = lanes.filter((_, i) => i !== idx);
    if (orientation === "horizontal") {
      updateNodeFields(node.id, { lanes: nextLanes, h: Math.max(160, node.h - (removed.size || 150)) });
    } else {
      updateNodeFields(node.id, { lanes: nextLanes, w: Math.max(240, node.w - (removed.size || 150)) });
    }
  };

  const moveLane = (e, idx, dir) => {
    e.stopPropagation();
    const targetIdx = idx + dir;
    if (readOnly || targetIdx < 0 || targetIdx >= lanes.length) return;
    const nextLanes = [...lanes];
    const temp = nextLanes[idx];
    nextLanes[idx] = nextLanes[targetIdx];
    nextLanes[targetIdx] = temp;
    updateNodeFields(node.id, { lanes: nextLanes });
  };

  const toggleOrientation = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const nextOrientation = orientation === "horizontal" ? "vertical" : "horizontal";
    updateNodeFields(node.id, { orientation: nextOrientation, w: node.h, h: node.w });
  };

  const startLaneResize = (e, idx) => {
    e.stopPropagation();
    if (readOnly) return;
    const startClient = orientation === "horizontal" ? e.clientY : e.clientX;
    const startSize = lanes[idx]?.size || 160;
    const startNodeDim = orientation === "horizontal" ? node.h : node.w;
    const zoom = useCanvasStore.getState().history.present.viewport.zoom || 1;

    const onMove = (moveEv) => {
      const currClient = orientation === "horizontal" ? moveEv.clientY : moveEv.clientX;
      const delta = (currClient - startClient) / zoom;
      const newSize = Math.max(70, Math.round(startSize + delta));
      const sizeDiff = newSize - startSize;
      const nextLanes = lanes.map((l, i) => (i === idx ? { ...l, size: newSize } : l));
      if (orientation === "horizontal") {
        updateNodeFields(node.id, { lanes: nextLanes, h: Math.max(140, startNodeDim + sizeDiff) }, { coalesce: true });
      } else {
        updateNodeFields(node.id, { lanes: nextLanes, w: Math.max(200, startNodeDim + sizeDiff) }, { coalesce: true });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      data-swimlane-node={node.id}
      className="flex h-full w-full flex-col overflow-hidden rounded-md select-none"
      style={{
        backgroundColor: node.fill || "rgba(24, 24, 27, 0.45)",
        border: `${node.strokeWidth ?? 2}px ${node.strokeStyle || "solid"} ${node.stroke || "#52525b"}`,
        color: node.color || "#f4f4f5",
      }}
    >
      {/* Pool Header */}
      <div
        className="flex items-center justify-between border-b px-3 text-xs font-semibold"
        style={{
          height: POOL_HEADER_H,
          minHeight: POOL_HEADER_H,
          backgroundColor: node.headerFill || "rgba(63, 63, 70, 0.55)",
          borderColor: node.stroke || "#52525b",
        }}
      >
        {selected && !readOnly ? (
          <input
            type="text"
            aria-label="Swimlane pool name"
            value={node.name ?? "Swimlane Pool"}
            onChange={(e) => updateNodeFields(node.id, { name: e.target.value })}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-48 bg-transparent text-xs font-semibold outline-none"
          />
        ) : (
          <span className="truncate">{node.name || "Swimlane Pool"}</span>
        )}

        {selected && !readOnly && (
          <div className="flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="Toggle swimlane orientation"
              onClick={toggleOrientation}
              className="flex items-center gap-1 rounded bg-black/30 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-black/50"
            >
              {orientation === "horizontal" ? <Rows className="h-3 w-3" /> : <Columns className="h-3 w-3" />}
              <span>{orientation === "horizontal" ? "Horizontal" : "Vertical"}</span>
            </button>
            <button
              type="button"
              aria-label="Add swimlane"
              onClick={addLane}
              className="flex items-center gap-1 rounded bg-indigo-500/80 px-2 py-0.5 text-[10px] text-white hover:bg-indigo-500"
            >
              <Plus className="h-3 w-3" />
              <span>Add lane</span>
            </button>
          </div>
        )}
      </div>

      {/* Lanes Body */}
      <div className={`flex flex-1 ${orientation === "horizontal" ? "flex-col" : "flex-row"}`}>
        {lanes.map((lane, idx) => {
          const pct = totalSize > 0 ? ((lane.size || 160) / totalSize) * 100 : 100 / lanes.length;
          return (
            <div
              key={lane.id || idx}
              data-swimlane-lane={lane.id}
              className={`group relative flex ${
                orientation === "horizontal"
                  ? "flex-row border-b last:border-b-0"
                  : "flex-col border-r last:border-r-0"
              }`}
              style={{
                borderColor: node.stroke || "#52525b",
                ...(orientation === "horizontal" ? { height: `${pct}%` } : { width: `${pct}%` }),
              }}
            >
              {/* Lane Title Sidebar / Header */}
              <div
                className={`flex items-center justify-between bg-white/[0.04] px-2 text-[11px] font-medium ${
                  orientation === "horizontal" ? "border-r" : "border-b"
                }`}
                style={{
                  borderColor: node.stroke || "#52525b",
                  ...(orientation === "horizontal"
                    ? { width: 110, minWidth: 110 }
                    : { height: LANE_HEADER_SIZE, minHeight: LANE_HEADER_SIZE }),
                }}
              >
                {selected && !readOnly ? (
                  <input
                    type="text"
                    aria-label={`Lane ${idx + 1} title`}
                    value={lane.title ?? `Lane ${idx + 1}`}
                    onChange={(e) => renameLane(idx, e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="w-full bg-transparent text-[11px] font-medium outline-none"
                  />
                ) : (
                  <span className="truncate">{lane.title || `Lane ${idx + 1}`}</span>
                )}

                {selected && !readOnly && (
                  <div className="ml-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100" onPointerDown={(e) => e.stopPropagation()}>
                    {idx > 0 && (
                      <button
                        type="button"
                        aria-label={`Move lane ${idx + 1} earlier`}
                        onClick={(e) => moveLane(e, idx, -1)}
                        className="rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-white"
                      >
                        <ArrowUp className="h-2.5 w-2.5" />
                      </button>
                    )}
                    {idx < lanes.length - 1 && (
                      <button
                        type="button"
                        aria-label={`Move lane ${idx + 1} later`}
                        onClick={(e) => moveLane(e, idx, 1)}
                        className="rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-white"
                      >
                        <ArrowDown className="h-2.5 w-2.5" />
                      </button>
                    )}
                    {lanes.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove lane ${idx + 1}`}
                        onClick={(e) => removeLane(e, idx)}
                        className="rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-rose-400"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Lane Content Area */}
              <div className="relative flex-1" />

              {/* Lane Resize Handle */}
              {!readOnly && selected && (
                <div
                  role="separator"
                  aria-label={`Resize lane ${idx + 1}`}
                  onPointerDown={(e) => startLaneResize(e, idx)}
                  className={
                    orientation === "horizontal"
                      ? "absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize hover:bg-indigo-500/40"
                      : "absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-indigo-500/40"
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
