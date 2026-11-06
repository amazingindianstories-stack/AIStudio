"use client";
import { useMaintenance } from "@/lib/maintenance-client";

import { useRef, useState, useEffect } from "react";
import { notify } from "@/lib/notify";
import { motion } from "framer-motion";
import {
  Sparkles,
  UploadCloud,
  X,
  RotateCcw,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useStore, findItem } from "@/lib/store";
import { isModelAvailable } from "@/lib/model-registry";
import { cn } from "@/lib/utils";
import { uploadContentType, uploadFileDirect } from "@/lib/client-reference-upload";
import { getAssetDragData, validateUpscalerDrop } from "@/lib/asset-drag-contract";
import { ProgressiveImage } from "./ProgressiveImage";
import { IMAGE_UPSCALE_MODELS, ImageUpscaleSettings, UpscaleToggle, resetImageUpscale } from "./UpscaleSettings";
import { UpscaleMediaToggle } from "./UpscaleMediaToggle";
import { VideoUpscalerComposer } from "./VideoUpscalerComposer";

const MODELS = IMAGE_UPSCALE_MODELS;

export function UpscalerComposer() {
  const maintenance = useMaintenance((s) => s.enabled);
  const s = useStore();
  const upscalerImage = s.upscalerImage;
  const setUpscalerImage = s.setUpscalerImage;
  const params = s.upscalerParams;
  const setParam = s.setUpscalerParam;
  const generateUpscale = s.generateUpscale;
  const generating = s.generating;

  const [dragging, setDragging] = useState(false);
  const [dragValid, setDragValid] = useState(true);
  const [dragMessage, setDragMessage] = useState("");
  const dragEnterCountRef = useRef(0);
  const [uploadError, setUploadError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const uploadAttemptRef = useRef(0);

  useEffect(() => { uploadAttemptRef.current += 1; setUploading(false); setLastResult(null); }, [s.activeProjectId]);

  const resultItem = lastResult ? findItem(s, lastResult.item.id) || lastResult.item : null;
  const activeModelId = params.model || "Magnific Creative";
  const models = MODELS.filter((m) => isModelAvailable(m.id, s.availableModelIds));
  // After every hook above, so hook order is identical across the switch.
  if (s.upscalerMedia === "video") return <VideoUpscalerComposer />;

  const handleSelectFile = async (file) => {
    if (maintenance || !file) return;
    const contentType = uploadContentType(file);
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      setUploadError("Magnific accepts PNG, JPEG or WebP images. Video upscaling is unsupported.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setUploadError("Source images must be 20 MB or smaller.");
      return;
    }
    const attempt = ++uploadAttemptRef.current;
    const projectId = s.activeProjectId;
    setUploading(true);
    setUploadError("");
    try {
      const ready = await uploadFileDirect(file, "image-reference");
      if (attempt !== uploadAttemptRef.current || useStore.getState().activeProjectId !== projectId) return;
      const url = ready.ref;
      setUpscalerImage({
        url,
        name: file.name,
        size: file.size,
      });
    } catch (error) {
      if (attempt === uploadAttemptRef.current) setUploadError(error?.message || "Could not upload the source image. Please try again.");
    } finally {
      if (attempt === uploadAttemptRef.current) setUploading(false);
    }
  };

  const onDragEnter = (e) => {
    dragEnterCountRef.current += 1;
    if (dragEnterCountRef.current === 1) {
      setDragging(true);
    }
    const val = validateUpscalerDrop(e, s);
    setDragValid(val.valid);
    setDragMessage(val.reason || "");
  };

  const onDragOver = (e) => {
    e.preventDefault();
    const val = validateUpscalerDrop(e, s);
    setDragValid(val.valid);
    setDragMessage(val.reason || "");
    e.dataTransfer.dropEffect = val.valid ? "copy" : "none";
    if (!dragging) setDragging(true);
  };

  const onDragLeave = (_e) => {
    dragEnterCountRef.current = Math.max(0, dragEnterCountRef.current - 1);
    if (dragEnterCountRef.current === 0) {
      setDragging(false);
      setDragValid(true);
      setDragMessage("");
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragEnterCountRef.current = 0;
    setDragging(false);
    const val = validateUpscalerDrop(e, s);
    if (!val.valid) {
      setUploadError(val.reason || "Magnific accepts images. Video upscaling is unsupported.");
      setDragValid(true);
      setDragMessage("");
      return;
    }
    setDragValid(true);
    setDragMessage("");

    // Check for internal generation drag (from chat or library)
    const assetPayload = getAssetDragData(e, s);
    let itemsToProcess = [];
    if (assetPayload.items && assetPayload.items.length > 0) {
      itemsToProcess = [...assetPayload.items];
    } else if (assetPayload.ids && assetPayload.ids.length > 0) {
      itemsToProcess = assetPayload.ids
        .map((id) => findItem(s, id))
        .filter(Boolean);
    } else if (s.draggedItem) {
      itemsToProcess = [s.draggedItem];
    }

    if (itemsToProcess.length > 0) {
      const firstItem = itemsToProcess[0];
      if (firstItem.kind !== "image") {
        notify("Upscaler only accepts image generations.");
        return;
      }
      setUpscalerImage({
        url: firstItem.url,
        name: firstItem.prompt ? firstItem.prompt.slice(0, 50) : "Generation reference",
        aspectRatio: firstItem.aspectRatio,
        item: firstItem,
      });
      if (itemsToProcess.length > 1) {
        notify(`Upscaler only accepts 1 source image. Selected the first of ${itemsToProcess.length} dropped assets.`);
      }
      return;
    }

    // Check for dropped file
    const file = e.dataTransfer?.files?.[0];
    if (file) handleSelectFile(file);
  };

  const resetParams = () => resetImageUpscale(activeModelId, setParam);

  return (
    <motion.div
      layout="size"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-line bg-ink-800/95 p-3.5 shadow-panel backdrop-blur-xl sm:p-5"
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        disabled={maintenance}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => { handleSelectFile(e.target.files?.[0]); e.target.value = ""; }}
      />

      {/* Model selection tabs */}
      <div className="mb-4">
        <div className="border-b border-line pb-3">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <UpscaleMediaToggle />
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
          <div className="flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-xl bg-ink-900/80 p-1 ring-1 ring-line">
            {models.map((m) => {
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
        </div>

        {/* Model description banner */}
        <p className="mt-2 text-xs text-white/50">
          {MODELS.find((m) => m.id === activeModelId)?.desc}
        </p>
      </div>

      {/* Image Input Section */}
      <div className="mb-4" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {upscalerImage ? (
          <div className="relative flex items-center gap-4 rounded-xl border border-line bg-ink-900/60 p-3 shadow-inner">
            <div className="relative h-36 w-36 shrink-0 overflow-hidden rounded-lg bg-ink-950 ring-1 ring-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={typeof upscalerImage === "string" ? upscalerImage : upscalerImage.url}
                alt="Source preview"
                onLoad={(e) => {
                  if (typeof upscalerImage !== "string" && !upscalerImage.width && useStore.getState().upscalerImage === upscalerImage) {
                    setUpscalerImage({ ...upscalerImage, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
                  }
                }}
                className="h-full w-full object-contain"
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
              <p className="mt-1 text-[11px] text-white/40">{upscalerImage.width && upscalerImage.height ? `${upscalerImage.width} × ${upscalerImage.height} · ` : ""}Drag here to replace</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={maintenance}
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
            aria-disabled={maintenance}
            onClick={() => !maintenance && fileInputRef.current?.click()}
            className={cn(
              "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all duration-200",
              dragging
                ? dragValid
                  ? "border-brand bg-brand/10 text-brand ring-1 ring-brand/40"
                  : "border-red-500/80 bg-red-500/10 text-red-400 ring-1 ring-red-500/40 cursor-not-allowed"
                : "border-line bg-ink-900/40 text-white/60 hover:border-brand/60 hover:bg-ink-900/80 hover:text-white"
            )}
          >
            {dragging && !dragValid ? (
              <div className="grid h-10 w-10 place-items-center rounded-full bg-red-500/15 ring-1 ring-red-500/40">
                <AlertCircle className="h-5 w-5 text-red-400" />
              </div>
            ) : (
              <div className="grid h-10 w-10 place-items-center rounded-full bg-white/5 ring-1 ring-line group-hover:bg-brand/20 group-hover:ring-brand/40">
                <UploadCloud className="h-5 w-5 text-brand" />
              </div>
            )}
            <div>
              <p
                className={cn(
                  "text-xs font-semibold",
                  dragging && !dragValid ? "text-red-300" : "text-white"
                )}
              >
                {dragging
                  ? dragValid
                    ? dragMessage || "Drop image here to upscale"
                    : dragMessage || "Upscaler only accepts images"
                  : (
                    <>
                      Drop an image here or{" "}
                      <span className="text-brand underline underline-offset-2">browse</span>
                    </>
                  )}
              </p>
              <p
                className={cn(
                  "mt-1 text-[11px]",
                  dragging && !dragValid ? "text-red-400/80" : "text-white/40"
                )}
              >
                {dragging && !dragValid
                  ? "Videos and depth maps cannot be upscaled. Select an image generation."
                  : "Or drag any generation directly from the chat feed or library · PNG, JPEG, WebP"}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Model-specific controls */}
      <div className="space-y-4">
        <ImageUpscaleSettings model={activeModelId} params={params} setParam={setParam} />

        {uploadError && <p role="alert" className="text-xs text-red-300">{uploadError}</p>}
        {lastResult && <div className="rounded-xl border border-line p-3"><p className="text-xs text-white/60">Original and output · Job {lastResult.item.id}</p><div className="mt-2 grid grid-cols-2 gap-3"><ProgressiveImage alt="Original upscale source" src={typeof lastResult.source === "string" ? lastResult.source : lastResult.source.url} className="h-32 w-full object-contain" />{resultItem.url ? <ProgressiveImage alt="Magnific output" src={resultItem.url} className="h-32 w-full object-contain" /> : <p className="text-xs text-white/50">{resultItem.status || "Queued"} · Output appears in the library when complete</p>}</div></div>}
        {/* NSFW Filter & Submit Action */}
        <p className="text-[11px] text-white/40">Cost estimate unavailable.</p>
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-ink-800 py-3">
          <UpscaleToggle media="image" model={activeModelId} params={params} setParam={setParam} />

          <button
            type="button"
            onClick={async () => { setUploadError(""); const source = upscalerImage; const projectId = s.activeProjectId; const item = await generateUpscale(); if (useStore.getState().activeProjectId !== projectId) return; if (item?.id) setLastResult({ source, item }); else setUploadError("Could not start the upscale. Check the source and retry."); }}
            disabled={maintenance || !upscalerImage || generating || uploading}
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
