"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,

} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export function Dropdown({
  trigger,
  children,
  align = "left",
  side = "bottom",
  className,
  panelClassName,
  label,
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const closeAndRestore = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  // Opening via the keyboard (ArrowDown/ArrowUp on the trigger) lands focus
  // on the first/last menuitem, mirroring native <select>/menu conventions
  // on both Mac and Windows — otherwise a keyboard-only user can open the
  // panel but has no way to reach an item inside it.
  const openAndFocus = useCallback((fromEnd) => {
    setOpen(true);
    requestAnimationFrame(() => {
      const items = panelRef.current?.querySelectorAll(
        '[role="menuitem"]:not(:disabled)'
      );
      const target = fromEnd ? items?.[items.length - 1] : items?.[0];
      target?.focus();
    });
  }, []);

  // Arrow-key roving focus among menuitem children once the panel is open.
  // Scoped to [role="menuitem"] specifically (not every focusable element in
  // the panel) so this never hijacks arrow keys inside a non-menu panel —
  // e.g. the composer settings panel's duration slider, which relies on
  // ArrowLeft/Right to adjust its own value.
  const onPanelKeyDown = useCallback((e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const items = Array.from(
      panelRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? []
    );
    if (!items.length) return;
    e.preventDefault();
    if (e.key === "Home") {
      items[0].focus();
      return;
    }
    if (e.key === "End") {
      items[items.length - 1].focus();
      return;
    }
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const current = items.indexOf(document.activeElement );
    const next =
      current === -1 ? (dir === 1 ? 0 : items.length - 1) : (current + dir + items.length) % items.length;
    items[next].focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const target = e.target ;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onEsc = (e) => {
      if (e.key === "Escape") closeAndRestore();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, closeAndRestore]);

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const margin = 8;
      const gap = 8;
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const width = Math.min(panelRect.width, window.innerWidth - margin * 2);
      const height = Math.min(panelRect.height, window.innerHeight - margin * 2);

      let left = align === "right" ? triggerRect.right - width : triggerRect.left;
      left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);

      const above = triggerRect.top - height - gap;
      const below = triggerRect.bottom + gap;
      let top = side === "top" ? above : below;
      if (top < margin) top = below;
      if (top + height > window.innerHeight - margin) top = Math.max(margin, above);

      setPosition({ left, top });
    };

    const frame = requestAnimationFrame(place);
    const observer = new ResizeObserver(place);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, open, side]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAndFocus(false);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openAndFocus(true);
          }
        }}
        className="block max-w-full"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        {trigger(open)}
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={panelRef}
                id={panelId}
                role="menu"
                onKeyDown={onPanelKeyDown}
                initial={{ opacity: 0, y: side === "bottom" ? -6 : 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: side === "bottom" ? -6 : 6, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 480, damping: 32 }}
                style={{
                  left: position?.left ?? 8,
                  top: position?.top ?? 8,
                  visibility: position ? "visible" : "hidden",
                }}
                className={cn(
                  "scroll-thin fixed z-[100] max-h-[calc(100dvh-1rem)] min-w-[170px] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl",
                  panelClassName
                )}
              >
                {children(closeAndRestore)}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  );
}

export function MenuItem({
  active,
  disabled,
  onClick,
  children,
}

) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
        disabled
          ? "cursor-not-allowed text-white/25"
          : active
          ? "bg-brand/15 text-white"
          : "text-white/75 hover:bg-white/6 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}
