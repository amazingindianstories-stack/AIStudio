"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Film, Image as ImageIcon, Loader2, RotateCcw, Settings2, UploadCloud, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "@/lib/store";
import { notify } from "@/lib/notify";
import { isModelAvailable } from "@/lib/model-registry";
import { pickerModels } from "@/lib/config";
import { MAGNIFIC_VIDEO_DEFAULTS, MAGNIFIC_VIDEO_MAX_SECONDS } from "@/lib/magnific-ui";
import { IMAGE_UPSCALE_DEFAULT } from "@/lib/agent-composer";
import { uploadContentType, uploadFileDirect } from "@/lib/client-reference-upload";
import { cn } from "@/lib/utils";
import { Chip } from "./ComposerControls";
import { Dropdown, MenuItem } from "./Dropdown";
import {
  IMAGE_UPSCALE_MODELS,
  ImageUpscaleSettings,
  UpscaleToggle,
  VIDEO_UPSCALE_MODELS,
  VideoUpscaleSettings,
  resetImageUpscale,
  resetVideoUpscale,
} from "./UpscaleSettings";

/**
 * The Agents chat's Upscale mode: the source the upscale starts from and the upscaler's own settings, kept in the
 * same store fields as the Upscale composer (upscalerImage or upscalerVideo, upscalerParams or videoUpscalerParams),
 * so the chat sends them as its composer context (agent-composer.js) and the Upscale composer shows the same choice.
 * There is no separate Image | Video switch beside the chat's mode tabs: the source's kind (upscalerMedia) follows the
 * media the artist attaches, or the upscaler they pick from the grouped model menu.
 */

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm"];
const SOURCE_TYPES = { image: IMAGE_TYPES, video: VIDEO_TYPES };
const SOURCE_KINDS = ["image", "video"];
const MAX_BYTES = { image: 20 * 1024 * 1024, video: 2 * 1024 * 1024 * 1024 };
const RESOLUTION_LABELS = { "720p": "720p", "1k": "1K", "2k": "2K", "4k": "4K" };

/** The source kinds an upscaler is available for, image first. */
function sourceKinds(availableModelIds) {
  return SOURCE_KINDS.filter((kind) => pickerModels(availableModelIds, "upscale", kind).length > 0);
}

function kindText(kinds) {
  return kinds.length ? kinds.join(" or ") : "image";
}

function upscaleState(s) {
  const media = s.upscalerMedia === "video" ? "video" : "image";
  const params = (media === "video" ? s.videoUpscalerParams : s.upscalerParams) || {};
  return {
    media,
    params,
    model: params.model || (media === "video" ? MAGNIFIC_VIDEO_DEFAULTS.model : IMAGE_UPSCALE_DEFAULT),
    setParam: media === "video" ? s.setVideoUpscalerParam : s.setUpscalerParam,
  };
}

/**
 * The upscale source: a file the artist picks or drops (uploaded like the Upscale composer's), or a library item they
 * drop. `onError(message)` reports a rejected source, and null clears it.
 */
