"use client";

import { Link2 } from "lucide-react";
import { useSyncedFrame } from "@/lib/synced-frames";
import { requestOpenBoard } from "@/lib/open-board";
import { NodeView } from "./NodeView";

const noop = () => {};

/**
 * A view-only copy of a frame on another board. The content is the source frame's, drawn scaled into this
 * node's box; clicking the badge opens the original board. A synced copy inside that content is drawn as a
 * plain outline, so copies that hold each other never nest without end.
 */
export function SyncedNode({ node }) {
  const result = useSyncedFrame(node.sourceBoardId, node.sourceNodeId);
  const frame = result.status === "ready" ? result.data.frame : null;
  const scale = frame ? Math.min(node.w / frame.w, node.h / frame.h) : 1;
  return (
    <div className="relative h-full w-full overflow-hidden rounded-sm border border-dashed border-brand/50 bg-ink-800/40" data-synced-id={node.id}>
      <button
        type="button"
        onClick={() => requestOpenBoard(node.sourceBoardId, result.status === "ready" ? result.data.board.projectId : undefined)}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-1 top-1 z-10 flex max-w-[90%] items-center gap-1 truncate rounded bg-ink-750/90 px-1.5 py-0.5 text-[10px] text-white/80 hover:text-white"
        title="Open the original board"
      >
        <Link2 className="h-3 w-3 shrink-0" />
        <span className="truncate">{result.status === "ready" ? `${result.data.board.name}: ${frame.name}` : node.name || "Synced copy"}</span>
      </button>
      {result.status === "loading" && <p className="absolute inset-0 grid place-items-center text-xs text-white/40">Loading copy</p>}
      {result.status === "gone" && (
        <p className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-white/50">The original is no longer available to you.</p>
      )}
      {result.status === "error" && <p className="absolute inset-0 grid place-items-center text-xs text-white/50">Could not load the copy. Retrying.</p>}
      {frame && (
        <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${scale}) translate(${-frame.x}px, ${-frame.y}px)` }}>
          {result.data.nodes.map((n) =>
            n.type === "synced" ? (
              <div
                key={n.id}
                className="absolute flex items-center justify-center gap-1 rounded-sm border border-dashed border-brand/50 px-2 text-xs text-white/50"
                style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
              >
                <Link2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{n.name || "Synced copy"}</span>
              </div>
            ) : (
              <NodeView
                key={n.id}
                node={n}
                tool="hand"
                showRing={false}
                showHandles={false}
                readOnly
                viewOnly
                editingTextId={null}
                dragging={false}
                onPointerDownBody={noop}
                onDoubleClickBody={noop}
                onCommitText={noop}
                onCancelEdit={noop}
                onPointerDownHandle={noop}
                onConnectorHandlePointerDown={noop}
                hasChildren={result.data.nodes.some((c) => c.parentId === n.id)}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
