"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { boardStatus, defaultViewNode, FORMAT_STATUSES, newFormatNode, STATUS_LABELS } from "@/lib/canvas/formats/model";
import { formatUrl, openFormat, patchFormat, setDefaultFormat } from "@/lib/canvas/formats/actions";
import { WIREFRAMES, wireframeNode } from "@/lib/canvas/formats/wireframes";
import { staticEmbedHtml } from "@/lib/canvas/formats/html-embed";
import { DocContent } from "./DocContent";
import { SlidesEditor } from "./SlidesEditor";
import { MermaidEditor } from "./MermaidEditor";
import { DrawioEditor } from "./DrawioEditor";
import { PrototypePreview } from "./PrototypePreview";
import { FramePreview } from "./FramePreview";

export function FormatsPanel({ boardId, touchViewOnly }) {
  const graph = useCanvasStore((s) => s.history.present);
  const loaded = useCanvasStore((s) => s.loaded);
  const loadedBoardId = useCanvasStore((s) => s.boardId);
  const readOnly = useCanvasStore(selectReadOnly) || touchViewOnly;
  const selection = useCanvasStore((s) => s.selection);
  const [panel, setPanel] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [notice, setNotice] = useState("");
  const dialog = useRef(null);
  const initialized = useRef(null);
  const focusNode = graph.nodes.find((n) => n.id === focusId);
  const formats = graph.nodes.filter((n) => n.type === "format" || n.type === "diagram");
  const selected = graph.nodes.find((n) => selection.includes(n.id));
  useEffect(() => {
    const open = (e) => setFocusId(e.detail);
    window.addEventListener("board-format-open", open);
    return () => window.removeEventListener("board-format-open", open);
  }, []);
  useEffect(() => {
    if (!loaded || !boardId || loadedBoardId !== boardId || initialized.current === boardId) return;
    initialized.current = boardId;
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("board") === boardId ? url.searchParams.get("focus") : null;
    if (url.searchParams.has("board") || url.searchParams.has("focus")) {
      url.searchParams.delete("board");
      url.searchParams.delete("focus");
      window.history.replaceState(window.history.state, "", url);
    }
    setFocusId(requested || defaultViewNode(graph.nodes)?.id || null);
  }, [loaded, loadedBoardId, boardId, graph.nodes]);
  useEffect(() => {
    if (!focusId) return;
    const before = document.activeElement;
    dialog.current?.focus();
    return () => before?.isConnected && before.focus();
  }, [focusId]);
  const locked = !!focusNode?.viewLocked;
  const close = () => {
    if (locked && readOnly) return;
    setFocusId(null);
  };
  const create = (kind) => {
    if (readOnly) return;
    const store = useCanvasStore.getState();
    const node = newFormatNode(kind, store.viewportCenter());
    store.addNode(node);
    setFocusId(node.id);
  };
  const status = boardStatus(graph.nodes);
  if (!boardId || !loaded) return null;
  return <>
    <div className="absolute bottom-3 right-44 z-20 text-sm">
      <button className="rounded-xl border border-white/15 bg-slate-900 px-4 py-3 text-white shadow-xl" aria-expanded={panel} onClick={() => setPanel(!panel)}>Formats{status ? ` · ${STATUS_LABELS[status]}` : ""}</button>
      {panel && <div className="absolute bottom-14 right-0 max-h-[70vh] w-80 space-y-4 overflow-auto rounded-xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl" role="region" aria-label="Board formats">
        <h2 className="font-semibold">Docs, slides and prototypes</h2>
        {!readOnly && <div className="grid grid-cols-2 gap-2">{[["doc", "New doc"], ["deck", "New slides"], ["drawio", "New Draw.io"], ["html", "New HTML embed"]].map(([kind, label]) => <button key={kind} className="rounded border p-2" onClick={() => create(kind)}>{label}</button>)}<button className="rounded border p-2" onClick={() => setFocusId("new-mermaid")}>New Mermaid</button></div>}
        <ul className="space-y-2">{formats.map((n) => <li key={n.id}><button className="w-full rounded border px-3 py-2 text-left" onClick={() => openFormat(n.id)}>{n.name || n.type} <span className="text-xs text-slate-500">{STATUS_LABELS[n.status]}{n.defaultView ? " · Default" : ""}</span></button></li>)}</ul>
        {!readOnly && <><h3 className="font-semibold">Wireframing library</h3><div className="grid grid-cols-2 gap-2">{WIREFRAMES.map((item) => <button className="rounded border p-2 text-xs" key={item.name} onClick={() => { const store = useCanvasStore.getState(); const screen = selected?.type === "frame" && item.type !== "frame" ? selected : null; store.addNode(wireframeNode(item, screen ? { x: screen.x + screen.w / 2, y: screen.y + screen.h / 2 } : store.viewportCenter(), screen?.id ?? null)); }}>{item.name}</button>)}</div>
          {selected && selected.type !== "frame" && <label className="block">Click-through destination<select className="w-full rounded border p-2" aria-label="Click-through destination" value={selected.screenLink ?? ""} onChange={(e) => useCanvasStore.getState().updateNodeFields(selected.id, { screenLink: e.target.value || undefined })}><option value="">No link</option>{graph.nodes.filter((n) => n.type === "frame").map((n) => <option key={n.id} value={n.id}>{n.name || "Frame"}</option>)}</select></label>}</>}
        {graph.nodes.filter((n) => n.type === "frame").map((n) => <button key={n.id} className="block rounded border px-3 py-2" onClick={() => setFocusId(`prototype:${n.id}`)}>Preview {n.name || "screen"}</button>)}
      </div>}
    </div>
    {(focusNode || focusId === "new-mermaid" || focusId?.startsWith("prototype:")) && createPortal(<div ref={dialog} role="dialog" aria-modal="true" aria-label="Format focus mode" tabIndex={-1} className="fixed inset-0 z-[100] flex flex-col bg-slate-50 text-slate-900 outline-none" onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isDefaultPrevented()) close();
      if (e.key === "Tab") {
        const items = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[contenteditable="true"],[tabindex="0"]')].filter((el) => el.getClientRects().length);
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }}>
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-white px-5 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Focus mode</span>
        {focusNode && <input aria-label="Format title" className="min-w-0 flex-1 bg-transparent text-lg font-semibold" readOnly={readOnly} maxLength={120} value={focusNode.name || ""} onChange={(e) => patchFormat(focusNode.id, () => ({ name: e.target.value }), { coalesce: true })} />}
        {focusNode && <select aria-label="Format status" disabled={readOnly} value={focusNode.status || ""} onChange={(e) => patchFormat(focusNode.id, () => ({ status: e.target.value || undefined }))}><option value="">Set status</option>{FORMAT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select>}
        {focusNode?.type === "format" && !readOnly && <><label className="text-xs"><input type="checkbox" checked={!!focusNode.defaultView} onChange={(e) => setDefaultFormat(focusNode.id, e.target.checked, locked)} /> Board default</label><label className="text-xs"><input type="checkbox" disabled={!focusNode.defaultView} checked={locked} onChange={(e) => setDefaultFormat(focusNode.id, true, e.target.checked)} /> Lock default</label></>}
        {focusNode && <button onClick={async () => { try { await navigator.clipboard.writeText(formatUrl(boardId, focusNode.id)); setNotice("Focus link copied"); } catch { setNotice(formatUrl(boardId, focusNode.id)); } }}>Copy focus link</button>}
        <button disabled={locked && readOnly} className="rounded border px-3 py-2" onClick={close}>Back to board</button>
      </header>
      {notice && <p role="status" className="px-5 py-2 text-sm">{notice}</p>}
      <main className="min-h-0 flex-1 overflow-auto p-4 md:p-8"><div className="mx-auto max-w-6xl space-y-5">
        {focusNode?.format === "doc" && <div className="mx-auto max-w-3xl rounded-xl border bg-white p-6 shadow-sm md:p-10"><DocContent node={focusNode} readOnly={readOnly} /></div>}
        {focusNode?.format === "deck" && <SlidesEditor node={focusNode} graph={graph} readOnly={readOnly} />}
        {focusNode?.format === "drawio" && <DrawioEditor node={focusNode} readOnly={readOnly} />}
        {focusNode?.format === "html" && <>{!readOnly && <label className="block text-sm">HTML source<textarea aria-label="HTML source" className="mt-2 h-48 w-full rounded border bg-white p-3 font-mono" maxLength={100000} value={focusNode.html} onChange={(e) => patchFormat(focusNode.id, () => ({ html: e.target.value }), { coalesce: true })} /></label>}<iframe title="HTML prototype preview" className="h-[60vh] w-full rounded border bg-white" sandbox="" referrerPolicy="no-referrer" srcDoc={staticEmbedHtml(focusNode.html)} /></>}
        {(focusId === "new-mermaid" || focusNode?.sourceKind === "mermaid") && <MermaidEditor key={focusId} node={focusNode} readOnly={readOnly} onCreated={(id) => setFocusId(id)} />}
        {focusNode && focusNode.type !== "format" && <FramePreview frame={focusNode} graph={graph} />}
        {focusId?.startsWith("prototype:") && <PrototypePreview key={focusId} initialId={focusId.slice(10)} graph={graph} />}
      </div></main>
    </div>, document.body)}
  </>;
}
