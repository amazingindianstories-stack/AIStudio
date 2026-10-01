"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Sparkles,
  UploadCloud,
  X,
  Sliders,
  Wand2,
  ShieldCheck,
  Check,
  RotateCcw,
  Loader2,
  ChevronDown,
  Info,
} from "lucide-react";
import { useStore, findItem } from "@/lib/store";
import {
  MAGNIFIC_CREATIVE_PRESETS,
  MAGNIFIC_ENGINES,
  MAGNIFIC_PRECISION_FLAVORS,
  MAGNIFIC_SCALE_FACTORS,
} from "@/lib/providers/magnific";
import { cn } from "@/lib/utils";
import { uploadContentType, uploadOriginalReference } from "@/lib/client-reference-upload";
import { Dropdown, MenuItem } from "./Dropdown";

const MODELS = [
  {
    id: "Magnific Creative",
    label: "Creative",
    badge: "AI Detail",
    desc: "Prompt-guided detail hallucination & stylization (2x–16x)",
  },
  {
    id: "Magnific Precision V2",
    label: "Precision V2",
    badge: "Advanced Super-Res",
    desc: "Granular sharpen, smart grain & ultra-detail controls (2x–16x)",
  },
  {
    id: "Magnific Precision V1",
    label: "Precision V1",
    badge: "Zero Hallucination",
    desc: "Faithful 2x super-resolution for UI, logos, and product photos",
  },
];

