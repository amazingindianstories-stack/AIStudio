"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const GAP = 6;
const MARGIN = 8;

/** Hover action strip rendered below a library card. Cards are too small (and
 *  clip their overflow) to hold action buttons, so the strip is portalled and
 *  fixed to the card's viewport rect, flipping above when there is no room.
 *  Every action is routed through the caller's confirmation dialog. */
export function CardActionPanel({ anchor, actions, onPointerEnter, onPointerLeave, onClose }) {
  const panel = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!anchor || !panel.current) return;
    const rect = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = panel.current;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, MARGIN), window.innerWidth - width - MARGIN);
    const below = rect.bottom + GAP + height <= window.innerHeight - MARGIN;
    setPosition({ left, below, top: below ? rect.bottom + GAP : Math.max(MARGIN, rect.top - GAP - height) });
  }, [anchor, actions.length]);

  useLayoutEffect(() => {
    const close = () => onClose();
    const key = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  if (!actions.length || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      role="toolbar"
      aria-label="Generation actions"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onClick={(e) => e.stopPropagation()}
      style={position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}
      className={cn(
        "fixed z-[90] flex items-stretch gap-0.5 rounded-xl border border-line bg-ink-750/95 p-1 shadow-pop backdrop-blur-xl transition-opacity duration-150",
        position ? "opacity-100" : "opacity-0"
      )}
    >
      {actions.map(({ key, label, icon: Icon, onSelect, disabled, hint, destructive, active }) => (
        <button
          key={key}
          type="button"
          aria-disabled={disabled || undefined}
          aria-label={hint && hint !== label ? `${label}: ${hint}` : label}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            onClose();
            onSelect();
          }}
          className={cn(
            "group/action relative grid h-9 w-9 place-items-center rounded-lg transition",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35",
            disabled
              ? "cursor-not-allowed text-white/25"
              : destructive
                ? "text-red-200/80 hover:bg-red-500/15 hover:text-red-200"
                : active
                  ? "text-amber-300 hover:bg-amber-400/15"
                  : "text-white/75 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon className={cn("h-4 w-4", active && "fill-current")} />
          {/* Icon-only strip: an immediate tooltip names the action, opening
              away from the card (below the strip unless it was flipped above). */}
          <span
            role="tooltip"
            className={cn(
              "pointer-events-none invisible absolute left-1/2 z-10 w-max max-w-[200px] -translate-x-1/2 rounded-md border border-line bg-ink-650 px-2 py-1 text-left text-[11px] leading-snug text-white/90 opacity-0 shadow-pop transition-opacity duration-100",
              "group-hover/action:visible group-hover/action:opacity-100 group-focus-visible/action:visible group-focus-visible/action:opacity-100",
              position?.below === false ? "bottom-full mb-1.5" : "top-full mt-1.5"
            )}
          >
            <span className="block font-medium">{label}</span>
            {hint && hint !== label && <span className="block text-white/55">{hint}</span>}
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}
