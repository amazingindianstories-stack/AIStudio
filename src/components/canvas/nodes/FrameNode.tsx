"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { FrameNode as FrameNodeData } from "@/lib/canvas/types";

/**
 * Labeled rectangular container. Border is solid `lineStrong` once it has
 * children, dashed while empty ("drop things here"); a very faint tint fill
 * reads as a distinct plane above the grid. The label floats just above the
 * top border, plain editable text (double-click to edit).
 */
export function FrameNode({
  node,
  hasChildren,
  editingLabel,
  dropHighlight,
  onCommitLabel,
  onCancelLabelEdit,
  onLabelDoubleClick,
}: {
  node: FrameNodeData;
  hasChildren: boolean;
  editingLabel: boolean;
  dropHighlight: boolean;
  onCommitLabel: (name: string) => void;
  onCancelLabelEdit: () => void;
  onLabelDoubleClick: (e: React.MouseEvent) => void;
}) {
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingLabel) labelRef.current?.select();
  }, [editingLabel]);

  return (
    <div className="relative h-full w-full">
      <div
        className={cn(
          "absolute -top-6 left-0 max-w-full",
          "text-sm font-medium text-white/70"
        )}
      >
        {editingLabel ? (
          <input
            ref={labelRef}
            autoFocus
            defaultValue={node.name}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => onCommitLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelLabelEdit();
              }
            }}
            className="w-56 max-w-full border-b border-white/40 bg-transparent text-sm font-medium text-white/90 outline-none"
          />
        ) : (
          <span
            onDoubleClick={onLabelDoubleClick}
            onPointerDown={(e) => e.stopPropagation()}
            className="block truncate hover:underline hover:decoration-white/30"
            title={node.name}
          >
            {node.name || "Untitled frame"}
          </span>
        )}
      </div>
      <div
        className={cn(
          "h-full w-full rounded-sm border transition-shadow",
          hasChildren ? "border-solid" : "border-dashed",
          dropHighlight && "ring-1 ring-brand/50"
        )}
        style={{
          // Empty frames use the fainter `line` token regardless of the
          // node's own stroke color (ui-spec §6: dashed-and-fainter signals
          // "drop things here"); once it has children the user's stroke
          // color takes over.
          borderColor: hasChildren ? node.stroke : "rgba(255,255,255,0.07)",
          background: node.fill,
        }}
      />
    </div>
  );
}
