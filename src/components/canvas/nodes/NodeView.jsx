"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { nodeAnchorPoint } from "@/lib/canvas/geometry";

import { ShapeNode } from "./ShapeNode";
import { TextNode } from "./TextNode";
import { StickyNode } from "./StickyNode";
import { FrameNode } from "./FrameNode";
import { ImageNode } from "./ImageNode";

;

const HANDLES = [
  { id: "nw", cursor: "nwse-resize", cls: "-left-[5px] -top-[5px]" },
  { id: "n", cursor: "ns-resize", cls: "left-1/2 -top-[5px] -translate-x-1/2" },
  { id: "ne", cursor: "nesw-resize", cls: "-right-[5px] -top-[5px]" },
  { id: "e", cursor: "ew-resize", cls: "-right-[5px] top-1/2 -translate-y-1/2" },
  { id: "se", cursor: "nwse-resize", cls: "-right-[5px] -bottom-[5px]" },
  { id: "s", cursor: "ns-resize", cls: "left-1/2 -bottom-[5px] -translate-x-1/2" },
  { id: "sw", cursor: "nesw-resize", cls: "-left-[5px] -bottom-[5px]" },
  { id: "w", cursor: "ew-resize", cls: "-left-[5px] top-1/2 -translate-y-1/2" },
];

const CONNECTION_ANCHORS = [
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
  readOnly,
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
  cropMode,
  cropDraft,
  onCropChange,
  onApplyCrop,
  onCancelCrop,
  onResetCrop,
}

) {
  const [hovered, setHovered] = useState(false);
  const editing = editingTextId === node.id;
  const showConnectionHandles =
    !readOnly && tool === "select" && hovered && !dragging && !editing;
  const pathShape = node.type === "shape";
  // A text box being edited grows with its text (the commit stores that height), so the
  // selection ring and handles stay around every line.
  const growing = editing && node.type === "text";

  return (
    <div
      data-node-id={node.id}
      onPointerDown={(e) => onPointerDownBody(e, node)}
      onDoubleClick={(e) => onDoubleClickBody(e, node)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cn(
        "absolute select-none",
        node.type === "frame" ? "z-0" : "z-[1]",
        // Path shapes take pointer events on their outline only (ShapeNode).
        pathShape && "pointer-events-none"
      )}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        height: growing ? "auto" : node.h,
        minHeight: growing ? node.h : undefined,
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
          case "shape":
            return (
              <ShapeNode
                node={node}
                editing={editing}
                readOnly={readOnly}
                onCommit={(text, marks, height, from) => onCommitText(node.id, text, marks, height, from)}
                onCancel={() => onCancelEdit(node.id)}
              />
            );
          case "text":
            return (
              <TextNode
                node={node}
                editing={editing}
                readOnly={readOnly}
                onCommit={(text, marks, height, from) => onCommitText(node.id, text, marks, height, from)}
                onCancel={() => onCancelEdit(node.id)}
              />
            );
          case "sticky":
            return (
              <StickyNode
                node={node}
                editing={editing}
                readOnly={readOnly}
                onCommit={(text, marks, height, from) => onCommitText(node.id, text, marks, height, from)}
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
                onCommitLabel={(name, from) => onCommitText(node.id, name, undefined, undefined, { text: from })}
                onCancelLabelEdit={() => onCancelEdit(node.id)}
                onLabelDoubleClick={(e) => onDoubleClickBody(e, node)}
              />
            );
          case "image":
            return <ImageNode node={node} cropMode={cropMode} cropDraft={cropDraft} onCropChange={onCropChange} onApplyCrop={onApplyCrop} onCancelCrop={onCancelCrop} onResetCrop={onResetCrop} />;
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

      {showHandles && !cropMode &&
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
              "pointer-events-auto absolute z-20 h-[9px] w-[9px] rounded-[1px] border border-ink-900 bg-white ring-1 ring-ink-900",
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
              "pointer-events-auto absolute z-20 h-2 w-2 animate-[floatUp_0.15s_ease-both] rounded-full border border-ink-900 bg-white",
              !pathShape && a.cls
            )}
            style={pathShape ? { cursor: "crosshair", ...outlineHandlePosition(node, a.anchor) } : { cursor: "crosshair" }}
          />
        ))}

      {connectorHoverTarget && (
        <div className="pointer-events-none absolute inset-0 rounded-sm ring-2 ring-brand/60" />
      )}
    </div>
  );
}

/** A connection handle centered just outside a path shape's outline anchor,
 * touching the outline so the pointer can travel onto it without leaving. */
function outlineHandlePosition(node, anchor) {
  const point = nodeAnchorPoint(node, anchor);
  const OFFSET = { top: [0, -4], right: [4, 0], bottom: [0, 4], left: [-4, 0] }[anchor];
  return {
    left: point.x - node.x + OFFSET[0] - 4,
    top: point.y - node.y + OFFSET[1] - 4,
  };
}
