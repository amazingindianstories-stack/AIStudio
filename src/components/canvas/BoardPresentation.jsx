"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Grid2x2, Maximize, Minimize, NotebookText, Presentation, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { clampZoom } from "@/lib/canvas/geometry";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { useBoardPrefs } from "@/lib/canvas/board-prefs";
import { frameTitle, orderedFrames } from "@/lib/canvas/frames";
import { FrameThumbnail } from "./BoardPanel";

const SLIDE_PAD = 32;

const CONTROL =
  "grid h-9 w-9 place-items-center rounded-full text-white/70 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-30";

/** The view that fits `frame` into a `width` x `height` screen, with the screen box it lands in. */
export function slideViewport(frame, width, height, pad = SLIDE_PAD) {
  const zoom = clampZoom(Math.min((width - pad * 2) / Math.max(frame.w, 1), (height - pad * 2) / Math.max(frame.h, 1)));
  const viewport = { x: frame.x + frame.w / 2 - width / 2 / zoom, y: frame.y + frame.h / 2 - height / 2 / zoom, zoom };
  const box = { x: (frame.x - viewport.x) * zoom, y: (frame.y - viewport.y) * zoom, w: frame.w * zoom, h: frame.h * zoom };
  return { viewport, box };
}

/** Ends a presentation and puts back the view from before it. */
export function stopPresentation() {
  const ui = useBoardUi.getState();
  const presenting = ui.presenting;
  if (!presenting) return;
  ui.setPresenting(null);
  if (presenting.returnViewport) useCanvasStore.getState().showViewport(presenting.returnViewport);
  if (typeof document !== "undefined" && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

/**
 * Presents the board's frames as slides on this screen only: nobody else's
 * view follows. Each slide is the live board fitted to one frame, with
 * everything around the frame blacked out and the board's toolbars hidden.
 * The view changes are not saved, and the earlier view returns at the end.
 */
export function BoardPresentation({ rootRef }) {
  const presenting = useBoardUi((s) => s.presenting);
  const present = useCanvasStore((s) => s.history.present);
  const frames = useMemo(() => orderedFrames(present), [present]);
  const overlayRef = useRef(null);
  const [size, setSize] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);

  const index = Math.min(presenting.index, Math.max(frames.length - 1, 0));
  const frame = frames[index];
  const update = useCallback((patch) => {
    const ui = useBoardUi.getState();
    if (ui.presenting) ui.setPresenting({ ...ui.presenting, ...patch });
  }, []);
  const go = useCallback((next) => update({ index: Math.max(0, Math.min(frames.length - 1, next)), grid: false }), [frames.length, update]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  }, [rootRef]);

  // Fullscreen on start, when the browser allows it.
  useEffect(() => {
    useCanvasStore.getState().clearSelection();
    rootRef.current?.requestFullscreen?.().catch(() => {});
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [rootRef]);

  // The slide follows the screen size, which changes on entering fullscreen.
  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el) return undefined;
    if (!el.contains(document.activeElement)) el.focus();
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [presenting.onBoard]);

  const slide = frame && size ? slideViewport(frame, size.w, size.h) : null;
  useEffect(() => {
    if (slide && !presenting.onBoard) useCanvasStore.getState().showViewport(slide.viewport);
    // The slide's numbers are what matter, not the object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide?.viewport.x, slide?.viewport.y, slide?.viewport.zoom, presenting.onBoard]);

  // Every frame deleted while presenting ends the presentation.
  useEffect(() => {
    if (!frames.length) stopPresentation();
  }, [frames.length]);

  useEffect(() => {
    if (frame) useBoardUi.getState().announce(`Slide ${index + 1} of ${frames.length}: ${frameTitle(frame)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.id, index, frames.length]);

  // The presentation owns the keyboard while a slide is up.
  useEffect(() => {
    if (presenting.onBoard) return undefined;
    const onKeyDown = (e) => {
      if (e.target instanceof Element && e.target.closest("textarea, input")) return;
      const singleKeys = useBoardPrefs.getState().singleKeyShortcuts;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      const key = e.key;
      const grid = useBoardUi.getState().presenting?.grid;
      let handled = true;
      if (key === "Escape") {
        if (grid) update({ grid: false });
        else stopPresentation();
      } else if (grid) {
        handled = false; // the grid's buttons take Tab, arrows and Enter
      } else if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || (key === " " && !e.shiftKey)) go(index + 1);
      else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp" || (key === " " && e.shiftKey)) go(index - 1);
      else if (key === "Home") go(0);
      else if (key === "End") go(frames.length - 1);
      else if (plain && singleKeys && key.toLowerCase() === "g") update({ grid: true });
      else if (plain && singleKeys && key.toLowerCase() === "n") update({ notes: !useBoardUi.getState().presenting?.notes });
      else if (plain && singleKeys && key.toLowerCase() === "b") update({ onBoard: true });
      else if (plain && singleKeys && key.toLowerCase() === "f") toggleFullscreen();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [presenting.onBoard, go, index, frames.length, update, toggleFullscreen]);

  if (!frame) return null;

  if (presenting.onBoard) {
    return (
      <div className="absolute bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-ink-750/95 p-1 text-sm shadow-pop backdrop-blur-xl" data-presentation="">
        <button
          type="button"
          onClick={() => update({ onBoard: false })}
          className="flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 font-semibold text-ink-900 outline-none hover:bg-brand/90 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900"
        >
          <Presentation className="h-3.5 w-3.5" />
          Back to slide {index + 1}
        </button>
        <button type="button" onClick={stopPresentation} className="rounded-full px-3 py-1.5 text-white/75 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand">
          Stop presenting
        </button>
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting slide ${index + 1} of ${frames.length}`}
      data-presentation=""
      data-testid="presentation"
      tabIndex={-1}
      className="group/present absolute inset-0 z-[60] outline-none"
    >
      {slide && (
        <svg className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <mask id="presentation-slide">
              <rect width="100%" height="100%" fill="white" />
              <rect x={slide.box.x} y={slide.box.y} width={slide.box.w} height={slide.box.h} fill="black" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="#000" mask="url(#presentation-slide)" />
        </svg>
      )}

      {presenting.notes && (
        <aside
          aria-label="Presenter notes"
          className="absolute inset-x-4 bottom-20 mx-auto max-h-[30%] max-w-2xl overflow-y-auto rounded-2xl border border-line bg-ink-750/95 px-4 py-3 shadow-pop backdrop-blur-xl"
        >
          <p className="text-xs font-semibold text-white/60">Presenter notes, visible to anyone who can open this board</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-white/85">{frame.notes || "No notes for this slide."}</p>
        </aside>
      )}

      <div
        className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-ink-750/90 p-1 opacity-40 shadow-pop backdrop-blur-xl transition-opacity focus-within:opacity-100 hover:opacity-100 group-hover/present:opacity-100"
        role="toolbar"
        aria-label="Presentation controls"
      >
        <button type="button" aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)} className={CONTROL}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-14 px-1 text-center text-sm tabular-nums text-white/80" data-testid="slide-counter">
          {index + 1} / {frames.length}
        </span>
        <button type="button" aria-label="Next slide" disabled={index >= frames.length - 1} onClick={() => go(index + 1)} className={CONTROL}>
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden />
        <button type="button" aria-label="All slides" aria-pressed={Boolean(presenting.grid)} onClick={() => update({ grid: !presenting.grid })} className={CONTROL}>
          <Grid2x2 className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Presenter notes" aria-pressed={Boolean(presenting.notes)} onClick={() => update({ notes: !presenting.notes })} className={CONTROL}>
          <NotebookText className="h-4 w-4" />
        </button>
        <button type="button" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen} className={CONTROL}>
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => update({ onBoard: true })} className="rounded-full px-3 py-2 text-sm text-white/75 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand">
          Show board
        </button>
        <button type="button" aria-label="Stop presenting" onClick={stopPresentation} className={CONTROL}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {presenting.grid && <SlideGrid frames={frames} present={present} current={index} onPick={go} onClose={() => update({ grid: false })} />}
    </div>
  );
}

