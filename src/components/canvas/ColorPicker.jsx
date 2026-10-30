"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Pipette, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { BOARD_COLORS, customColors, normalizeHex, removeCustomColor, saveCustomColor } from "@/lib/canvas/styles";

const CHECKERBOARD = { backgroundImage: "repeating-conic-gradient(#666 0% 25%, #333 0% 50%)", backgroundSize: "6px 6px" };

function swatchStyle(value) {
  return value === "transparent" ? CHECKERBOARD : { backgroundColor: value };
}

/**
 * A color picker panel: a palette (the board's 23 colors unless `palette` is
 * given), the person's saved custom colors, a spectrum, a hex field and, where
 * the browser has one, an eyedropper. Colors chosen by spectrum, hex or
 * eyedropper are saved as custom colors for this person in this browser.
 */
export function ColorPicker({ value, palette = BOARD_COLORS, onPick }) {
  const userId = useStore((s) => s.currentUser?.id ?? null);
  const [saved, setSaved] = useState(() => customColors(userId));
  const [hex, setHex] = useState(normalizeHex(value) ?? "");
  const spectrumRef = useRef(null);
  const current = normalizeHex(value) ?? value;
  const pickCustom = (color) => {
    const normal = normalizeHex(color);
    if (!normal) return;
    setSaved(saveCustomColor(userId, normal));
    onPick(normal);
  };
  const pickCustomRef = useRef(pickCustom);
  pickCustomRef.current = pickCustom;

  // The spectrum applies once its picker closes ("change"), not on every drag step.
  useEffect(() => {
    const input = spectrumRef.current;
    if (!input) return;
    const onChange = () => pickCustomRef.current(input.value);
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, []);

  const eyeDropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    try {
      const result = await new window.EyeDropper().open();
      pickCustom(result.sRGBHex);
    } catch {
      // Escape cancels the eyedropper.
    }
  };

  return (
    <div className="w-[13.5rem]" data-color-picker="">
      <div className="grid grid-cols-6 gap-1.5 p-1">
        {palette.map((swatch) => (
          <button
            key={swatch.value}
            type="button"
            aria-label={swatch.name}
            title={swatch.name}
            onClick={() => onPick(swatch.value)}
            className="relative grid h-7 w-7 place-items-center rounded-md border border-white/15"
            style={swatchStyle(swatch.value)}
          >
            {current === swatch.value && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
          </button>
        ))}
      </div>
      {saved.length > 0 && (
        <div className="border-t border-line p-1">
          <p className="px-0.5 pb-1 text-[11px] text-white/40">My colors</p>
          <div className="grid grid-cols-6 gap-1.5">
            {saved.map((color) => (
              <span key={color} className="group relative">
                <button
                  type="button"
                  aria-label={`Custom color ${color}`}
                  title={color}
                  onClick={() => onPick(color)}
                  className="grid h-7 w-7 place-items-center rounded-md border border-white/15"
                  style={swatchStyle(color)}
                >
                  {current === color && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
                </button>
                <button
                  type="button"
                  aria-label={`Remove custom color ${color}`}
                  title="Remove"
                  onClick={() => setSaved(removeCustomColor(userId, color))}
                  className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 place-items-center rounded-full bg-ink-600 text-white/80 ring-1 ring-line group-hover:grid focus-visible:grid"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 border-t border-line p-1.5">
        <label className="relative grid h-7 w-7 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md border border-white/15"
          title="Pick from the spectrum"
          style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}>
          <input ref={spectrumRef} type="color" aria-label="Pick from the spectrum" defaultValue={normalizeHex(value) ?? "#ffffff"}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label>
        <input
          value={hex}
          aria-label="Hex color"
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pickCustom(hex);
          }}
          placeholder="#rrggbb"
          className={cn(
            "h-7 min-w-0 flex-1 rounded-md border bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40",
            hex && !normalizeHex(hex) ? "border-red-400/60" : "border-line"
          )}
        />
        {eyeDropper && (
          <button type="button" aria-label="Pick a color from the screen" title="Pick a color from the screen" onClick={pickFromScreen}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/60 hover:bg-white/10 hover:text-white">
            <Pipette className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={() => pickCustom(hex)} disabled={!normalizeHex(hex)}
          className="rounded-md bg-brand/20 px-2 py-1 text-xs font-semibold text-brand hover:bg-brand/30 disabled:opacity-40">
          Use
        </button>
      </div>
    </div>
  );
}
