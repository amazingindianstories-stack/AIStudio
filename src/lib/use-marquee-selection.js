"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  rectsIntersect,
  normalizeRect,
  computeMarqueeSelection,
  computeAutoscrollDelta,
} from "./marquee-geometry";

const DRAG_SLOP_PX = 4;
const INTERACTIVE = "button, a, input, select, textarea, [role='menuitem']";

function sameIds(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The drag-to-select machinery, without React, so it can be driven by tests.
 *
 * Pointer moves only record the latest pointer position and ask for a frame;
 * the frame reads layout once, positions the rectangle and recomputes the hit
 * set against card bounds cached when the drag started. The selection is
 * written only when that set actually changes, which is what keeps a large
 * grid of subscribed cards from re-rendering on every pixel of movement.
 */
export function createMarqueeController({
  getScroller,
  itemAttribute,
  getSelected,
  setSelected,
  onClickBackground,
  onActiveChange,
  onRect,
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
}) {
  let drag = null;

  const finish = () => {
    if (drag?.frame) cancelFrame(drag.frame);
    drag = null;
  };

  const frame = () => {
    if (!drag) return;
    drag.frame = 0;
    const el = getScroller();
    if (!el) { finish(); return; }
    const bounds = el.getBoundingClientRect();
    const delta =
      computeAutoscrollDelta(drag.pointer.y, bounds.top, "top", 44, 20) ||
      computeAutoscrollDelta(drag.pointer.y, bounds.bottom, "bottom", 44, 20);
    if (delta !== 0) el.scrollTop += delta;
    const rect = normalizeRect(
      drag.start.x,
      drag.start.y,
      drag.pointer.x - bounds.left + el.scrollLeft,
      drag.pointer.y - bounds.top + el.scrollTop
    );
    onRect?.(rect);
    const hits = [];
    for (const card of drag.cards) if (rectsIntersect(rect, card)) hits.push(card.id);
    const next = computeMarqueeSelection(drag.initial, hits, { shift: drag.shift, alt: drag.alt });
    if (!sameIds(next, drag.emitted)) {
      drag.emitted = next;
      setSelected(next);
    }
    // Keep scrolling while the pointer rests in the edge band, even with no moves.
    if (delta !== 0) drag.frame = requestFrame(frame);
  };

  const schedule = () => {
    if (drag && !drag.frame) drag.frame = requestFrame(frame);
  };

  return {
    pointerDown(e) {
      if (e.button !== 0) return;
      // A drag that starts on a card or a control belongs to that element.
      if (e.target.closest?.(`[${itemAttribute}]`) || e.target.closest?.(INTERACTIVE)) return;
      // Touch never starts a marquee (a drag scrolls), but a tap on the
      // background still deselects, so only the tap is tracked.
      if (e.pointerType === "touch") {
        drag = { tap: true, startScreen: { x: e.clientX, y: e.clientY }, moved: false, frame: 0 };
        return;
      }
      const el = getScroller();
      if (!el) return;
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore untracked or synthetic pointer ids */
      }
      const bounds = el.getBoundingClientRect();
      const cards = Array.from(el.querySelectorAll(`[${itemAttribute}]`)).map((card) => {
        const box = card.getBoundingClientRect();
        return {
          id: card.getAttribute(itemAttribute),
          left: box.left - bounds.left + el.scrollLeft,
          top: box.top - bounds.top + el.scrollTop,
          width: box.width,
          height: box.height,
        };
      });
      drag = {
        pointerId: e.pointerId,
        startScreen: { x: e.clientX, y: e.clientY },
        pointer: { x: e.clientX, y: e.clientY },
        start: { x: e.clientX - bounds.left + el.scrollLeft, y: e.clientY - bounds.top + el.scrollTop },
        cards,
        initial: getSelected(),
        emitted: null,
        shift: e.shiftKey,
        alt: e.altKey,
        moved: false,
        frame: 0,
      };
    },
    pointerMove(e) {
      if (!drag) return;
      if (drag.tap) {
        if (Math.hypot(e.clientX - drag.startScreen.x, e.clientY - drag.startScreen.y) > DRAG_SLOP_PX) drag.moved = true;
        return;
      }
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startScreen.x, e.clientY - drag.startScreen.y) <= DRAG_SLOP_PX) return;
        drag.moved = true;
        onActiveChange?.(true);
        drag.pointer = { x: e.clientX, y: e.clientY };
        // Size the rectangle before the overlay first renders.
        frame();
        return;
      }
      drag.pointer = { x: e.clientX, y: e.clientY };
      drag.shift = e.shiftKey;
      drag.alt = e.altKey;
      schedule();
    },
    pointerUp(e) {
      // Apply a pointer position that is still waiting for its frame.
      if (drag?.moved && drag.frame) {
        cancelFrame(drag.frame);
        drag.frame = 0;
        frame();
      }
      const current = drag;
      finish();
      if (!current) return;
      if (current.tap) {
        if (!current.moved) onClickBackground?.();
        return;
      }
      try {
        getScroller()?.releasePointerCapture?.(current.pointerId);
      } catch {
        /* ignore */
      }
      if (current.moved) onActiveChange?.(false);
      // A plain click on empty background deselects.
      else if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onClickBackground?.();
    },
    pointerCancel() {
      const current = drag;
      finish();
      if (current?.moved) onActiveChange?.(false);
    },
    destroy: finish,
  };
}

/**
 * Drag-to-select for a scrolling grid.
 *
 * `scrollRef` is the scroller the rectangle is positioned in (it must be a
 * positioned element). Items are the descendants carrying `itemAttribute`,
 * whose value is the item id. Spread `handlers` on the scroller and render
 * `<div ref={overlayRef} />` while `active` is true; the rectangle is moved
 * through the ref so a drag never re-renders the grid.
 */
export function useMarqueeSelection({
  scrollRef,
  itemAttribute = "data-asset-card-id",
  getSelected,
  setSelected,
  onClickBackground,
}) {
  const [active, setActive] = useState(false);
  const overlayRef = useRef(null);
  const rectRef = useRef(null);
  const latest = useRef({});
  latest.current = { getSelected, setSelected, onClickBackground };

  const paint = useCallback(() => {
    const overlay = overlayRef.current, rect = rectRef.current;
    if (!overlay || !rect) return;
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }, []);

  const controller = useMemo(() => createMarqueeController({
    getScroller: () => scrollRef.current,
    itemAttribute,
    getSelected: () => latest.current.getSelected(),
    setSelected: (ids) => latest.current.setSelected(ids),
    onClickBackground: () => latest.current.onClickBackground?.(),
    onActiveChange: setActive,
    onRect: (rect) => { rectRef.current = rect; paint(); },
  }), [scrollRef, itemAttribute, paint]);

  // The overlay mounts after the first rectangle is computed; place it then.
  useLayoutEffect(() => { if (active) paint(); }, [active, paint]);
  useEffect(() => () => controller.destroy(), [controller]);

  const handlers = useMemo(() => ({
    onPointerDown: controller.pointerDown,
    onPointerMove: controller.pointerMove,
    onPointerUp: controller.pointerUp,
    onPointerCancel: controller.pointerCancel,
  }), [controller]);

  return { active, overlayRef, handlers };
}
