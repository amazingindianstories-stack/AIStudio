"use client";

import { useState } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { placeOnLayer } from "@/lib/canvas/layers";
import { diagramLocked, diagramToMermaid, mermaidToBoardObjects, parseMermaid, replaceDiagramContent } from "@/lib/canvas/formats/mermaid";

export function MermaidEditor({ node, readOnly, onCreated }) {
  const [source, setSource] = useState(node?.source || "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Finish]");
  const [notice, setNotice] = useState("");
  const apply = () => {
    const parsed = parseMermaid(source);
    if (!parsed.ok || parsed.warnings.length) { setNotice(parsed.error || `Unsupported statements: ${parsed.warnings.join("; ")}`); return; }
    const store = useCanvasStore.getState();
    if (node && diagramLocked(store.history.present, node.id)) { setNotice("Unlock this diagram and its shapes before updating it from code."); return; }
    if (node) store.editBoard((g) => replaceDiagramContent(g, node.id, parsed, source));
    else {
      const built = mermaidToBoardObjects(parsed, store.viewportCenter(), { source });
      store.editBoard((g) => ({ ...g, nodes: [...g.nodes, ...placeOnLayer(g, [built.diagram, ...built.nodes], store.activeLayerId)], connectors: [...g.connectors, ...built.connectors] }));
      onCreated?.(built.diagram.id);
    }
    setNotice("Diagram saved as editable board shapes and lines.");
  };
  return <div className="space-y-3"><p className="text-sm text-slate-600">Flowcharts and state diagrams. Paste text or drop a .mmd file. Unsupported statements are reported before changing the board.</p><textarea aria-label="Mermaid source" className="h-64 w-full rounded border p-3 font-mono text-sm" readOnly={readOnly} maxLength={20000} value={source} onChange={(e) => setSource(e.target.value)} onDragOver={(e) => e.preventDefault()} onDrop={async (e) => { e.preventDefault(); if (readOnly) return; const file = e.dataTransfer.files[0]; if (file && file.size <= 80000) { const text = await file.text(); if (text.length <= 20000) setSource(text); } }} />
    {!readOnly && <button className="rounded bg-indigo-600 px-4 py-2 text-white" onClick={apply}>{node ? "Update diagram from code" : "Create diagram"}</button>}
    {node && <button className="ml-3 rounded border px-4 py-2" onClick={() => setSource(diagramToMermaid(useCanvasStore.getState().history.present, node.id))}>Read visual edits into code</button>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
