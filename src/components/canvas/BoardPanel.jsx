"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { frameChildren } from "@/lib/canvas/frames";

/** The board's right-hand side panel shell: titled, closable, Escape closes it. */
export function BoardPanel({ label, title, subtitle, onClose, children, footer, className }) {
  const panelRef = useRef(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label={label}
      data-board-keys="own"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "absolute right-4 top-16 z-40 flex max-h-[min(640px,calc(100%-11rem))] w-80 max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750/95 shadow-pop outline-none backdrop-blur-xl",
        className
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white/90">{title}</h2>
          {subtitle && <p className="text-xs text-white/45">{subtitle}</p>}
        </div>
        <button
          type="button"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/50 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">{children}</div>
      {footer && <footer className="border-t border-line px-3 py-2.5">{footer}</footer>}
    </section>
  );
}

const SHAPE_FILL = (node) => {
  if (node.type === "image") return "rgba(255,255,255,0.22)";
  if (node.type === "text") return "rgba(255,255,255,0.55)";
  if (node.type === "frame") return "transparent";
  return node.fill && node.fill !== "transparent" ? node.fill : "rgba(255,255,255,0.3)";
};

/** A small picture of a frame drawn from the board data: its fill and the boxes of its contents. */
export function FrameThumbnail({ frame, present, className }) {
  const children = frameChildren(present, frame);
  const fill = frame.fill && frame.fill !== "transparent" ? frame.fill : "#15151a";
  return (
    <svg
      viewBox={`${frame.x} ${frame.y} ${Math.max(frame.w, 1)} ${Math.max(frame.h, 1)}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      className={cn("block", className)}
    >
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill={fill} />
      {children.map((n) =>
        n.type === "text" ? (
          <rect key={n.id} x={n.x} y={n.y + n.h * 0.35} width={n.w} height={Math.max(n.h * 0.3, 2)} rx={2} fill={SHAPE_FILL(n)} opacity={n.opacity ?? 1} />
        ) : n.type === "ellipse" ? (
          <ellipse key={n.id} cx={n.x + n.w / 2} cy={n.y + n.h / 2} rx={n.w / 2} ry={n.h / 2} fill={SHAPE_FILL(n)} opacity={n.opacity ?? 1} />
        ) : (
          <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} rx={Math.min(n.w, n.h) * 0.04} fill={SHAPE_FILL(n)} opacity={n.opacity ?? 1} />
        )
      )}
    </svg>
  );
}
