"use client";

import { Eye, EyeOff, Focus, Layers, Plus, BoxSelect } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas-store";

export function DiagramNode({ node, selected, readOnly }) {
  const updateNodeFields = useCanvasStore((s) => s.updateNodeFields);
  const focusedDiagramId = useCanvasStore((s) => s.focusedDiagramId);
  const setFocusedDiagramId = useCanvasStore((s) => s.setFocusedDiagramId);
  const isFocused = focusedDiagramId === node.id;

  const layers = Array.isArray(node.layers) && node.layers.length > 0
    ? node.layers
    : [{ id: "layer-main", name: "Core layer", visible: true }];
  const containers = Array.isArray(node.containers) ? node.containers : [];

  const toggleLayerVisibility = (e, layerId) => {
    e.stopPropagation();
    const nextLayers = layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l));
    updateNodeFields(node.id, { layers: nextLayers });
  };

  const addLayer = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const nextLayers = [
      ...layers,
      { id: `layer-${crypto.randomUUID().slice(0, 8)}`, name: `Layer ${layers.length + 1}`, visible: true },
    ];
    updateNodeFields(node.id, { layers: nextLayers });
  };

  const addSubContainer = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const offset = containers.length * 24;
    const nextContainers = [
      ...containers,
      {
        id: `sub-${crypto.randomUUID().slice(0, 8)}`,
        title: `Sub-container ${containers.length + 1}`,
        x: 28 + offset,
        y: 64 + offset,
        w: Math.min(220, Math.max(120, node.w - 64)),
        h: Math.min(140, Math.max(90, node.h - 96)),
        fill: "rgba(99, 102, 241, 0.08)",
        stroke: node.stroke || "#6366f1",
      },
    ];
    updateNodeFields(node.id, { containers: nextContainers });
  };

  const toggleFocus = (e) => {
    e.stopPropagation();
    setFocusedDiagramId(isFocused ? null : node.id);
  };

  return (
    <div
      data-diagram-node={node.id}
      className="relative flex h-full w-full flex-col rounded-lg select-none"
      style={{
        backgroundColor: node.fill || "rgba(15, 23, 42, 0.35)",
        border: `${node.strokeWidth ?? 2}px dashed ${node.stroke || "#6366f1"}`,
      }}
    >
      {/* Diagram Header & Topic Layers Bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 text-xs"
        style={{
          backgroundColor: "rgba(15, 23, 42, 0.75)",
          borderColor: node.stroke || "#6366f1",
        }}
      >
        <div className="flex items-center gap-2">
          <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
            Diagram
          </span>
          {selected && !readOnly ? (
            <input
              type="text"
              aria-label="Diagram title"
              value={node.name ?? "System Diagram"}
              onChange={(e) => updateNodeFields(node.id, { name: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-36 bg-transparent font-semibold text-white outline-none"
            />
          ) : (
            <span className="font-semibold text-white">{node.name || "System Diagram"}</span>
          )}
        </div>

        {/* Layers & Focus Mode Controls */}
        <div className="flex flex-wrap items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1 rounded bg-black/40 px-1.5 py-0.5">
            <Layers className="h-3 w-3 text-zinc-400" />
            {layers.map((layer) => (
              <button
                key={layer.id}
                type="button"
                aria-label={`Toggle diagram layer ${layer.name}`}
                onClick={(e) => toggleLayerVisibility(e, layer.id)}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition ${
                  layer.visible !== false
                    ? "bg-indigo-500/30 text-indigo-200"
                    : "bg-zinc-800 text-zinc-500 line-through"
                }`}
              >
                {layer.visible !== false ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                <span>{layer.name}</span>
              </button>
            ))}
            {selected && !readOnly && (
              <button
                type="button"
                aria-label="Add diagram layer"
                onClick={addLayer}
                className="rounded px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-white/10 hover:text-white"
                title="Add topic layer"
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>

          {selected && !readOnly && (
            <button
              type="button"
              aria-label="Add diagram sub-container"
              onClick={addSubContainer}
              className="flex items-center gap-1 rounded bg-black/40 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-black/60"
            >
              <BoxSelect className="h-3 w-3" />
              <span>Sub-container</span>
            </button>
          )}

          <button
            type="button"
            aria-label={isFocused ? "Exit diagram focus mode" : "Enter diagram focus mode"}
            onClick={toggleFocus}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition ${
              isFocused
                ? "bg-indigo-500 text-white"
                : "bg-black/40 text-zinc-200 hover:bg-black/60"
            }`}
          >
            <Focus className="h-3 w-3" />
            <span>{isFocused ? "Exit Focus" : "Focus mode"}</span>
          </button>
        </div>
      </div>

      {/* Sub-containers inside the diagram */}
      <div className="relative flex-1">
        {containers.map((sub, idx) => (
          <div
            key={sub.id || idx}
            data-diagram-subcontainer={sub.id}
            className="absolute rounded border border-dashed p-2 text-[11px] text-indigo-200"
            style={{
              left: sub.x,
              top: sub.y - 36,
              width: sub.w,
              height: sub.h,
              backgroundColor: sub.fill || "rgba(99, 102, 241, 0.08)",
              borderColor: sub.stroke || "#6366f1",
            }}
          >
            <span className="font-medium">{sub.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