export function UpscalerComposer() {
  const s = useStore();
  const upscalerImage = s.upscalerImage;
  const setUpscalerImage = s.setUpscalerImage;
  const params = s.upscalerParams;
  const setParam = s.setUpscalerParam;
  const generateUpscale = s.generateUpscale;
  const generating = s.generating;

  const [dragging, setDragging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const activeModelId = params.model || "Magnific Creative";

  const handleSelectFile = async (file) => {
    if (!file) return;
    const contentType = uploadContentType(file);
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      alert("Please upload a valid image file (PNG, JPEG, WebP).");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      alert("Source images must be 20 MB or smaller.");
      return;
    }
    setUploading(true);
    try {
      const url = await uploadOriginalReference(file);
      setUpscalerImage({
        url,
        name: file.name,
        size: file.size,
      });
    } catch (error) {
      alert(error?.message || "Could not upload the source image. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);

    // Check for internal generation drag (from chat or library)
    const itemId = e.dataTransfer.getData("text/itemId");
    const item = (itemId ? findItem(s, itemId) : null) || s.draggedItem;
    if (item && item.url) {
      setUpscalerImage({
        url: item.url,
        name: item.prompt ? item.prompt.slice(0, 50) : "Generation reference",
        aspectRatio: item.aspectRatio,
        item,
      });
      return;
    }

    // Check for dropped file
    const file = e.dataTransfer?.files?.[0];
    if (file) handleSelectFile(file);
  };

  const resetParams = () => {
    if (activeModelId === "Magnific Creative") {
      setParam("scaleFactor", "2x");
      setParam("prompt", "");
      setParam("optimizedFor", "standard");
      setParam("engine", "automatic");
      setParam("creativity", 0);
      setParam("hdr", 0);
      setParam("resemblance", 0);
      setParam("fractality", 0);
      setParam("filterNsfw", false);
    } else if (activeModelId === "Magnific Precision V2") {
      setParam("scaleFactor", "2x");
      setParam("flavor", "photo");
      setParam("sharpen", 7);
      setParam("smartGrain", 7);
      setParam("ultraDetail", 30);
      setParam("filterNsfw", false);
    } else {
      setParam("sharpen", 50);
      setParam("smartGrain", 7);
      setParam("ultraDetail", 30);
      setParam("filterNsfw", false);
    }
  };

  return (
    <motion.div
      layout="size"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-line bg-ink-800/95 p-3.5 shadow-panel backdrop-blur-xl sm:p-5"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => handleSelectFile(e.target.files?.[0])}
      />

      {/* Model selection tabs */}
      <div className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div className="flex items-center gap-1.5 rounded-xl bg-ink-900/80 p-1 ring-1 ring-line">
            {MODELS.map((m) => {
              const active = activeModelId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setParam("model", m.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                    active
                      ? "bg-brand/20 text-brand shadow-sm ring-1 ring-brand/40"
                      : "text-white/60 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Sparkles className={cn("h-3.5 w-3.5", active ? "text-brand" : "text-white/40")} />
                  <span>{m.label}</span>
                  <span
                    className={cn(
                      "hidden rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider sm:inline-block",
                      active ? "bg-brand/30 text-white font-semibold" : "bg-white/10 text-white/40"
                    )}
                  >
                    {m.badge}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={resetParams}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-white/50 hover:bg-white/5 hover:text-white/80 transition"
            title="Reset parameters to defaults"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>
        </div>

        {/* Model description banner */}
        <p className="mt-2 text-xs text-white/50">
          {MODELS.find((m) => m.id === activeModelId)?.desc}
        </p>
      </div>

      {/* Image Input Section */}
      <div className="mb-4">
        {upscalerImage ? (
          <div className="relative flex items-center gap-4 rounded-xl border border-line bg-ink-900/60 p-3 shadow-inner">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-ink-950 ring-1 ring-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={typeof upscalerImage === "string" ? upscalerImage : upscalerImage.url}
                alt="Source preview"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">Source Image</span>
                {upscalerImage.aspectRatio && (
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">
                    {upscalerImage.aspectRatio}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-white/60">
                {upscalerImage.name || "Image ready to upscale"}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition"
                >
                  Replace image
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setUpscalerImage(null)}
              className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white transition"
              title="Remove image"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all duration-200",
              dragging
                ? "border-brand bg-brand/10 text-brand"
                : "border-line bg-ink-900/40 text-white/60 hover:border-brand/60 hover:bg-ink-900/80 hover:text-white"
            )}
          >
            <div className="grid h-10 w-10 place-items-center rounded-full bg-white/5 ring-1 ring-line group-hover:bg-brand/20 group-hover:ring-brand/40">
              <UploadCloud className="h-5 w-5 text-brand" />
            </div>
            <div>
              <p className="text-xs font-semibold text-white">
                Drop an image here or <span className="text-brand underline underline-offset-2">browse</span>
              </p>
              <p className="mt-1 text-[11px] text-white/40">
                Or drag any generation directly from the chat feed or library · PNG, JPEG, WebP
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Model-specific controls */}
      <div className="space-y-4">
        {/* CREATIVE CONTROLS */}
        {activeModelId === "Magnific Creative" && (
          <>
            {/* Prompt input */}
            <div>
              <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-white/70">
                <span className="flex items-center gap-1.5">
                  <Wand2 className="h-3.5 w-3.5 text-brand" />
                  Prompt guidance (optional)
                </span>
                <span className="text-[10px] text-white/40">Re-prompting helps hallucinate sharp details</span>
              </label>
              <textarea
                value={params.prompt || ""}
                onChange={(e) => setParam("prompt", e.target.value)}
                placeholder="e.g. masterpiece, intricate skin texture, natural soft lighting, photorealistic 8k..."
                rows={2}
                className="w-full resize-none rounded-xl border border-line bg-ink-900/70 p-2.5 text-xs text-white placeholder-white/30 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>

            {/* Presets & Engine & Scale Factor row */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {/* Scale factor */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-white/60">Scale Factor</label>
                <div className="grid grid-cols-4 gap-1 rounded-xl bg-ink-900/70 p-1 ring-1 ring-line">
                  {MAGNIFIC_SCALE_FACTORS.map((sf) => (
                    <button
                      key={sf}
                      type="button"
                      onClick={() => setParam("scaleFactor", sf)}
                      className={cn(
                        "rounded-lg py-1 text-xs font-semibold transition",
                        params.scaleFactor === sf
                          ? "bg-brand text-ink-950 shadow-sm"
                          : "text-white/60 hover:text-white"
                      )}
                    >
                      {sf}
                    </button>
                  ))}
                </div>
              </div>

              {/* Optimized For */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-white/60">Optimized For</label>
                <Dropdown
                  label={
                    MAGNIFIC_CREATIVE_PRESETS.find((p) => p.id === (params.optimizedFor || "standard"))?.label ||
                    "Standard"
                  }
                  trigger={(open) => (
                    <div className="flex h-9 w-full items-center justify-between rounded-xl border border-line bg-ink-900/70 px-3 text-xs text-white hover:bg-ink-900">
                      <span className="truncate">
                        {MAGNIFIC_CREATIVE_PRESETS.find((p) => p.id === (params.optimizedFor || "standard"))
                          ?.label || "Standard"}
                      </span>
                      <ChevronDown className={cn("h-3.5 w-3.5 text-white/50 transition-transform", open && "rotate-180")} />
                    </div>
                  )}
                >
                  {(close) =>
                    MAGNIFIC_CREATIVE_PRESETS.map((preset) => (
                      <MenuItem
                        key={preset.id}
                        active={params.optimizedFor === preset.id}
                        onClick={() => {
                          setParam("optimizedFor", preset.id);
                          close();
                        }}
                      >
                        <span className="flex-1 text-xs">{preset.label}</span>
                        {params.optimizedFor === preset.id && <Check className="h-3.5 w-3.5 text-brand" />}
                      </MenuItem>
                    ))
                  }
                </Dropdown>
              </div>

              {/* Engine */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-white/60">Engine</label>
                <Dropdown
                  label={
                    MAGNIFIC_ENGINES.find((e) => e.id === (params.engine || "automatic"))?.label || "Automatic"
                  }
                  trigger={(open) => (
                    <div className="flex h-9 w-full items-center justify-between rounded-xl border border-line bg-ink-900/70 px-3 text-xs text-white hover:bg-ink-900">
                      <span className="truncate">
                        {MAGNIFIC_ENGINES.find((e) => e.id === (params.engine || "automatic"))?.label ||
                          "Automatic"}
                      </span>
                      <ChevronDown className={cn("h-3.5 w-3.5 text-white/50 transition-transform", open && "rotate-180")} />
                    </div>
                  )}
                >
                  {(close) =>
                    MAGNIFIC_ENGINES.map((engine) => (
                      <MenuItem
                        key={engine.id}
                        active={params.engine === engine.id}
                        onClick={() => {
                          setParam("engine", engine.id);
                          close();
                        }}
                      >
                        <span className="flex-1 text-xs">{engine.label}</span>
                        {params.engine === engine.id && <Check className="h-3.5 w-3.5 text-brand" />}
                      </MenuItem>
                    ))
                  }
                </Dropdown>
              </div>
            </div>

            {/* Fine tuning sliders */}
            <div className="rounded-xl border border-line bg-ink-900/40 p-3">
              <button
                type="button"
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
                  {/* Creativity */}
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/70">Creativity</span>
                      <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                        {params.creativity ?? 0}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-10}
                      max={10}
                      step={1}
                      value={params.creativity ?? 0}
                      onChange={(e) => setParam("creativity", Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                    />
                    <div className="flex justify-between text-[9px] text-white/30">
                      <span>Strict (-10)</span>
                      <span>Wild (+10)</span>
                    </div>
                  </div>

                  {/* HDR */}
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/70">HDR Definition</span>
                      <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                        {params.hdr ?? 0}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-10}
                      max={10}
                      step={1}
                      value={params.hdr ?? 0}
                      onChange={(e) => setParam("hdr", Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                    />
                    <div className="flex justify-between text-[9px] text-white/30">
                      <span>Soft (-10)</span>
                      <span>Sharp (+10)</span>
                    </div>
                  </div>

                  {/* Resemblance */}
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/70">Resemblance</span>
                      <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                        {params.resemblance ?? 0}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-10}
                      max={10}
                      step={1}
                      value={params.resemblance ?? 0}
                      onChange={(e) => setParam("resemblance", Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                    />
                    <div className="flex justify-between text-[9px] text-white/30">
                      <span>Loose (-10)</span>
                      <span>Faithful (+10)</span>
                    </div>
                  </div>

                  {/* Fractality */}
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/70">Fractality</span>
                      <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                        {params.fractality ?? 0}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-10}
                      max={10}
                      step={1}
                      value={params.fractality ?? 0}
                      onChange={(e) => setParam("fractality", Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                    />
                    <div className="flex justify-between text-[9px] text-white/30">
                      <span>Subtle (-10)</span>
                      <span>Intricate (+10)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* PRECISION V2 CONTROLS */}
        {activeModelId === "Magnific Precision V2" && (
          <>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {/* Scale factor */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-white/60">Scale Factor</label>
                <div className="grid grid-cols-4 gap-1 rounded-xl bg-ink-900/70 p-1 ring-1 ring-line">
                  {MAGNIFIC_SCALE_FACTORS.map((sf) => (
                    <button
                      key={sf}
                      type="button"
                      onClick={() => setParam("scaleFactor", sf)}
                      className={cn(
                        "rounded-lg py-1 text-xs font-semibold transition",
                        params.scaleFactor === sf
                          ? "bg-brand text-ink-950 shadow-sm"
                          : "text-white/60 hover:text-white"
                      )}
                    >
                      {sf}
                    </button>
                  ))}
                </div>
              </div>

              {/* Flavor */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-white/60">Optimization Flavor</label>
                <Dropdown
                  label={
                    MAGNIFIC_PRECISION_FLAVORS.find((f) => f.id === (params.flavor || "photo"))?.label || "Photo"
                  }
                  trigger={(open) => (
                    <div className="flex h-9 w-full items-center justify-between rounded-xl border border-line bg-ink-900/70 px-3 text-xs text-white hover:bg-ink-900">
                      <span className="truncate">
                        {MAGNIFIC_PRECISION_FLAVORS.find((f) => f.id === (params.flavor || "photo"))?.label ||
                          "Photo"}
                      </span>
                      <ChevronDown className={cn("h-3.5 w-3.5 text-white/50 transition-transform", open && "rotate-180")} />
                    </div>
                  )}
                >
                  {(close) =>
                    MAGNIFIC_PRECISION_FLAVORS.map((flavor) => (
                      <MenuItem
                        key={flavor.id}
                        active={params.flavor === flavor.id}
                        onClick={() => {
                          setParam("flavor", flavor.id);
                          close();
                        }}
                      >
                        <span className="flex-1 text-xs">{flavor.label}</span>
                        {params.flavor === flavor.id && <Check className="h-3.5 w-3.5 text-brand" />}
                      </MenuItem>
                    ))
                  }
                </Dropdown>
              </div>
            </div>

            {/* Granular Sliders */}
            <div className="rounded-xl border border-line bg-ink-900/40 p-3">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
                {/* Sharpen */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-white/70">Sharpen</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                      {params.sharpen ?? 7}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={params.sharpen ?? 7}
                    onChange={(e) => setParam("sharpen", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                  />
                  <div className="flex justify-between text-[9px] text-white/30">
                    <span>0</span>
                    <span>100</span>
                  </div>
                </div>

                {/* Smart Grain */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-white/70">Smart Grain</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                      {params.smartGrain ?? 7}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={params.smartGrain ?? 7}
                    onChange={(e) => setParam("smartGrain", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                  />
                  <div className="flex justify-between text-[9px] text-white/30">
                    <span>0</span>
                    <span>100</span>
                  </div>
                </div>

                {/* Ultra Detail */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-white/70">Ultra Detail</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                      {params.ultraDetail ?? 30}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={params.ultraDetail ?? 30}
                    onChange={(e) => setParam("ultraDetail", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                  />
                  <div className="flex justify-between text-[9px] text-white/30">
                    <span>0</span>
                    <span>100</span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* PRECISION V1 CONTROLS */}
        {activeModelId === "Magnific Precision V1" && (
          <>
            <div className="flex items-start gap-2.5 rounded-xl border border-blue-500/20 bg-blue-950/30 p-3 text-xs text-blue-200/90">
              <Info className="h-4 w-4 shrink-0 text-blue-400 mt-0.5" />
              <div>
                <p className="font-semibold text-blue-100">Faithful 2x Super-Resolution</p>
                <p className="mt-0.5 text-[11px] text-blue-200/70 leading-relaxed">
                  Precision V1 doubles image resolution while maintaining 100% fidelity without hallucinating new
                  elements. Recommended for UI assets, screenshots, vector logos, and small text.
                </p>
              </div>
            </div>

            {/* Granular Sliders */}
            <div className="rounded-xl border border-line bg-ink-900/40 p-3">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
                {/* Sharpen */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-white/70">Sharpen</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                      {params.sharpen ?? 50}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={params.sharpen ?? 50}
                    onChange={(e) => setParam("sharpen", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                  />
                  <div className="flex justify-between text-[9px] text-white/30">
                    <span>0</span>
                    <span>100</span>
                  </div>
                </div>

                {/* Smart Grain */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-white/70">Smart Grain</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                      {params.smartGrain ?? 7}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={params.smartGrain ?? 7}
                    onChange={(e) => setParam("smartGrain", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                  />
                  <div className="flex justify-between text-[9px] text-white/30">
                    <span>0</span>
                    <span>100</span>
                  </div>
                </div>

                {/* Ultra Detail */}
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-white/70">Ultra Detail</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                      {params.ultraDetail ?? 30}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={params.ultraDetail ?? 30}
                    onChange={(e) => setParam("ultraDetail", Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ink-700 accent-brand"
                  />
                  <div className="flex justify-between text-[9px] text-white/30">
                    <span>0</span>
                    <span>100</span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* NSFW Filter & Submit Action */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60 hover:text-white transition">
            <input
              type="checkbox"
              checked={Boolean(params.filterNsfw)}
              onChange={(e) => setParam("filterNsfw", e.target.checked)}
              className="h-4 w-4 rounded border-line bg-ink-900 text-brand focus:ring-brand"
            />
            <ShieldCheck className="h-3.5 w-3.5 text-white/40" />
            <span>Filter NSFW content</span>
          </label>

          <button
            type="button"
            onClick={generateUpscale}
            disabled={!upscalerImage || generating || uploading}
            className={cn(
              "flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-semibold text-ink-950 shadow-md transition duration-200",
              !upscalerImage || generating || uploading
                ? "cursor-not-allowed bg-white/20 text-white/40"
                : "bg-brand hover:brightness-110 active:scale-95 shadow-brand/20"
            )}
          >
            {uploading ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                <span>Uploading source...</span>
              </>
            ) : generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-ink-950" />
                <span>Upscaling with Magnific...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 text-ink-950" />
                <span>Upscale with Magnific</span>
              </>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
