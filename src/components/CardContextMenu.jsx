"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

const MARGIN = 8;

// Only one card menu is open at a time: opening another dismisses this one.
let dismissOpenMenu = null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** Viewport placement for a popup of `width`x`height` next to `anchor` (a
 *  viewport rect; a zero-size rect for a pointer position). Prefers below and
 *  extending right, flips to whichever side has room, then clamps so the whole
 *  popup stays inside the viewport. */
export function placeMenu(anchor, width, height, viewport, gap = 0) {
  let left = anchor.left;
  if (left + width > viewport.width - MARGIN) left = anchor.right - width;
  let top = anchor.bottom + gap;
  if (top + height > viewport.height - MARGIN) top = anchor.top - gap - height;
  return {
    left: clamp(left, MARGIN, viewport.width - width - MARGIN),
    top: clamp(top, MARGIN, viewport.height - height - MARGIN),
  };
}

/**
 * Custom context menu for a library card, portalled to the body.
 *
 * The portal stays in the card's React tree, so every event that would bubble
 * through React to the card or the grid (click to open the viewer, pointer
 * down to start a marquee, Space to toggle selection, arrows to move focus) is
 * stopped at the menu. Keys are handled on a capturing window listener because
 * the drawer and library also listen on the document.
 *
 * `toggle` is a ref to the card's "..." button: pressing it toggles the menu
 * itself, and scrolling any element that contains it closes the menu.
 */
export function CardContextMenu({ anchor, gap = 0, focusFirst = false, toggle, label, header, groups, onClose }) {
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [position, setPosition] = useState(null);
  const reducedMotion = useReducedMotion();
  const detailsId = useId();
  const visibleGroups = groups.map((group) => group.filter(Boolean)).filter((group) => group.length);

  useEffect(() => {
    const dismiss = () => onClose({ restoreFocus: false });
    dismissOpenMenu?.();
    dismissOpenMenu = dismiss;
    return () => {
      if (dismissOpenMenu === dismiss) dismissOpenMenu = null;
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const place = () => {
      setPosition(placeMenu(anchor, root.offsetWidth, root.offsetHeight,
        { width: window.innerWidth, height: window.innerHeight }, gap));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [anchor, gap]);

  const positioned = position !== null;
  useEffect(() => {
    if (!positioned) return undefined;
    // Focus once the menu is placed and visible; focusing a hidden popup on
    // its first frame silently fails in real browsers.
    const frame = requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
      if (focusFirst && first) first.focus({ preventScroll: true });
      else menuRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [positioned, focusFirst]);

  useEffect(() => {
    const items = () => Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []);
    const focusInside = () => rootRef.current?.contains(document.activeElement);
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose({ restoreFocus: true });
        return;
      }
      if (!focusInside()) {
        if (event.key === "Tab") onClose({ restoreFocus: false });
        return;
      }
      event.stopPropagation();
      if (event.key === "Tab") {
        event.preventDefault();
        onClose({ restoreFocus: true });
        return;
      }
      const list = items();
      if (!list.length) return;
      const current = list.indexOf(document.activeElement);
      let next = null;
      if (event.key === "ArrowDown") next = current === -1 ? 0 : (current + 1) % list.length;
      else if (event.key === "ArrowUp") next = current === -1 ? list.length - 1 : (current - 1 + list.length) % list.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = list.length - 1;
      if (next === null) return;
      event.preventDefault();
      list[next].focus({ preventScroll: true });
    };
    const onPointerDown = (event) => {
      // The button that opened the menu closes it itself on click.
      if (rootRef.current?.contains(event.target) || toggle?.current?.contains(event.target)) return;
      onClose({ restoreFocus: false });
    };
    const onScroll = (event) => {
      // Only a scroll that moves the card closes the menu. Unrelated
      // scrollers do not: a text field that loses focus to the menu resets
      // its own scroll position, which would otherwise close it at once.
      const target = event.target;
      if (rootRef.current?.contains(target)) return;
      const card = toggle?.current;
      if (card && target instanceof Element && !target.contains(card)) return;
      onClose({ restoreFocus: focusInside() });
    };
    const onResize = () => onClose({ restoreFocus: focusInside() });
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose, toggle]);

  if (typeof document === "undefined") return null;
  const stop = (event) => event.stopPropagation();
  const ox = position && position.left < anchor.left ? "right" : "left";
  const oy = position && position.top < anchor.top ? "bottom" : "top";

  return createPortal(
    <motion.div
      ref={rootRef}
      data-card-context-menu
      initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.12, ease: [0.22, 1, 0.36, 1] }}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
        transformOrigin: `${oy} ${ox}`,
      }}
      className="scroll-thin fixed z-[120] max-h-[calc(100dvh-16px)] w-[272px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl"
    >
      {header && <div id={detailsId}>{header}</div>}
      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={label}
        aria-describedby={header ? detailsId : undefined}
        className="p-1 outline-none"
      >
        {visibleGroups.map((group, index) => (
          <div key={group[0].key} role="group">
            {index > 0 && <div role="separator" className="mx-2 my-1 h-px bg-line" />}
            {group.map((item) => (
              <CardMenuItem key={item.key} item={item} onClose={onClose} />
            ))}
          </div>
        ))}
      </div>
    </motion.div>,
    document.body
  );
}

function CardMenuItem({ item, onClose }) {
  const { label, icon: Icon, onSelect, disabled, reason, detail, destructive, active, hint } = item;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      title={disabled ? reason : hint}
      data-menu-item={item.key}
      onPointerMove={(event) => {
        if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
      }}
      onPointerLeave={(event) => {
        if (document.activeElement === event.currentTarget) event.currentTarget.closest('[role="menu"]')?.focus({ preventScroll: true });
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onClose({ restoreFocus: true });
        onSelect();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] leading-5 outline-none transition-colors duration-75",
        disabled
          ? "cursor-not-allowed text-white/30 focus:bg-white/[0.04]"
          : destructive
            ? "text-red-300 focus:bg-red-500/15 focus:text-red-200"
            : "text-white/80 focus:bg-white/[0.08] focus:text-white"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "h-4 w-4 shrink-0",
          disabled ? "text-white/20" : destructive ? "text-red-300/80" : active ? "fill-current text-amber-300" : "text-white/50"
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {disabled && reason && <span className="block text-[11px] leading-4 text-white/30">{reason}</span>}
      </span>
      {detail && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-white/35">{detail}</span>}
    </button>
  );
}
