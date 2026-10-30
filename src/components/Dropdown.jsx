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
import { useMaintenance } from "@/lib/maintenance-client";
import { MAINTENANCE_MESSAGE } from "@/lib/maintenance";
import { cn } from "@/lib/utils";

const PANEL_MARGIN = 8;
// Every kind of menu item the arrow keys move between.
const MENU_ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';
const PANEL_GAP = 8;

// Opens on the preferred side, flips when only the other side fits, and when
// neither fits uses the roomier side with a scrolling cap so the panel never
// covers its own trigger.
export function placeDropdownPanel({ trigger, width, height, viewport, align, side }) {
  const panelWidth = Math.min(width, viewport.width - PANEL_MARGIN * 2);
  let left = align === "right" ? trigger.right - panelWidth : trigger.left;
  left = Math.min(Math.max(PANEL_MARGIN, left), viewport.width - panelWidth - PANEL_MARGIN);

  const spaceAbove = Math.max(0, trigger.top - PANEL_GAP - PANEL_MARGIN);
  const spaceBelow = Math.max(0, viewport.height - PANEL_MARGIN - trigger.bottom - PANEL_GAP);
  const preferBelow = side !== "top";
  const below = height <= (preferBelow ? spaceBelow : spaceAbove) ? preferBelow
    : height <= (preferBelow ? spaceAbove : spaceBelow) ? !preferBelow
    : spaceBelow >= spaceAbove;
  const maxHeight = Math.min(height, below ? spaceBelow : spaceAbove);
  const top = below ? trigger.bottom + PANEL_GAP : trigger.top - PANEL_GAP - maxHeight;
  return { left, top, maxHeight };
}

export function Dropdown({
  trigger,
  children,
  align = "left",
  side = "bottom",
  className,
  triggerClassName,
  panelClassName,
  label,
  onOpen,
  maintenanceWrite = false,
  open: controlledOpen,
  onOpenChange,
}) {
  const maintenance = useMaintenance((s) => s.enabled);
  const disabled = maintenanceWrite && maintenance;
  // Uncontrolled by default; `open` + `onOpenChange` let a parent open the
  // panel from elsewhere (for example a keyboard shortcut).
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpen = useCallback((next) => {
    setUncontrolledOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);
  const [position, setPosition] = useState(null);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const keyboardFocusRef = useRef(null);
  const panelId = useId();

  useEffect(() => { if (disabled) setOpen(false); }, [disabled, setOpen]);

  const closeAndRestore = useCallback(({ restoreFocus = true } = {}) => {
    keyboardFocusRef.current = null;
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [setOpen]);

  // Opening via the keyboard (ArrowDown/ArrowUp on the trigger) lands focus
  // on the first/last menuitem, mirroring native <select>/menu conventions
  // on both Mac and Windows — otherwise a keyboard-only user can open the
  // panel but has no way to reach an item inside it.
  const openAndFocus = useCallback((fromEnd) => {
    keyboardFocusRef.current = { fromEnd };
    onOpen?.();
    setOpen(true);
  }, [onOpen, setOpen]);

  // The positioned portal must be visible before focusing; focusing a hidden
  // menu on the opening animation frame silently fails in real browsers.
  useLayoutEffect(() => {
    if (!open || !position || !keyboardFocusRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (!keyboardFocusRef.current) return;
      const { fromEnd } = keyboardFocusRef.current;
      const items = panelRef.current?.querySelectorAll(MENU_ITEMS);
      const target = fromEnd ? items?.[items.length - 1] : items?.[0];
      target?.focus();
      keyboardFocusRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, position]);

  const closeOnEscape = useCallback((e) => {
    if (e.key !== "Escape") return false;
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    closeAndRestore();
    return true;
  }, [closeAndRestore]);

  // Arrow-key roving focus among menuitem children once the panel is open.
  // Scoped to menu items specifically (not every focusable element in
  // the panel) so this never hijacks arrow keys inside a non-menu panel —
  // e.g. the composer settings panel's duration slider, which relies on
  // ArrowLeft/Right to adjust its own value.
  const onPanelKeyDown = useCallback((e) => {
    if (closeOnEscape(e)) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const items = Array.from(
      panelRef.current?.querySelectorAll(MENU_ITEMS) ?? []
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
  }, [closeOnEscape]);

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
  }, [open, closeAndRestore, setOpen]);

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      // Measure the unconstrained content height, not the capped or animating box.
      const height = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      setPosition(placeDropdownPanel({
        trigger: trigger.getBoundingClientRect(),
        width: panel.offsetWidth,
        height,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align,
        side,
      }));
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
        disabled={disabled}
        title={disabled ? MAINTENANCE_MESSAGE : undefined}
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (open) {
            closeOnEscape(e);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAndFocus(false);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openAndFocus(true);
          }
        }}
        className={cn("block max-w-full", triggerClassName)}
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
                  maxHeight: position?.maxHeight,
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
  maintenanceWrite = false,
  onClick,
  children,
  // "menuitemcheckbox" or "menuitemradio" with `checked` for toggles and choices.
  role = "menuitem",
  checked,
  label,
  title,
}

) {
  const maintenance = useMaintenance((s) => s.enabled);
  disabled = disabled || (maintenanceWrite && maintenance);
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitem" ? undefined : Boolean(checked)}
      aria-label={label}
      title={title}
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
