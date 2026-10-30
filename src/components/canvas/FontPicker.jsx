"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { cn } from "@/lib/utils";
import { BOARD_FONTS, FONT_GROUPS, fontFamilyCss } from "@/lib/canvas/fonts";

/** Font family for the selected text, stickies and shapes; each font shows in itself. */
export function FontPicker({ value, onChange }) {
  const [query, setQuery] = useState("");
  const current = BOARD_FONTS.find((font) => font.id === value);
  const matches = (font) => font.name.toLowerCase().includes(query.trim().toLowerCase());
  return (
    <Dropdown
      label="Font"
      onOpen={() => setQuery("")}
      trigger={(open) => (
        <span
          aria-label="Font"
          title="Font"
          className={cn(
            "flex h-8 w-24 cursor-pointer items-center truncate rounded-lg bg-ink-800 px-2 text-xs text-white/80 transition hover:text-white",
            open && "ring-1 ring-brand/50"
          )}
          style={{ fontFamily: fontFamilyCss(value) }}
        >
          {current?.name ?? "Default"}
        </span>
      )}
    >
      {(close) => {
        const pick = (id) => {
          onChange(id);
          close();
        };
        return (
          <div className="w-56" data-font-picker="">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search fonts"
              aria-label="Search fonts"
              className="mb-1 h-8 w-full rounded-lg border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
            />
            <div className="max-h-72 overflow-y-auto">
              {!query.trim() && <FontRow name="Default" selected={!current} onClick={() => pick(null)} />}
              {FONT_GROUPS.map((group) => {
                const fonts = BOARD_FONTS.filter((font) => font.group === group.id && matches(font));
                if (!fonts.length) return null;
                return (
                  <div key={group.id} role="group" aria-label={group.name}>
                    <p className="px-2 pb-0.5 pt-2 text-[11px] text-white/40">{group.name}</p>
                    {fonts.map((font) => (
                      <FontRow key={font.id} name={font.name} family={fontFamilyCss(font.id)} selected={value === font.id} onClick={() => pick(font.id)} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }}
    </Dropdown>
  );
}

function FontRow({ name, family, selected, onClick }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-brand/15 text-white" : "text-white/75 hover:bg-white/6 hover:text-white"
      )}
      style={{ fontFamily: family }}
    >
      <span className="flex-1 truncate">{name}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
    </button>
  );
}
