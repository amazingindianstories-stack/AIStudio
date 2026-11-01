"use client";

import { NodeView } from "../nodes/NodeView";
import { ConnectorLayer } from "../ConnectorLayer";
import { frameContents } from "@/lib/canvas/formats/slides";
import { useCanvasStore } from "@/lib/canvas-store";

const noop = () => {};

/** Render from the complete graph, independently of viewport culling. */
export function FramePreview({ frame, graph, onNavigate }) {
  const content = frameContents(graph, frame.id);
  const width = Math.max(1, frame.w);
  const height = Math.max(1, frame.h);
  const byId = Object.fromEntries(content.nodes.map((n) => [n.id, n]));
  return <div className="relative mx-auto w-full overflow-hidden rounded-lg border bg-slate-900" style={{ aspectRatio: `${width} / ${height}`, maxWidth: `min(100%, calc(70vh * ${width / height}))` }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/board-node");
    if (!id || id === frame.id) return;
    useCanvasStore.getState().editBoard((g) => ({ ...g, nodes: g.nodes.map((n) => n.id === id && !["format", "frame"].includes(n.type) ? { ...n, parentId: frame.id, x: frame.x + 40, y: frame.y + 60 } : n) }));
  }}>
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full"><foreignObject width={width} height={height}><div className="relative" style={{ width, height }}>
      <div style={{ transform: `translate(${-frame.x}px, ${-frame.y}px)` }}>
        {content.nodes.filter((n) => n.id !== frame.id).map((n) => <NodeView key={n.id} node={n} readOnly viewOnly tool="select" nodesById={byId} onPointerDownBody={noop} onDoubleClickBody={noop} onCommitText={noop} onCancelEdit={noop} />)}
        <ConnectorLayer connectors={content.connectors} nodesById={byId} selectedConnectorIds={[]} />
      </div>
    </div></foreignObject></svg>
    {onNavigate && content.nodes.filter((n) => n.screenLink).map((n) => <button key={n.id} aria-label={`Navigate ${n.text || "screen"}`} className="absolute border-2 border-transparent hover:border-indigo-400" style={{ left: `${(n.x - frame.x) / width * 100}%`, top: `${(n.y - frame.y) / height * 100}%`, width: `${n.w / width * 100}%`, height: `${n.h / height * 100}%` }} onClick={() => onNavigate(n.screenLink)} />)}
  </div>;
}
