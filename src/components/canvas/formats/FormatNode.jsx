"use client";

import { openFormat } from "@/lib/canvas/formats/actions";
import { STATUS_LABELS } from "@/lib/canvas/formats/model";
import { DocContent } from "./DocContent";

export function FormatNode({ node }) {
  return <div className="h-full overflow-hidden rounded-xl border border-slate-300 bg-white text-slate-900 shadow-lg" data-format-kind={node.format}>
    <div className="flex items-center justify-between gap-2 border-b bg-slate-50 px-4 py-3 text-sm font-semibold"><span className="truncate">{node.name}</span><span className="text-xs text-slate-500">{STATUS_LABELS[node.status] ?? node.format}</span></div>
    <div className="pointer-events-none max-h-[calc(100%-88px)] overflow-hidden p-4">
      {node.format === "doc" ? <DocContent node={node} readOnly preview /> : node.format === "deck" ? <div className="grid grid-cols-2 gap-2">{node.slides.map((slide) => <div key={slide.id} className="aspect-video rounded border bg-slate-100 p-3 text-sm">{slide.title || "Slide"}</div>)}{!node.slides.length && "Add frames to start your deck"}</div> : node.format === "html" ? <pre className="whitespace-pre-wrap text-xs text-slate-500">{node.html.slice(0, 500)}</pre> : node.preview ?
        // eslint-disable-next-line @next/next/no-img-element
        <img src={node.preview} alt="" className="h-full w-full object-contain" /> : <p className="text-slate-500">Draw.io diagram - open to edit, import or export.</p>}
    </div>
    <button className="pointer-events-auto absolute bottom-3 right-3 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openFormat(node.id); }}>Open {node.format === "doc" ? "doc" : node.format === "deck" ? "slides" : node.format}</button>
  </div>;
}