export function useUpscaleSource({ onError }) {
  const media = useStore((s) => (s.upscalerMedia === "video" ? "video" : "image"));
  const source = useStore((s) => (media === "video" ? s.upscalerVideo : s.upscalerImage));
  const projectId = useStore((s) => s.activeProjectId);
  const availableModelIds = useStore((s) => s.availableModelIds);
  const kinds = sourceKinds(availableModelIds);
  const [uploading, setUploading] = useState(null);
  const attemptRef = useRef(0);
  const fileRef = useRef(null);

  // A source belongs to the project it was uploaded in.
  useEffect(() => { attemptRef.current += 1; setUploading(null); }, [projectId]);

  const store = (kind, value) => {
    const state = useStore.getState();
    if (kind === "video") state.setUpscalerVideo(value);
    else state.setUpscalerImage(value);
  };
  // An attached source sets the kind, so the upscalers shown are the ones that take it.
  const attach = (kind, value) => {
    useStore.getState().setUpscalerMedia(kind);
    store(kind, value);
  };

  const selectFile = async (file) => {
    if (!file) return;
    const type = uploadContentType(file);
    const kind = kinds.find((entry) => SOURCE_TYPES[entry].includes(type));
    if (!kind) {
      onError(kinds.includes("image") && kinds.includes("video") ? "Upscaling accepts PNG, JPEG or WebP images, or MP4, MOV or WebM videos."
        : kinds.includes("video") ? "Upscaling accepts MP4, MOV or WebM videos." : "Upscaling accepts PNG, JPEG or WebP images.");
      return;
    }
    if (file.size > MAX_BYTES[kind]) {
      onError(kind === "video" ? "Source videos must be 2 GB or smaller." : "Source images must be 20 MB or smaller.");
      return;
    }
    const attempt = ++attemptRef.current;
    const project = useStore.getState().activeProjectId;
    setUploading({ name: file.name, progress: null });
    onError(null);
    try {
      const ready = await uploadFileDirect(file, `${kind}-reference`, {
        onProgress: ({ uploadedBytes, totalBytes }) => {
          if (attempt === attemptRef.current && totalBytes) {
            setUploading({ name: file.name, progress: Math.round((uploadedBytes / totalBytes) * 100) });
          }
        },
      });
      if (attempt !== attemptRef.current || useStore.getState().activeProjectId !== project) return;
      attach(kind, { url: ready.ref, name: file.name, size: file.size });
    } catch (error) {
      if (attempt === attemptRef.current) onError(error?.message || `Could not upload the source ${kind}. Please try again.`);
    } finally {
      if (attempt === attemptRef.current) setUploading(null);
    }
  };

  /** Uses the first dropped library item as the source. */
  const takeItems = (items) => {
    const first = items[0];
    if (!first) return;
    const kind = first.kind;
    const usable = kinds.includes(kind) && first.url && (kind !== "video" || first.status === "succeeded");
    if (!usable) {
      onError(kinds.includes("video") ? `Upscaling takes ${kinds.includes("image") ? "an image or " : ""}a finished video.` : "Upscaling takes an image.");
      return;
    }
    onError(null);
    attach(kind, {
      url: first.url,
      name: first.prompt ? first.prompt.slice(0, 50) : kind === "video" ? "Video generation" : "Generation reference",
      aspectRatio: first.aspectRatio,
      item: first,
    });
    if (items.length > 1) notify(`Upscaling uses one source. Selected the first of ${items.length} dropped assets.`);
  };

  const tooLong = media === "video" && Number.isFinite(source?.duration) && source.duration > MAGNIFIC_VIDEO_MAX_SECONDS;
  return {
    media,
    kinds,
    source,
    uploading,
    tooLong,
    fileRef,
    selectFile,
    takeItems,
    clear: () => store(media, null),
    pick: () => fileRef.current?.click(),
  };
}

