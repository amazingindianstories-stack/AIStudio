"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBoardPrefs } from "@/lib/canvas/board-prefs";
import { SHORTCUT_GROUPS, comboLabels, isMacPlatform, isSingleCharacter, parseCombo, shortcutEntries } from "@/lib/canvas/shortcuts";

/** The keys an entry lists: its `display` range ("1" to "9") or every key it answers to. */
function entryKeys(entry) {
  return entry.display ? [entry.display.join("-")] : entry.keys;
}

function Keys({ spec, mac }) {
  if (spec.includes("-") && spec.length === 3) {
    return <kbd className="rounded-md bg-ink-600 px-1.5 py-0.5 font-sans text-xs text-white/80 ring-1 ring-line">{spec.replace("-", " to ")}</kbd>;
  }
  return (
    <span className="inline-flex gap-0.5">
      {comboLabels(spec, mac).map((cap, i) => (
        <kbd key={i} className="min-w-5 rounded-md bg-ink-600 px-1.5 py-0.5 text-center font-sans text-xs text-white/80 ring-1 ring-line">
          {cap}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Every board shortcut, grouped, from the shortcut registry, with the switch
 * that turns single-key shortcuts off (for voice control and screen reader
 * users whose spoken or typed letters would otherwise run tools).
 */
export function ShortcutsPanel({ onClose }) {
  const singleKeys = useBoardPrefs((s) => s.singleKeyShortcuts);
  const setPrefs = useBoardPrefs((s) => s.setPrefs);
  const closeRef = useRef(null);
  const mac = isMacPlatform();
  const entries = shortcutEntries().filter((e) => !e.hidden);

  useEffect(() => closeRef.current?.focus(), []);

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="board-shortcuts-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        className="flex max-h-[min(720px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-750 shadow-pop"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id="board-shortcuts-title" className="text-base font-semibold text-white/90">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/50 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <label className="flex items-start gap-3 border-b border-line px-5 py-3.5">
          <input
            type="checkbox"
            checked={singleKeys}
            onChange={(e) => setPrefs({ singleKeyShortcuts: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-white"
          />
          <span>
            <span className="block text-sm text-white/85">Single-key shortcuts</span>
            <span className="block text-xs text-white/50">
              Letters and numbers on their own pick tools. Turn this off if you use voice control or a screen reader. Saved on this device.
            </span>
          </span>
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {SHORTCUT_GROUPS.map((group) => {
              const rows = entries.filter((e) => e.group === group);
              if (!rows.length) return null;
              return (
                <section key={group} aria-labelledby={`shortcuts-${group}`}>
                  <h3 id={`shortcuts-${group}`} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                    {group}
                  </h3>
                  <dl className="flex flex-col">
                    {rows.map((entry) => {
                      const off = !singleKeys && entry.run && entry.keys.every((spec) => isSingleCharacter(parseCombo(spec)));
                      return (
                        <div key={entry.id} className={cn("flex items-center justify-between gap-3 py-1", off && "opacity-40")}>
                          <dt className="text-sm text-white/75">
                            {entry.label}
                            {off && <span className="sr-only"> (off)</span>}
                          </dt>
                          <dd className="flex shrink-0 flex-wrap justify-end gap-1.5">
                            {entryKeys(entry).map((spec) => (
                              <Keys key={spec} spec={spec} mac={mac} />
                            ))}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