function SlideGrid({ frames, present, current, onPick, onClose }) {
  const currentRef = useRef(null);
  useEffect(() => currentRef.current?.focus(), []);
  return (
    <div className="absolute inset-0 overflow-y-auto bg-ink-900/95 px-6 pb-24 pt-6 backdrop-blur-xl" data-testid="slide-grid">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <h2 className="text-sm font-semibold text-white/85">All slides</h2>
        <button type="button" aria-label="Close all slides" onClick={onClose} className={CONTROL}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <ol className="mx-auto mt-4 grid max-w-5xl grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
        {frames.map((frame, i) => (
          <li key={frame.id}>
            <button
              ref={i === current ? currentRef : undefined}
              type="button"
              aria-current={i === current ? "true" : undefined}
              onClick={() => onPick(i)}
              className={cn(
                "flex w-full flex-col gap-2 rounded-xl p-2 text-left outline-none transition hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-brand",
                i === current && "bg-white/[0.08]"
              )}
            >
              <span className="block aspect-video w-full overflow-hidden rounded-lg bg-black ring-1 ring-line">
                <FrameThumbnail frame={frame} present={present} className="h-full w-full" />
              </span>
              <span className="flex items-baseline gap-2 text-sm">
                <span className="tabular-nums text-white/40">{i + 1}</span>
                <span className={cn("truncate", frame.name?.trim() ? "text-white/85" : "italic text-white/45")}>{frameTitle(frame)}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
