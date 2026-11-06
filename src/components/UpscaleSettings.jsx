"use client";

import { useState } from "react";
import { Check, ChevronDown, Clapperboard, Info, ShieldCheck, Sliders, Wand2 } from "lucide-react";
import {
  MAGNIFIC_CREATIVE_PRESETS,
  MAGNIFIC_ENGINES,
  MAGNIFIC_PRECISION_FLAVORS,
  MAGNIFIC_SCALE_FACTORS,
  MAGNIFIC_TOPAZ_INTERPOLATIONS,
  MAGNIFIC_TOPAZ_MODELS,
  MAGNIFIC_VIDEO_DEFAULTS,
  MAGNIFIC_VIDEO_FLAVORS,
  MAGNIFIC_VIDEO_OUTPUT_FORMATS,
  MAGNIFIC_VIDEO_RESOLUTIONS,
} from "@/lib/magnific-ui";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "./Dropdown";

/**
 * The Magnific upscalers and each one's real parameters, shared by the Upscale composer and the Agents tab's Upscale
 * mode. Every control reads `params` and writes through `setParam(key, value)` (the store's upscalerParams or
 * videoUpscalerParams), so both surfaces send the same values.
 */
export const IMAGE_UPSCALE_MODELS = [
  { id: "Magnific Creative", label: "Creative", badge: "AI Detail", desc: "Prompt-guided detail hallucination & stylization (2x–16x)" },
  { id: "Magnific Precision V2", label: "Precision V2", badge: "Advanced Super-Res", desc: "Granular sharpen, smart grain & ultra-detail controls (2x–16x)" },
  { id: "Magnific Precision V1", label: "Precision V1", badge: "Image Enhancement", desc: "Image enhancement with sharpen, grain and detail controls" },
];

export const VIDEO_UPSCALE_MODELS = [
  { id: "Magnific Video Creative", label: "Creative", badge: "AI Detail", desc: "Creative video upscaling with creativity, sharpen and grain controls (720p–4K)" },
  { id: "Magnific Video Creative Turbo", label: "Turbo", badge: "Faster", desc: "Creative upscaling on the faster Turbo endpoint, premium quality applied automatically" },
  { id: "Magnific Video Precision", label: "Precision", badge: "Faithful", desc: "Faithful upscaling; strength blends the original with the upscaled result" },
  { id: "Magnific Video Topaz", label: "Topaz", badge: "Starlight", desc: "Topaz Starlight enhancement with optional AI frame interpolation" },
];

const RESOLUTION_LABELS = { "720p": "720p", "1k": "1K", "2k": "2K", "4k": "4K" };

/** The image upscaler defaults the Reset button restores, per model. */
export function resetImageUpscale(model, setParam) {
  const values = model === "Magnific Creative"
    ? { scaleFactor: "2x", prompt: "", optimizedFor: "standard", engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0 }
    : model === "Magnific Precision V2"
      ? { scaleFactor: "2x", flavor: "photo", sharpen: 7, smartGrain: 7, ultraDetail: 30 }
      : { sharpen: 50, smartGrain: 7, ultraDetail: 30 };
  for (const [key, value] of Object.entries({ ...values, filterNsfw: false })) setParam(key, value);
}

export function resetVideoUpscale(setParam) {
  for (const [key, value] of Object.entries(MAGNIFIC_VIDEO_DEFAULTS)) {
    if (key !== "model") setParam(key, value);
  }
}

export function Slider({ label, value, min = 0, max = 100, step = 1, onChange, hint, minLabel, maxLabel }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-white/70">{label}</span>
        <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
      />
      <div className="flex justify-between text-[9px] text-white/30">
        <span>{minLabel ?? min}</span>
        {hint ? <span>{hint}</span> : null}
        <span>{maxLabel ?? max}</span>
      </div>
    </div>
  );
}

export function Choice({ label, options, value, onChange }) {
  const current = options.find((option) => option.id === value) || options[0];
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-white/60">{label}</label>
      <Dropdown
        label={current.label}
        trigger={(open) => (
          <div className="flex h-9 w-full items-center justify-between rounded-xl border border-line bg-ink-900/70 px-3 text-xs text-white hover:bg-ink-900">
            <span className="truncate">{current.label}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 text-white/50 transition-transform", open && "rotate-180")} />
          </div>
        )}
      >
        {(close) =>
          options.map((option) => (
            <MenuItem key={option.id} active={value === option.id} onClick={() => { onChange(option.id); close(); }}>
              <span className="flex-1 text-xs">{option.label}</span>
              {value === option.id && <Check className="h-3.5 w-3.5 text-brand" />}
            </MenuItem>
          ))
        }
      </Dropdown>
    </div>
  );
}

