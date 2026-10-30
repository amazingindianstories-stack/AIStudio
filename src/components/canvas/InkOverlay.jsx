"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { screenToWorld } from "@/lib/canvas/geometry";
import { commitSmartStroke, commitStroke, eraseStep } from "@/lib/ink-actions";
import { inkStyleFor, useInkPrefs } from "@/lib/ink-prefs";
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS } from "@/lib/canvas/ink";

/**
 * Catches the pointer while the pen, highlighter or eraser is armed. A stroke is drawn live as a screen-space
 * path and committed as one `ink` node on release, so the work never touches the DOM of the board objects and
 * is independent of viewport culling. Mouse, trackpad, touch and stylus all draw; a stylus varies the pen width
 * with pressure.
 */
export function InkOverlay({ tool, viewport }) {
  const prefs = useInkPrefs();
  const [trail, setTrail] = useState(null);
  const strokeRef = useRef(null);
  const style = tool === "eraser" ? null : inkStyleFor(tool, prefs);

  const local = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const world = (screen) => screenToWorld(screen, viewport);

  const onDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const screen = local(e);
    strokeRef.current = { points: [world(screen)], screen: [screen], pressures: [e.pressure || 0.5], type: e.pointerType };
    if (tool === "eraser") eraseStep(world(screen), viewport.zoom, prefs.preciseEraser);
    else setTrail([screen]);
  };

  const onMove = (e) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    e.stopPropagation();
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const rect = e.currentTarget.getBoundingClientRect();
    for (const ev of events) {
      const screen = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      stroke.points.push(world(screen));
      stroke.screen.push(screen);
      stroke.pressures.push(ev.pressure || 0.5);
      if (tool === "eraser") eraseStep(world(screen), viewport.zoom, prefs.preciseEraser);
    }
    if (tool !== "eraser") setTrail([...stroke.screen]);
  };

  const finish = (e, cancelled) => {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    setTrail(null);
    if (!stroke || cancelled || tool === "eraser") return;
    e.stopPropagation();
    if (tool === "pen" && prefs.smartDraw && commitSmartStroke(stroke.points, viewport.zoom)) return;
    commitStroke(stroke.points, style, viewport.zoom, stroke.type, stroke.pressures);
  };

  const d = trail ? trail.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + (trail.length === 1 ? ` L ${trail[0].x} ${trail[0].y + 0.01}` : "") : "";

  return (
    <div
      data-ink-overlay={tool}
      aria-label={tool === "eraser" ? "Eraser" : tool === "highlighter" ? "Highlighter" : "Pen"}
      className={cn("absolute inset-0 z-[5] touch-none", tool === "eraser" ? "cursor-cell" : "cursor-crosshair")}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
    >
      <InkPresets tool={tool} />
      {trail && style && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <path
            d={d}
            fill="none"
            stroke={style.stroke}
            strokeWidth={style.strokeWidth * viewport.zoom}
            strokeOpacity={style.highlighter ? 0.4 : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

/** The preset strip above the tool dock: three colors and three thicknesses, the eraser mode, and smart drawing. */
function InkPresets({ tool }) {
  const prefs = useInkPrefs();
  const setPref = useInkPrefs((s) => s.setPref);
  const eraser = tool === "eraser";
  const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = tool === "highlighter" ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const colorKey = tool === "highlighter" ? "highlighterColor" : "penColor";
  const widthKey = tool === "highlighter" ? "highlighterWidth" : "penWidth";
  const chip = (active) => cn("grid h-7 w-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand", active ? "bg-ink-600 ring-1 ring-line" : "hover:bg-white/10");
  return (
    <div
      role="group"
      aria-label={eraser ? "Eraser options" : "Drawing options"}
      className="pointer-events-auto absolute bottom-20 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl max-sm:bottom-32"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {eraser ? (
        <>
          <button type="button" aria-pressed={!prefs.preciseEraser} className={cn(chip(!prefs.preciseEraser), "w-auto px-2 text-xs text-white/85")} onClick={() => setPref({ preciseEraser: false })}>
            Whole stroke
          </button>
          <button type="button" aria-pressed={prefs.preciseEraser} className={cn(chip(prefs.preciseEraser), "w-auto px-2 text-xs text-white/85")} onClick={() => setPref({ preciseEraser: true })}>
            Precision
          </button>
        </>
      ) : (
        <>
          {colors.map((color, index) => (
            <button key={color} type="button" aria-label={`Color ${index + 1}`} aria-pressed={prefs[colorKey] === index} className={chip(prefs[colorKey] === index)} onClick={() => setPref({ [colorKey]: index })}>
              <span className="h-4 w-4 rounded-full border border-white/30" style={{ background: color }} />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          {widths.map((width, index) => (
            <button key={width} type="button" aria-label={`Thickness ${index + 1}`} aria-pressed={prefs[widthKey] === index} className={chip(prefs[widthKey] === index)} onClick={() => setPref({ [widthKey]: index })}>
              <span className="rounded-full bg-white" style={{ width: Math.min(18, 4 + index * 5), height: Math.min(18, 4 + index * 5) }} />
            </button>
          ))}
          {tool === "pen" && (
            <>
              <span className="mx-1 h-5 w-px bg-line" aria-hidden />
              <button
                type="button"
                aria-pressed={prefs.smartDraw}
                title="Turn hand-drawn shapes into shapes, stickies and lines; scribble over objects to erase them"
                className={cn(chip(prefs.smartDraw), "w-auto px-2 text-xs text-white/85")}
                onClick={() => setPref({ smartDraw: !prefs.smartDraw })}
              >
                Smart drawing
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
