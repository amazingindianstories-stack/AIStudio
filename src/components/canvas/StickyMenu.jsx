"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, Layers, ListPlus, StickyNote } from "lucide-react";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { addBulkStickies, addStickyStack } from "@/lib/canvas/sticky-actions";
import { MAX_BULK_STICKIES } from "@/lib/canvas/stickies";
import { cn } from "@/lib/utils";

/**
 * The sticky tool's menu beside its toolbar button: the sticky note tool,
 * bulk mode (one sticky per typed line) and a sticky stack, both added at the
 * middle of the view.
 */
export function StickyMenu({ onStickyTool, viewCenter }) {
  const [bulkOpen, setBulkOpen] = useState(false);
  return (
    <>
      <Dropdown
        side="top"
        label="Sticky options"
        trigger={(open) => (
          <span
            aria-label="Sticky options"
            title="Sticky options"
            className={cn(
              "-ml-1 grid h-9 w-4 place-items-center rounded-md text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8",
              open && "bg-white/[0.07] text-white"
            )}
          >
            <ChevronUp className="h-3 w-3" />
          </span>
        )}
      >
        {(close) => (
          <>
            <MenuItem onClick={() => { onStickyTool(); close(); }}>
              <StickyNote className="h-4 w-4 text-white/45" /> Sticky note
              <span className="ml-auto text-xs text-white/40">N</span>
            </MenuItem>
            <MenuItem onClick={() => { setBulkOpen(true); close(); }}>
              <ListPlus className="h-4 w-4 text-white/45" /> Bulk mode
            </MenuItem>
            <MenuItem onClick={() => { addStickyStack(viewCenter()); close(); }}>
              <Layers className="h-4 w-4 text-white/45" /> Sticky stack
            </MenuItem>
          </>
        )}
      </Dropdown>
      {bulkOpen && <BulkStickiesDialog onClose={() => setBulkOpen(false)} viewCenter={viewCenter} />}
    </>
  );
}

/** Bulk mode: type or paste lines, and each non-blank line becomes a sticky. */
function BulkStickiesDialog({ onClose, viewCenter }) {
  const [text, setText] = useState("");
  const areaRef = useRef(null);
  const count = Math.min(text.split(/\r\n?|\n/).filter((line) => line.trim()).length, MAX_BULK_STICKIES);
  useEffect(() => {
    // The menu that opened this hands focus back to its trigger as it closes,
    // so the text area takes focus a frame later, and returns it on close.
    const frame = requestAnimationFrame(() => areaRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.querySelector('[aria-label="Sticky options"][aria-haspopup]')?.focus?.();
    };
  }, []);
  const add = () => {
    if (!count) return;
    addBulkStickies(text, viewCenter());
    onClose();
  };
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/55 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-stickies-title"
        className="w-full max-w-md rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            add();
          } else if (e.key === "Tab") {
            // Focus stays inside the dialog.
            const focusable = [...e.currentTarget.querySelectorAll("textarea, button:not(:disabled)")];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="bulk-stickies-title" className="text-sm font-semibold text-white">Add stickies in bulk</h2>
        <p className="mt-1 text-xs text-white/50">Each line becomes its own sticky note.</p>
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          aria-label="One sticky per line"
          placeholder={"First idea\nSecond idea\nThird idea"}
          className="mt-3 w-full resize-y rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-brand/40"
        />
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-white/40">{count === MAX_BULK_STICKIES ? `Up to ${MAX_BULK_STICKIES} at a time` : "⌘ Enter to add"}</span>
          <button type="button" onClick={onClose}
            className="ml-auto rounded-lg px-3 py-1.5 text-sm font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand">
            Cancel
          </button>
          <button type="button" onClick={add} disabled={!count}
            className="rounded-lg bg-brand/90 px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none hover:bg-brand focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-45">
            {count ? `Add ${count} ${count === 1 ? "sticky" : "stickies"}` : "Add stickies"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
