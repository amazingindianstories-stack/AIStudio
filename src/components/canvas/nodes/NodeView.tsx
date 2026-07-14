"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Anchor, CanvasNode } from "@/lib/canvas/types";
import type { ResizeHandle } from "@/lib/canvas/geometry";
import { ShapeNode } from "./ShapeNode";
import { TextNode } from "./TextNode";
import { StickyNode } from "./StickyNode";
import { FrameNode } from "./FrameNode";
import { ImageNode } from "./ImageNode";

export type { ResizeHandle };

const HANDLES: { id: ResizeHandle; cursor: string; cls: string }[] = [
  { id: "nw", cursor: "nwse-resize", cls: "-left-[5px] -top-[5px]" },
  { id: "n", cursor: "ns-resize", cls: "left-1/2 -top-[5px] -translate-x-1/2" },
  { id: "ne", cursor: "nesw-resize", cls: "-right-[5px] -top-[5px]" },
  { id: "e", cursor: "ew-resize", cls: "-right-[5px] top-1/2 -translate-y-1/2" },
  { id: "se", cursor: "nwse-resize", cls: "-right-[5px] -bottom-[5px]" },
  { id: "s", cursor: "ns-resize", cls: "left-1/2 -bottom-[5px] -translate-x-1/2" },
  { id: "sw", cursor: "nesw-resize", cls: "-left-[5px] -bottom-[5px]" },
  { id: "w", cursor: "ew-resize", cls: "-left-[5px] top-1/2 -translate-y-1/2" },
];

const CONNECTION_ANCHORS: { anchor: Anchor; cls: string }[] = [
  { anchor: "top", cls: "left-1/2 -top-[9px] -translate-x-1/2" },
  { anchor: "right", cls: "-right-[9px] top-1/2 -translate-y-1/2" },
  { anchor: "bottom", cls: "left-1/2 -bottom-[9px] -translate-x-1/2" },
  { anchor: "left", cls: "-left-[9px] top-1/2 -translate-y-1/2" },
];

export function NodeView({
  node,
  tool,
  showRing,
  showHandles,
  editingTextId,
  dropHighlight,
  dragging,
  onPointerDownBody,
  onDoubleClickBody,
  onCommitText,
  onCancelEdit,
  onPointerDownHandle,
  onConnectorHandlePointerDown,
  connectorHoverTarget,
  hasChildren = false,
}: {
  node: CanvasNode;
  tool: string;
  showRing: boolean;
  showHandles: boolean;
  editingTextId: string | null;
  dropHighlight: boolean;
  dragging: boolean;
  onPointerDownBody: (e: React.PointerEvent, node: CanvasNode) => void;
  onDoubleClickBody: (e: React.MouseEvent, node: CanvasNode) => void;
  onCommitText: (nodeId: string, text: string) => void;
  onCancelEdit: (nodeId: string) => void;
  onPointerDownHandle: (e: React.PointerEvent, node: CanvasNode, handle: ResizeHandle) => void;
  onConnectorHandlePointerDown: (e: React.PointerEvent, node: CanvasNode, anchor: Anchor) => void;
  connectorHoverTarget: boolean;
  hasChildren?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const editing = editingTextId === node.id;
  const showConnectionHandles =
    tool === "select" && hovered && !dragging && !editing;

  return (
    <div
      data-node-id={node.id}
      onPointerDown={(e) => onPointerDownBody(e, node)}
      onDoubleClick={(e) => onDoubleClickBody(e, node)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cn(
        "absolute select-none",
        node.type === "frame" ? "z-0" : "z-[1]"
      )}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        opacity: node.opacity ?? 1,
        cursor: tool === "select" ? "move" : undefined,
      }}
    >
      {(() => {
        // A `switch` on the discriminant (rather than a chain of `||`/ternary
        // checks) is what TypeScript narrows reliably across every branch,
        // including the final one.
        switch (node.type) {
          case "rect":
          case "ellipse":
          case "triangle":
          case "diamond":
            return <ShapeNode node={node} />;
          case "text":
            return (
              <TextNode
                node={node}
                editing={editing}
                onCommit={(text) => onCommitText(node.id, text)}
                onCancel={() => onCancelEdit(node.id)}
              />
            );
          case "sticky":
            return (
              <StickyNode
                node={node}
                editing={editing}
                onCommit={(text) => onCommitText(node.id, text)}
                onCancel={() => onCancelEdit(node.id)}
              />
            );
          case "frame":
            return (
              <FrameNode
                node={node}
                hasChildren={hasChildren}
                editingLabel={editing}
                dropHighlight={dropHighlight}
                onCommitLabel={(name) => onCommitText(node.id, name)}
                onCancelLabelEdit={() => onCancelEdit(node.id)}
                onLabelDoubleClick={(e) => onDoubleClickBody(e, node)}
              />
            );
          case "image":
            return <ImageNode node={node} />;
        }
      })()}

      {showRing && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 ring-2 ring-brand",
            node.type === "frame" && "ring-1"
          )}
        />
      )}

      {showHandles &&
        HANDLES.map((h) => (
          <button
            key={h.id}
            type="button"
            aria-label={`Resize ${h.id}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onPointerDownHandle(e, node, h.id);
            }}
            className={cn(
              "absolute z-20 h-[9px] w-[9px] rounded-[1px] border border-ink-900 bg-white ring-1 ring-ink-900",
              h.cls
            )}
            style={{ cursor: h.cursor }}
          />
        ))}

      {showConnectionHandles &&
        CONNECTION_ANCHORS.map((a) => (
          <button
            key={a.anchor}
            type="button"
            aria-label={`Draw connector from ${a.anchor} edge`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onConnectorHandlePointerDown(e, node, a.anchor);
            }}
            className={cn(
              "absolute z-20 h-2 w-2 animate-[floatUp_0.15s_ease-both] rounded-full border border-ink-900 bg-white",
              a.cls
            )}
            style={{ cursor: "crosshair" }}
          />
        ))}

      {connectorHoverTarget && (
        <div className="pointer-events-none absolute inset-0 rounded-sm ring-2 ring-brand/60" />
      )}
    </div>
  );
}
