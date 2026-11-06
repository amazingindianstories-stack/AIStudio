"use client";

import { useMaintenance } from "@/lib/maintenance-client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, Loader2, RotateCcw, Sparkles, UploadCloud, X } from "lucide-react";
import { notify } from "@/lib/notify";
import { useStore, findItem } from "@/lib/store";
import { MAGNIFIC_VIDEO_DEFAULTS, MAGNIFIC_VIDEO_MAX_SECONDS } from "@/lib/magnific-ui";
import { isModelAvailable } from "@/lib/model-registry";
import { cn } from "@/lib/utils";
import { formatCost } from "@/lib/format-cost";
import { uploadContentType, uploadFileDirect } from "@/lib/client-reference-upload";
import { getAssetDragData, validateUpscalerDrop } from "@/lib/asset-drag-contract";
import { UpscaleToggle, VIDEO_UPSCALE_MODELS, VideoUpscaleSettings, resetVideoUpscale } from "./UpscaleSettings";
import { UpscaleMediaToggle } from "./UpscaleMediaToggle";

const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm"];
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const MODELS = VIDEO_UPSCALE_MODELS;

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

export function VideoUpscalerComposer() {
  const maintenance = useMaintenance((s) => s.enabled);
  const s = useStore();
  const source = s.upscalerVideo;
  const setSource = s.setUpscalerVideo;
  const params = s.videoUpscalerParams;
  const setParam = s.setVideoUpscalerParam;
  const generating = s.generating;
  const model = params.model || MAGNIFIC_VIDEO_DEFAULTS.model;
  const models = MODELS.filter((m) => isModelAvailable(m.id, s.availableModelIds));

  const [dragging, setDragging] = useState(false);
  const [dragValid, setDragValid] = useState(true);
  const [dragMessage, setDragMessage] = useState("");
  const dragEnterCountRef = useRef(0);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [previewFailed, setPreviewFailed] = useState(null);
  const fileInputRef = useRef(null);
  const uploadAttemptRef = useRef(0);

  useEffect(() => { uploadAttemptRef.current += 1; setUploading(false); setLastResult(null); }, [s.activeProjectId]);

  const resultItem = lastResult ? findItem(s, lastResult.item.id) || lastResult.item : null;
  const tooLong = Number.isFinite(source?.duration) && source.duration > MAGNIFIC_VIDEO_MAX_SECONDS;

  const handleSelectFile = async (file) => {
    if (maintenance || !file) return;
    const contentType = uploadContentType(file);
    if (!VIDEO_TYPES.includes(contentType)) {
      setError("Video upscaling accepts MP4, MOV or WebM files.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Source videos must be 2 GB or smaller.");
      return;
    }
    const attempt = ++uploadAttemptRef.current;
    const projectId = s.activeProjectId;
    setUploading(true);
    setProgress(0);
    setError("");
    try {
      const ready = await uploadFileDirect(file, "video-reference", {
        onProgress: ({ uploadedBytes, totalBytes }) => {
          if (attempt === uploadAttemptRef.current && totalBytes) setProgress(Math.round((uploadedBytes / totalBytes) * 100));
        },
      });
      if (attempt !== uploadAttemptRef.current || useStore.getState().activeProjectId !== projectId) return;
      setSource({ url: ready.ref, name: file.name, size: file.size });
    } catch (uploadError) {
      if (attempt === uploadAttemptRef.current) setError(uploadError?.message || "Could not upload the source video. Please try again.");
    } finally {
      if (attempt === uploadAttemptRef.current) setUploading(false);
    }
  };

  const onDragEnter = (e) => {
    dragEnterCountRef.current += 1;
    if (dragEnterCountRef.current === 1) setDragging(true);
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
  const onDragLeave = () => {
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
    setDragValid(true);
    setDragMessage("");
    const val = validateUpscalerDrop(e, s);
    if (!val.valid) {
      setError(val.reason || "Video upscaling only accepts videos.");
      return;
    }
    const payload = getAssetDragData(e, s);
    let items = [];
    if (payload.items?.length) items = [...payload.items];
    else if (payload.ids?.length) items = payload.ids.map((id) => findItem(s, id)).filter(Boolean);
    else if (s.draggedItem) items = [s.draggedItem];
    if (items.length > 0) {
      const first = items[0];
      if (first.kind !== "video" || first.status !== "succeeded" || !first.url) {
        notify("Video upscaling only accepts finished video generations.");
        return;
      }
      setError("");
      setSource({ url: first.url, name: first.prompt ? first.prompt.slice(0, 50) : "Video generation", aspectRatio: first.aspectRatio, item: first });
      if (items.length > 1) notify(`Video upscaling uses one source. Selected the first of ${items.length} dropped assets.`);
      return;
    }
    const file = e.dataTransfer?.files?.[0];
    if (file) handleSelectFile(file);
  };

  const resetParams = () => resetVideoUpscale(setParam);

  const submit = async () => {
    setError("");
    const projectId = s.activeProjectId;
    const original = source;
    const item = await s.generateVideoUpscale();
    if (useStore.getState().activeProjectId !== projectId) return;
    if (item?.id) setLastResult({ source: original, item });
    else setError("Could not start the video upscale. Check the source and retry.");
  };

  const disabled = maintenance || !source || generating || uploading || tooLong;

  return (
    <motion.div
      layout="size"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-line bg-ink-800/95 p-3.5 shadow-panel backdrop-blur-xl sm:p-5"
    >
      <input
        ref={fileInputRef}
        disabled={maintenance}
        type="file"
        accept="video/mp4,video/quicktime,video/x-m4v,video/webm"
        className="hidden"
        onChange={(e) => { handleSelectFile(e.target.files?.[0]); e.target.value = ""; }}
      />

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
              const active = model === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setParam("model", m.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                    active ? "bg-brand/20 text-brand shadow-sm ring-1 ring-brand/40" : "text-white/60 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Sparkles className={cn("h-3.5 w-3.5", active ? "text-brand" : "text-white/40")} />
                  <span>{m.label}</span>
                  <span className={cn("hidden rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider sm:inline-block",
                    active ? "bg-brand/30 text-white font-semibold" : "bg-white/10 text-white/40")}>
                    {m.badge}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-2 text-xs text-white/50">{MODELS.find((m) => m.id === model)?.desc}</p>
      </div>

      <div className="mb-4" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {source ? (
          <div className="relative flex items-center gap-4 rounded-xl border border-line bg-ink-900/60 p-3 shadow-inner">
            <div className="relative h-36 w-36 shrink-0 overflow-hidden rounded-lg bg-ink-950 ring-1 ring-line">
              {previewFailed === source.url && (
                <p className="absolute inset-0 grid place-items-center p-3 text-center text-[11px] leading-snug text-white/50">
                  Preview unavailable in this browser. The original is upscaled as is.
                </p>
              )}
              <video
                key={source.url}
                src={source.url}
                onError={() => setPreviewFailed(source.url)}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  const video = e.currentTarget;
                  if (!source.duration && useStore.getState().upscalerVideo === source) {
                    setSource({ ...source, duration: video.duration, width: video.videoWidth, height: video.videoHeight });
                  }
                }}
                className="h-full w-full object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">Source Video</span>
                {source.aspectRatio && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">{source.aspectRatio}</span>}
              </div>
              <p className="mt-0.5 truncate text-xs text-white/60">{source.name || "Video ready to upscale"}</p>
              <p className="mt-1 text-[11px] text-white/40">
                {source.width && source.height ? `${source.width} × ${source.height} · ` : ""}
                {source.duration ? `${formatSeconds(source.duration)} · ` : ""}Drag here to replace
              </p>
              {tooLong && (
                <p role="alert" className="mt-1 text-[11px] text-red-300">Videos longer than {MAGNIFIC_VIDEO_MAX_SECONDS} seconds cannot be upscaled.</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={maintenance}
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition"
                >
                  Replace video
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSource(null)}
              className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white transition"
              title="Remove video"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div
            aria-disabled={maintenance}
            onClick={() => !maintenance && !uploading && fileInputRef.current?.click()}
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
                {uploading ? <Loader2 className="h-5 w-5 animate-spin text-brand" /> : <UploadCloud className="h-5 w-5 text-brand" />}
              </div>
            )}
            <div>
              <p className={cn("text-xs font-semibold", dragging && !dragValid ? "text-red-300" : "text-white")}>
                {uploading
                  ? `Uploading source video… ${progress}%`
                  : dragging
                    ? dragMessage || (dragValid ? "Drop video here to upscale" : "Video upscaling only accepts videos")
                    : (<>Drop a video here or <span className="text-brand underline underline-offset-2">browse</span></>)}
              </p>
              <p className={cn("mt-1 text-[11px]", dragging && !dragValid ? "text-red-400/80" : "text-white/40")}>
                Or drag a finished video from the chat feed or library · MP4, MOV, WebM · up to {MAGNIFIC_VIDEO_MAX_SECONDS} s
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <VideoUpscaleSettings model={model} params={params} setParam={setParam} />

        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        {lastResult && (
          <div className="rounded-xl border border-line p-3">
            <p className="text-xs text-white/60">
              Original and output · Job {lastResult.item.id}
              {Number.isFinite(lastResult.item.costCents) ? ` · ≈${formatCost(lastResult.item.costCents)}` : ""}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <video src={lastResult.source.url} muted playsInline preload="metadata" className="h-32 w-full object-contain" />
              {resultItem?.url && resultItem.status === "succeeded"
                ? previewFailed === resultItem.url
                  ? <p className="grid h-32 place-items-center text-center text-xs text-white/50">Preview unavailable in this browser. Download the original from the library.</p>
                  : <video key={resultItem.url} src={resultItem.url} controls playsInline preload="metadata" onError={() => setPreviewFailed(resultItem.url)} className="h-32 w-full object-contain" />
                : <p className="text-xs text-white/50">{resultItem?.status || "Queued"} · Video upscales take several minutes; the output appears in the library when complete</p>}
            </div>
          </div>
        )}

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-ink-800 py-3">
          <UpscaleToggle media="video" model={model} params={params} setParam={setParam} />
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            className={cn(
              "flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-semibold text-ink-950 shadow-md transition duration-200",
              disabled ? "cursor-not-allowed bg-white/20 text-white/40" : "bg-brand hover:brightness-110 active:scale-95 shadow-brand/20"
            )}
          >
            {uploading ? (
              <><Loader2 size={15} className="animate-spin" /><span>Uploading source…</span></>
            ) : generating ? (
              <><Loader2 className="h-4 w-4 animate-spin text-ink-950" /><span>Starting Magnific…</span></>
            ) : (
              <><Sparkles className="h-4 w-4 text-ink-950" /><span>Upscale video with Magnific</span></>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
