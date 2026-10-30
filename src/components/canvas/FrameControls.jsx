"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, Link2 } from "lucide-react";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { FRAME_PRESETS, presetOfFrame } from "@/lib/canvas/frames";
import { canHideFrames, setFrameHidden, setFramePreset } from "@/lib/frame-actions";
import { listCopies } from "@/lib/synced-frames";
import { requestOpenBoard } from "@/lib/open-board";

/**
 * The strip above a selected frame: its size preset, hide or reveal for people who manage hidden frames, and
 * the boards that hold a synced copy of it. Placed in screen space from the board data, so it works whatever
 * the viewport culling has mounted.
 */
export function FrameControls() {
  const selection = useCanvasStore((s) => s.selection);
  const viewport = useCanvasStore((s) => s.history.present.viewport);
  const nodes = useCanvasStore((s) => s.history.present.nodes);
  const boardId = useCanvasStore((s) => s.boardId);
  const role = useCanvasStore((s) => s.boardRole);
  const readOnly = useCanvasStore(selectReadOnly);
  const frame = selection.length === 1 ? nodes.find((n) => n.id === selection[0] && n.type === "frame") : null;
  const [copies, setCopies] = useState(null);
  const [open, setOpen] = useState(false);

  const frameId = frame?.id;
  useEffect(() => {
    setCopies(null);
    setOpen(false);
  }, [frameId]);

  if (!frame || readOnly) return null;
  const preset = presetOfFrame(frame);
  const left = (frame.x - viewport.x) * viewport.zoom;
  // Below the frame: the style bar of the selection sits above it.
  const top = (frame.y + frame.h - viewport.y) * viewport.zoom + 12;
  const manage = canHideFrames(role);

  const showCopies = async () => {
    setOpen(true);
    setCopies(await listCopies(boardId, frame.id));
  };

  return (
    <div
      role="toolbar"
      aria-label="Frame controls"
      className="pointer-events-auto absolute z-20 flex items-center gap-1 rounded-lg border border-line bg-ink-750/95 p-1 text-xs text-white/80 shadow-pop"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <select
        aria-label="Frame size"
        value={preset?.id ?? "custom"}
        onChange={(e) => {
          const next = FRAME_PRESETS.find((p) => p.id === e.target.value);
          if (next) setFramePreset(frame.id, next);
        }}
        className="rounded bg-ink-700 px-1.5 py-1 text-white outline-none ring-1 ring-line focus:ring-brand"
      >
        {!preset && <option value="custom">Custom size</option>}
        {FRAME_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {manage && (
        <button
          type="button"
          onClick={() => setFrameHidden(frame.id, !frame.hidden)}
          title={frame.hidden ? "Reveal this frame to everyone" : "Hide this frame's content from everyone else"}
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-white/10"
        >
          {frame.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {frame.hidden ? "Reveal frame" : "Hide frame"}
        </button>
      )}
      <button type="button" onClick={showCopies} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-white/10" title="Boards with a synced copy of this frame">
        <Link2 className="h-3.5 w-3.5" />
        Copies
      </button>
      {open && (
        <div role="dialog" aria-label="Synced copies" className="absolute left-0 top-full z-30 mt-1 min-w-[200px] rounded-lg border border-line bg-ink-750 p-1.5 shadow-pop">
          {copies === null && <p className="px-1 py-0.5 text-white/50">Looking</p>}
          {copies && copies.length === 0 && <p className="px-1 py-0.5 text-white/50">No synced copies yet.</p>}
          {copies?.map((copy) => (
            <button key={`${copy.boardId}/${copy.nodeId}`} type="button" onClick={() => requestOpenBoard(copy.boardId)} className="block w-full truncate rounded px-1.5 py-1 text-left hover:bg-white/10">
              {copy.boardName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
