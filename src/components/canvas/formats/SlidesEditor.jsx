"use client";

import { useState } from "react";
import { patchFormat } from "@/lib/canvas/formats/actions";
import { addSlide, moveSlide } from "@/lib/canvas/formats/slides";
import { isContainerNode } from "@/lib/canvas/geometry";
import { isLocked } from "@/lib/canvas/locks";
import { MAX_LANE_NAME } from "@/lib/canvas/formats/model";
import { clipText } from "@/lib/canvas/rich-text";
import { FramePreview } from "./FramePreview";

export function SlidesEditor({ node, graph, readOnly }) {
  const [lane, setLane] = useState("main");
  const [slideId, setSlideId] = useState(node.slides[0]?.id);
  const [presenting, setPresenting] = useState(false);
  const [laneName, setLaneName] = useState("");
  const slides = node.slides.filter((slide) => slide.lane === lane);
  const slide = slides.find((s) => s.id === slideId) ?? slides[0];
  const frame = graph.nodes.find((n) => n.type === "frame" && n.id === slide?.frameId);
  const parentType = (n) => graph.nodes.find((p) => p.id === n.parentId)?.type;
  const addLane = (e) => {
    e.preventDefault();
    const name = laneName.trim();
    if (!name || node.lanes.length >= 6) return;
    patchFormat(node.id, (n) => ({ lanes: [...n.lanes, { id: crypto.randomUUID(), name: clipText(name, MAX_LANE_NAME) }] }));
    setLaneName("");
  };
  const patchSlide = (patch, opts) => patchFormat(node.id, (n) => ({ slides: n.slides.map((s) => s.id === slide?.id ? { ...s, ...patch } : s) }), opts);
  return <div className="flex min-h-0 flex-col gap-4 md:flex-row">
    {!presenting && <aside className="w-full shrink-0 space-y-3 md:w-56">
      <label className="block text-sm">Presentation lane <select aria-label="Presentation lane" value={lane} onChange={(e) => setLane(e.target.value)}>{node.lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      {!readOnly && <><form className="flex gap-2" onSubmit={addLane}><input className="min-w-0 flex-1 rounded border p-1 text-sm" aria-label="New lane name" placeholder="Lane name" maxLength={60} disabled={node.lanes.length >= 6} value={laneName} onChange={(e) => setLaneName(e.target.value)} /><button type="submit" disabled={node.lanes.length >= 6 || !laneName.trim()}>Add lane</button></form>
        <select aria-label="Add frame to deck" value="" onChange={(e) => patchFormat(node.id, (n) => ({ slides: addSlide(n.slides, graph.nodes.find((f) => f.id === e.target.value), lane) }))}><option value="">Add a board frame</option>{graph.nodes.filter((n) => n.type === "frame").map((f) => <option key={f.id} value={f.id}>{f.name || "Frame"}</option>)}</select></>}
      <ol className="space-y-2">{slides.map((s, i) => <li key={s.id} className={`rounded border p-2 ${slide?.id === s.id ? "border-indigo-500 bg-indigo-50" : "border-slate-200"}`}><button className="w-full text-left text-sm" onClick={() => setSlideId(s.id)}>{i + 1}. {s.title || "Slide"}</button>{!readOnly && <div className="flex gap-3 text-xs"><button aria-label={`Move slide ${i + 1} up`} onClick={() => patchFormat(node.id, (n) => ({ slides: moveSlide(n.slides, s.id, -1) }))}>↑</button><button aria-label={`Move slide ${i + 1} down`} onClick={() => patchFormat(node.id, (n) => ({ slides: moveSlide(n.slides, s.id, 1) }))}>↓</button><button onClick={(e) => { e.currentTarget.closest('[role="dialog"]')?.focus(); patchFormat(node.id, (n) => ({ slides: n.slides.filter((x) => x.id !== s.id) })); }}>Remove slide</button></div>}</li>)}</ol>
    </aside>}
    <div className="min-w-0 flex-1 space-y-3">
      {frame ? <FramePreview frame={frame} graph={graph} /> : <div className="rounded-xl border border-dashed p-16 text-center text-slate-500">Add a frame to start. Slides use the board’s saved frames.</div>}
      {slide && <><div className="flex flex-wrap gap-3"><button onClick={() => setPresenting(!presenting)}>{presenting ? "End presentation" : "Present lane"}</button><button disabled={slides.indexOf(slide) === 0} onClick={() => setSlideId(slides[slides.indexOf(slide) - 1]?.id)}>Previous slide</button><button disabled={slides.indexOf(slide) === slides.length - 1} onClick={() => setSlideId(slides[slides.indexOf(slide) + 1]?.id)}>Next slide</button></div>
        {!presenting && <><label className="block">Slide title<input className="ml-3 rounded border p-2" aria-label="Slide title" readOnly={readOnly} maxLength={120} value={slide.title} onChange={(e) => patchSlide({ title: e.target.value }, { coalesce: true })} /></label><label className="block">Presenter notes<textarea className="mt-1 w-full rounded border p-3" aria-label="Presenter notes" readOnly={readOnly} maxLength={5000} value={slide.notes} onChange={(e) => patchSlide({ notes: e.target.value }, { coalesce: true })} /></label>
          {!readOnly && <><label>Move to lane <select aria-label="Slide lane" value={slide.lane} onChange={(e) => patchSlide({ lane: e.target.value })}>{node.lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label><p className="text-sm text-slate-500">Drag a board object below into the slide to include it.</p><div className="flex flex-wrap gap-2">{graph.nodes.filter((n) => n.type !== "format" && !isContainerNode(n) && !isLocked(graph, n) && n.parentId !== frame?.id && parentType(n) !== "diagram").map((n) => <button key={n.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/board-node", n.id)} className="rounded border p-2 text-xs">{n.text?.slice(0, 30) || n.name || n.type}</button>)}</div></>}
        </>}
      </>}
    </div>
  </div>;
}