function Steps({ label, values, value, onChange, labels = {} }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-white/60">{label}</label>
      <div className="grid grid-cols-4 gap-1 rounded-xl bg-ink-900/70 p-1 ring-1 ring-line">
        {values.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn("rounded-lg py-1 text-xs font-semibold transition",
              value === option ? "bg-brand text-ink-950 shadow-sm" : "text-white/60 hover:text-white")}
          >
            {labels[option] || option}
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailSliders({ params, setParam, sharpen }) {
  return (
    <div className="rounded-xl border border-line bg-ink-900/40 p-3">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Slider label="Sharpen" value={params.sharpen ?? sharpen} onChange={(value) => setParam("sharpen", value)} />
        <Slider label="Smart Grain" value={params.smartGrain ?? 7} onChange={(value) => setParam("smartGrain", value)} />
        <Slider label="Ultra Detail" value={params.ultraDetail ?? 30} onChange={(value) => setParam("ultraDetail", value)} />
      </div>
    </div>
  );
}

const CREATIVE_SLIDERS = [
  ["creativity", "Creativity", "Strict", "Wild"],
  ["hdr", "HDR Definition", "Soft", "Sharp"],
  ["resemblance", "Resemblance", "Loose", "Faithful"],
  ["fractality", "Fractality", "Subtle", "Intricate"],
];

/** The controls of the chosen image upscaler. */
export function ImageUpscaleSettings({ model, params, setParam }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  if (model === "Magnific Creative") {
    return (
      <>
        <div>
          <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-white/70">
            <span className="flex items-center gap-1.5">
              <Wand2 className="h-3.5 w-3.5 text-brand" />
              Prompt guidance (optional)
            </span>
            <span className="text-[10px] text-white/40">Optional - describe details to sharpen</span>
          </label>
          <textarea
            value={params.prompt || ""}
            onChange={(e) => setParam("prompt", e.target.value)}
            placeholder="e.g. masterpiece, intricate skin texture, natural soft lighting, photorealistic 8k..."
            rows={2}
            className="w-full resize-none rounded-xl border border-line bg-ink-900/70 p-2.5 text-xs text-white placeholder-white/30 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <Steps label="Scale Factor" values={MAGNIFIC_SCALE_FACTORS} value={params.scaleFactor} onChange={(value) => setParam("scaleFactor", value)} />
          <Choice label="Optimized For" options={MAGNIFIC_CREATIVE_PRESETS} value={params.optimizedFor || "standard"} onChange={(value) => setParam("optimizedFor", value)} />
          <Choice label="Engine" options={MAGNIFIC_ENGINES} value={params.engine || "automatic"} onChange={(value) => setParam("engine", value)} />
        </div>
        <div className="rounded-xl border border-line bg-ink-900/40 p-3">
          <button
            type="button"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex w-full items-center justify-between text-xs font-semibold text-white/80"
          >
            <span className="flex items-center gap-1.5">
              <Sliders className="h-3.5 w-3.5 text-brand" />
              Fine-Tuning Controls
            </span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")} />
          </button>
          {showAdvanced && (
            <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              {CREATIVE_SLIDERS.map(([key, label, low, high]) => (
                <Slider key={key} label={label} value={params[key] ?? 0} min={-10} max={10} minLabel={`${low} (-10)`} maxLabel={`${high} (+10)`}
                  onChange={(value) => setParam(key, value)} />
              ))}
            </div>
          )}
        </div>
      </>
    );
  }
  if (model === "Magnific Precision V2") {
    return (
      <>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Steps label="Scale Factor" values={MAGNIFIC_SCALE_FACTORS} value={params.scaleFactor} onChange={(value) => setParam("scaleFactor", value)} />
          <Choice label="Optimization Flavor" options={MAGNIFIC_PRECISION_FLAVORS} value={params.flavor || "photo"} onChange={(value) => setParam("flavor", value)} />
        </div>
        <DetailSliders params={params} setParam={setParam} sharpen={7} />
      </>
    );
  }
  return (
    <>
      <div className="flex items-start gap-2.5 rounded-xl border border-blue-500/20 bg-blue-950/30 p-3 text-xs text-blue-200/90">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
        <div>
          <p className="font-semibold text-blue-100">Precision image enhancement</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-blue-200/70">
            Adjust sharpening, grain and detail. Scale and prompt are not used by this model.
          </p>
        </div>
      </div>
      <DetailSliders params={params} setParam={setParam} sharpen={50} />
    </>
  );
}

/** The controls of the chosen video upscaler. */
export function VideoUpscaleSettings({ model, params, setParam }) {
  const topaz = model === "Magnific Video Topaz";
  const precision = model === "Magnific Video Precision";
  return (
    <>
      <div className={cn("grid grid-cols-1 gap-2.5", topaz ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
        <Steps label="Output Resolution" values={MAGNIFIC_VIDEO_RESOLUTIONS} value={params.resolution} labels={RESOLUTION_LABELS}
          onChange={(value) => setParam("resolution", value)} />
        {topaz ? (
          <Choice label="Enhancement Model" options={MAGNIFIC_TOPAZ_MODELS} value={params.enhancementModel} onChange={(value) => setParam("enhancementModel", value)} />
        ) : (
          <>
            {!precision && <Choice label="Flavor" options={MAGNIFIC_VIDEO_FLAVORS} value={params.flavor} onChange={(value) => setParam("flavor", value)} />}
            <Choice label="Output Format" options={MAGNIFIC_VIDEO_OUTPUT_FORMATS} value={params.outputFormat} onChange={(value) => setParam("outputFormat", value)} />
          </>
        )}
      </div>

      <div className="rounded-xl border border-line bg-ink-900/40 p-3">
        {topaz ? (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-white/60">Frame Rate</label>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-ink-900/70 p-1 ring-1 ring-line">
                <button type="button" aria-pressed={!params.targetFps} onClick={() => setParam("targetFps", null)}
                  className={cn("rounded-lg py-1 text-xs font-semibold transition", !params.targetFps ? "bg-brand text-ink-950 shadow-sm" : "text-white/60 hover:text-white")}>
                  Source
                </button>
                <button type="button" aria-pressed={Boolean(params.targetFps)} onClick={() => setParam("targetFps", params.targetFps || 30)}
                  className={cn("rounded-lg py-1 text-xs font-semibold transition", params.targetFps ? "bg-brand text-ink-950 shadow-sm" : "text-white/60 hover:text-white")}>
                  Target
                </button>
              </div>
            </div>
            {params.targetFps ? (
              <>
                <Slider label="Target FPS" value={params.targetFps} min={15} max={60} onChange={(value) => setParam("targetFps", value)} />
                <Choice label="Frame Interpolation" options={MAGNIFIC_TOPAZ_INTERPOLATIONS} value={params.frameInterpolation} onChange={(value) => setParam("frameInterpolation", value)} />
              </>
            ) : (
              <p className="self-center text-[11px] text-white/40 sm:col-span-2">Keeps the source frame rate. Choose a target to interpolate (15–60 fps).</p>
            )}
            <Slider label="Noise" value={params.noise ?? 0} min={0} max={1} step={0.05} onChange={(value) => setParam("noise", value)} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            {precision
              ? <Slider label="Strength" value={params.strength ?? 60} onChange={(value) => setParam("strength", value)} hint={params.fpsBoost ? "ignored with FPS boost" : undefined} />
              : <Slider label="Creativity" value={params.creativity ?? 0} onChange={(value) => setParam("creativity", value)} />}
            <Slider label="Sharpen" value={params.sharpen ?? 0} onChange={(value) => setParam("sharpen", value)} />
            <Slider label="Smart Grain" value={params.smartGrain ?? 0} onChange={(value) => setParam("smartGrain", value)} />
          </div>
        )}
      </div>

      {!topaz && params.outputFormat === "prores_422_hq" && (
        <div className="flex items-start gap-2.5 rounded-xl border border-blue-500/20 bg-blue-950/30 p-3 text-xs text-blue-200/90">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
          <p className="text-[11px] leading-relaxed text-blue-200/70">
            ProRes 422 HQ keeps the .mov master. Masters are large; very long 4K clips can exceed the download window.
          </p>
        </div>
      )}
    </>
  );
}

/** The footer toggle beside an upscale's submit: the NSFW filter for images, FPS boost (or Topaz's billing note) for video. */
export function UpscaleToggle({ media, model, params, setParam }) {
  if (media === "image") {
    return (
      <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60 transition hover:text-white">
        <input
          type="checkbox"
          checked={Boolean(params.filterNsfw)}
          onChange={(e) => setParam("filterNsfw", e.target.checked)}
          className="h-4 w-4 rounded border-line bg-ink-900 text-brand focus:ring-brand"
        />
        <ShieldCheck className="h-3.5 w-3.5 text-white/40" />
        <span>Filter NSFW content</span>
      </label>
    );
  }
  if (model === "Magnific Video Topaz") {
    return <span className="flex items-center gap-2 text-xs text-white/40"><Clapperboard className="h-3.5 w-3.5" />Billed per output frame</span>;
  }
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60 transition hover:text-white">
      <input
        type="checkbox"
        checked={Boolean(params.fpsBoost)}
        onChange={(e) => setParam("fpsBoost", e.target.checked)}
        className="h-4 w-4 rounded border-line bg-ink-900 text-brand focus:ring-brand"
      />
      <span>FPS boost (smoother motion, more frames billed)</span>
    </label>
  );
}