/** The composer's source square in Upscale mode, where Image and Video show the reference square. */
export function UpscaleSourceTile({ upload, collapsed }) {
  const { media, kinds, source, uploading, tooLong, fileRef } = upload;
  const url = typeof source === "string" ? source : source?.url;
  const [failed, setFailed] = useState(null);
  const size = collapsed ? "h-[38px] w-[38px]" : "h-[58px] w-[58px]";

  return (
    <div className="relative shrink-0">
      <input
        ref={fileRef}
        type="file"
        accept={kinds.flatMap((kind) => SOURCE_TYPES[kind]).join(",")}
        hidden
        data-testid="upscale-source-input"
        onChange={(e) => { upload.selectFile(e.target.files?.[0]); e.target.value = ""; }}
      />
      {url ? (
        <>
          <button
            type="button"
            onClick={upload.pick}
            title={`${source?.name || `Source ${media}`} - choose another ${kindText(kinds)}`}
            aria-label={`Upscale source: ${source?.name || media}. Choose another ${kindText(kinds)}`}
            className={cn("block overflow-hidden rounded-xl bg-ink-950 ring-1 transition hover:ring-brand/50", size,
              tooLong ? "ring-red-400/60" : "ring-line")}
          >
            {media === "video" ? (
              failed === url ? (
                <Film className="m-auto h-4 w-4 text-white/50" />
              ) : (
                <video
                  key={url}
                  src={url}
                  muted
                  playsInline
                  preload="metadata"
                  onError={() => setFailed(url)}
                  onLoadedMetadata={(e) => {
                    const video = e.currentTarget;
                    const current = useStore.getState().upscalerVideo;
                    if (current === source && !source.duration) {
                      useStore.getState().setUpscalerVideo({ ...source, duration: video.duration, width: video.videoWidth, height: video.videoHeight });
                    }
                  }}
                  className="h-full w-full object-cover"
                />
              )
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt="" className="h-full w-full object-cover" />
            )}
          </button>
          <button
            type="button"
            onClick={upload.clear}
            aria-label={`Remove the source ${media}`}
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-650 text-white/70 ring-1 ring-line transition hover:bg-ink-600 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={upload.pick}
          disabled={Boolean(uploading)}
          aria-label={`Choose the ${kindText(kinds)} to upscale`}
          className={cn(
            "grid place-items-center rounded-xl border border-dashed border-brand/35 text-brand/80 transition-all hover:border-brand/60 hover:text-brand disabled:cursor-wait",
            size
          )}
        >
          <span className="flex flex-col items-center gap-0.5">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            <span className={cn("text-[10px] tabular-nums", collapsed && "sr-only")}>
              {uploading ? (uploading.progress == null ? "upload" : `${uploading.progress}%`) : "source"}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function settingsSummary(media, model, params) {
  if (media === "video") return RESOLUTION_LABELS[params.resolution] || params.resolution || "Settings";
  if (model === "Magnific Precision V1") return "Detail";
  return params.scaleFactor || "2x";
}

const UPSCALER_GROUPS = [
  { kind: "image", label: "Image upscalers", icon: ImageIcon, catalog: IMAGE_UPSCALE_MODELS },
  { kind: "video", label: "Video upscalers", icon: Film, catalog: VIDEO_UPSCALE_MODELS },
];

/**
 * The upscaler menu, image and video upscalers in their own groups. The chip's icon says which kind of source the
 * chosen upscaler takes; picking one of the other kind switches the source kind with it.
 */
function UpscalerPicker({ media, model }) {
  const availableModelIds = useStore((s) => s.availableModelIds);
  const groups = UPSCALER_GROUPS
    .map((group) => ({ ...group, models: group.catalog.filter((entry) => isModelAvailable(entry.id, availableModelIds)) }))
    .filter((group) => group.models.length > 0);
  const Icon = media === "video" ? Film : ImageIcon;
  const choose = (kind, name) => {
    const state = useStore.getState();
    state.setUpscalerMedia(kind);
    if (kind === "video") state.setVideoUpscalerParam("model", name);
    else state.setUpscalerParam("model", name);
  };

  return (
    <Dropdown
      className="composer-model min-w-0"
      label={`Model: ${model}`}
      side="top"
      panelClassName="w-[min(92vw,400px)] p-1.5 max-h-[60vh] overflow-y-auto scroll-thin"
      trigger={(open) => (
        <Chip open={open}>
          <Icon aria-hidden="true" className="h-4 w-4 text-white/55" />
          <span className="min-w-0 max-w-[14rem] truncate font-medium">{model}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </Chip>
      )}
    >
      {(close) => groups.map((group) => (
        <div key={group.kind} role="group" aria-label={group.label} className="py-0.5">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/35">{group.label}</p>
          {group.models.map((entry) => {
            const active = group.kind === media && entry.id === model;
            return (
              <MenuItem key={entry.id} active={active} onClick={() => { choose(group.kind, entry.id); close(); }}>
                <group.icon className="h-4 w-4 text-white/50" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{entry.id}</span>
                  {entry.desc && <span className="text-[10px] leading-snug text-white/40">{entry.desc}</span>}
                </span>
                {entry.badge && (
                  <span className="shrink-0 whitespace-nowrap rounded bg-brand/20 px-1.5 py-0.5 text-[10px] font-semibold text-brand">{entry.badge}</span>
                )}
                {active && <Check className="h-4 w-4 shrink-0 text-brand" />}
              </MenuItem>
            );
          })}
        </div>
      ))}
    </Dropdown>
  );
}

/** Upscale mode's toolbar: the upscaler (which also sets the source kind) and its settings, on one row. */
export function UpscaleToolbar() {
  const { media, params, model, setParam } = useStore(useShallow(upscaleState));
  const catalog = media === "video" ? VIDEO_UPSCALE_MODELS : IMAGE_UPSCALE_MODELS;
  const description = catalog.find((entry) => entry.id === model)?.desc;
  const reset = () => (media === "video" ? resetVideoUpscale(setParam) : resetImageUpscale(model, setParam));

  return (
    <div className="composer-toolbar composer-toolbar-single flex min-w-0 items-center gap-1.5 py-px">
      <UpscalerPicker media={media} model={model} />
      <Dropdown
        key={`upscale-settings-${media}`}
        className="composer-settings shrink-0"
        label="Upscale settings"
        align="right"
        side="top"
        panelClassName="w-[min(92vw,440px)] p-3 max-h-[70vh] overflow-y-auto scroll-thin"
        trigger={(open) => (
          <Chip open={open}>
            <Settings2 className="h-4 w-4 text-white/55" />
            <span className="composer-setting-value font-medium">{settingsSummary(media, model, params)}</span>
            {media === "video" && params.fpsBoost && model !== "Magnific Video Topaz" && (
              <>
                <span className="composer-secondary-setting text-white/35">·</span>
                <span className="composer-secondary-setting text-brand">FPS boost</span>
              </>
            )}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
          </Chip>
        )}
      >
        {() => (
          <div className="flex flex-col gap-3" data-testid="upscale-settings">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white">{model}</p>
                {description && <p className="mt-0.5 text-[11px] leading-snug text-white/45">{description}</p>}
              </div>
              <button
                type="button"
                onClick={reset}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-white/50 transition hover:bg-white/5 hover:text-white/80"
                title="Reset parameters to defaults"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </div>
            {media === "video" ? (
              <>
                <VideoUpscaleSettings model={model} params={params} setParam={setParam} />
                <UpscaleToggle media="video" model={model} params={params} setParam={setParam} />
              </>
            ) : (
              <ImageUpscaleSettings model={model} params={params} setParam={setParam} />
            )}
          </div>
        )}
      </Dropdown>
    </div>
  );
}

