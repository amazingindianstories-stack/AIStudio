"use client";
import { uploadFileDirect, uploadOriginalReference, uploadContentType } from "@/lib/client-reference-upload";
import { notify } from "@/lib/notify";
import { useDirectMediaUrl } from "@/lib/media-resolver";

import {
  useEffect,
  useRef,
  useState,
  useMemo,

} from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Plus,
  Image as ImageIcon,
  ImagePlus,
  AlertCircle,
  Clapperboard,
  MessageSquare,
  UserRound,
  AudioLines,
  Settings2,
  ArrowUp,
  ChevronDown,
  Check,
  Loader2,
  Upload,
  BookOpen,
  Images,
  X,
  Box,
  FolderClosed,
  Layers,
  Inbox,
  Sparkles,
  Volume2,
  SkipForward,
  ArrowRight,
  GripVertical,
  ArrowLeft,
  Undo2,
} from "lucide-react";
import { useStore, restoreComposerDraft, findItem } from "@/lib/store";
import { UNSORTED } from "@/lib/feed-scope";
import { validateGenerationReference } from "@/lib/generation-reference-drag";
import { getAssetDragData, isAssetDragEvent } from "@/lib/asset-drag-contract";
import { parseMentionIndices, normalizePromptMentions } from "@/lib/mentions";
import { limitDefinition } from "@/lib/limits";
import { extractFrame } from "@/lib/video-frame";
import { VideoRefPicker } from "./VideoRefPicker";
import { DepthComposer } from "./DepthComposer";
import { UpscalerComposer } from "./UpscalerComposer";
import { Dropdown, MenuItem } from "./Dropdown";
import { MentionTextarea, } from "./MentionTextarea";
import {

  MODELS,
  MODES,
  aspectRatiosForModel,
  durationsForModel,
  durationRangeForModel,
  maxReferenceVideosForVideoModel,
  maxReferenceImagesForVideoModel,
  resolutionsForModel,
  supportsAudio,
  supportsDraftMode,
  supportsBitrateMode,
  supportsFirstFrameContinuation,
  supportsFirstLastFrame,
  supportsVideoReference,
  supportsVideoEditExtend,
  VIDEO_TASK_MODES,
  MAX_REFERENCE_VIDEOS,
} from "@/lib/config";
import { formatAudioSeconds, measureAudioDuration, referenceAudioProblem } from "@/lib/audio-duration";
import { cn, referenceDisplayUrl, thumbUrl } from "@/lib/utils";
import { isProviderModel } from "@/lib/model-registry";

import {
  downscaleBlob,
} from "@/lib/client-image-budget";
import { askText } from "@/lib/ask-text";

const MODE_ICONS = {
  Image: ImageIcon,
  Clapperboard,
  MessageSquare,
  UserRound,
  AudioLines,
  Layers,
};

export function PromptComposer() {
  const s = useStore();
  // s.limits is populated async on load (store.ts's loadLimits) and starts
  // empty — fall back to the registry's own default so there's no window
  // where every prompt looks "too long" before that fetch resolves.
  const maxPromptLength =
    s.limits.maxPromptLength ?? limitDefinition("maxPromptLength").defaultValue;
  /**
   * Whether an audio track is even a thing for the current selection. Used by
   * BOTH the collapsed chip's speaker icon and the panel's Audio segment — they
   * were separate conditions, and the chip's checked only `generateAudio`. Once
   * audio started defaulting to ON that put a speaker icon on image
   * generations, which have no audio at all. One const so they cannot drift
   * apart again.
   */
  const audioApplies = s.mode === "video" && supportsAudio(s.model);
  const draftApplies = s.mode === "video" && supportsDraftMode(s.model);
  const bitrateApplies = s.mode === "video" && supportsBitrateMode(s.model);
  const audioProblem = s.mode === "video" ? referenceAudioProblem(s.model, s.audioNotes) : null;
  // Edit/Extend only exist on Seedance 2.5 (config.supportsVideoEditExtend).
  // Both require BytePlus's ratio:"adaptive" and Edit also forces duration to
  // "match the source" — see the videoTaskMode branches on the Aspect
  // ratio/Duration segments below.
  const editExtendApplies = s.mode === "video" && supportsVideoEditExtend(s.model);
  const firstLastFrameApplies = s.mode === "video" && supportsFirstLastFrame(s.model);
  const videoTaskMode = editExtendApplies ? s.videoTaskMode : "generate";
  // Seedance 2.0/2.5 take any integer duration within a bounded range rather
  // than a fixed enum (see durationRangeForModel) — non-null here switches
  // the Duration control below from Segment buttons to a slider.
  const durationRange = s.mode === "video" ? durationRangeForModel(s.model) : null;
  const fileRef = useRef(null);
  const firstFrameFileRef = useRef(null);
  const lastFrameFileRef = useRef(null);
  const mentionRef = useRef(null);
  const toolbarMeasureRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const uploading = pendingUploads > 0;
  const [extractingFrames, setExtractingFrames] = useState(0);
  const [pickingClips, setPickingClips] = useState(false);
  const [preferredWidth, setPreferredWidth] = useState(768);
  const [dragNotice, setDragNotice] = useState(null);
  const dragNoticeTimerRef = useRef(null);

  const showDragNotice = (type, message) => {
    if (dragNoticeTimerRef.current) clearTimeout(dragNoticeTimerRef.current);
    setDragNotice({ type, message });
    dragNoticeTimerRef.current = setTimeout(() => {
      setDragNotice(null);
      dragNoticeTimerRef.current = null;
    }, 4500);
  };

  useEffect(() => {
    return () => {
      if (dragNoticeTimerRef.current) clearTimeout(dragNoticeTimerRef.current);
    };
  }, []);

  const handleFrameUpload = async (file, target) => {
    if (!file) return;
    try {
      let dataUrl;
      if (uploadContentType(file).startsWith("video/")) {
        const extracted = await extractFrame(file);
        dataUrl = extracted.dataUrl;
      } else if (uploadContentType(file).startsWith("image/")) {
        dataUrl = await downscaleBlob(file, 2048, 0.85);
      } else {
        notify("Please select an image or video file.");
        return;
      }
      if (target === "first") {
        s.setFirstFrame(dataUrl);
      } else if (target === "last") {
        s.setLastFrame(dataUrl);
      }
    } catch (e) {
      console.error(`Failed to process ${target} frame:`, e);
      notify(e?.message || `Failed to process ${file.name}`);
    }
  };

  // Bring back the locally cached draft (prompt + reference images) after a
  // refresh. Runs after mount so SSR markup stays consistent.
  useEffect(() => {
    restoreComposerDraft();
  }, []);

  useEffect(() => {
    const toolbar = toolbarMeasureRef.current;
    if (!toolbar) return;

    const syncWidth = () => {
      const controls = Array.from(
        toolbar.querySelectorAll(".control-chip")
      );
      const controlsWidth = controls.reduce((width, control) => {
        const style = window.getComputedStyle(control);
        const children = Array.from(control.children).filter(
          (child) => window.getComputedStyle(child).display !== "none"
        ) ;
        const contentWidth = children.reduce((sum, child) => {
          const renderedWidth = child.getBoundingClientRect().width;
          const cappedLabel = child.matches(
            ".composer-model-label, .composer-project-label, .composer-folder-label"
          );
          return sum + (cappedLabel ? renderedWidth : Math.max(child.scrollWidth, renderedWidth));
        }, 0);
        const gap = Number.parseFloat(style.columnGap) || 0;
        const padding =
          (Number.parseFloat(style.paddingLeft) || 0) +
          (Number.parseFloat(style.paddingRight) || 0);
        return width + contentWidth + gap * Math.max(0, children.length - 1) + padding;
      }, 0);
      const toolbarWidth = Math.ceil(
        controlsWidth + Math.max(0, controls.length - 1) * 6
      );
      setPreferredWidth(Math.min(1120, Math.max(768, toolbarWidth + 72)));
    };
    syncWidth();

    const resizeObserver = new ResizeObserver(syncWidth);
    resizeObserver.observe(toolbar);
    const mutationObserver = new MutationObserver(syncWidth);
    mutationObserver.observe(toolbar, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  const modeModels = MODELS.filter((m) => m.kind === s.mode);
  const activeMode = MODES.find((m) => m.id === s.mode);

  // Staging capacity is independent of active-provider submission limits.
  const prepareImageFiles = async (files) => {
    for (const file of files) {
      if (stagedReferenceCount(useStore.getState()) >= 50) {
        showDragNotice("error", "The draft can stage fifty attachments. Remove an attachment before adding more.");
        break;
      }
      const type = uploadContentType(file);
      try {
        if (type.startsWith("audio/")) {
          const [uploaded, duration] = await Promise.all([uploadFileDirect(file, "audio-reference"), measureAudioDuration(file)]);
          s.addAudioNote({ name: file.name, ref: uploaded.ref, ...(duration ? { duration } : {}) });
        } else if (type.startsWith("video/") && s.mode === "video" && supportsVideoReference(s.model)) {
          const uploaded = await uploadFileDirect(file, "video-reference");
          s.addReferenceVideo(uploaded.ref, file.name);
        } else if (type.startsWith("video/")) {
          setExtractingFrames((count) => count + 1);
          try {
            const { dataUrl } = await extractFrame(file);
            const blob = await (await fetch(dataUrl)).blob();
            s.addReference(await uploadOriginalReference(new File([blob], `${file.name}.jpg`, { type: blob.type })), "video", file.name);
          } finally { setExtractingFrames((count) => count - 1); }
        } else if (type.startsWith("image/")) {
          s.addReference(await uploadOriginalReference(file), "image", file.name);
        } else { showDragNotice("error", `Unsupported attachment: ${file.name}`); }
      } catch (error) { showDragNotice("error", error.message || `Could not attach ${file.name}. Please retry.`); }
    }
  };

  // Track whole batches through every async path, including failures and early
  // returns. A counter keeps overlapping drops from hiding an active upload.
  const addImageFiles = async (files) => {
    const supported = files.filter((file) => /^(image|video|audio)\//.test(uploadContentType(file)));
    if (supported.length !== files.length) showDragNotice("error", "Some dropped files have an unsupported format.");
    if (!supported.length) return;
    setPendingUploads((count) => count + 1);
    try {
      await prepareImageFiles(supported);
    } catch (error) {
      notify(error?.message || "Could not prepare the attachments. Please try again.");
    } finally {
      setPendingUploads((count) => count - 1);
    }
  };

  const onFiles = (e) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  // Paste images from the clipboard (Cmd/Ctrl+V) — only intercept when the
  // clipboard actually carries images, so normal text paste is unaffected.
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      uploadContentType(f).startsWith("image/")
    );
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  const dragEnterCountRef = useRef(0);

  // Drag & drop image files from the OS file manager or generations from library/chat.
  const isFileDrag = (e) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const isAssetDrag = (e) => {
    return (
      isAssetDragEvent(e) ||
      Boolean(s.draggedItem) ||
      Boolean(s.draggedAssets?.length)
    );
  };

  const onDragEnter = (e) => {
    const isFiles = isFileDrag(e);
    const isAsset = isAssetDrag(e);
    if (!isFiles && !isAsset) return;
    dragEnterCountRef.current += 1;
    if (dragEnterCountRef.current === 1) {
      setDragging(true);
    }
  };

  const onDragOver = (e) => {
    const isFiles = isFileDrag(e);
    const isAsset = isAssetDrag(e);
    if (!isFiles && !isAsset) return;
    e.preventDefault();

    let valid = true;
    if (isAsset) {
      const primaryItem = s.draggedItem || (s.draggedAssets && s.draggedAssets[0]);
      if (primaryItem) {
        const val = validateGenerationReference(primaryItem, {
          mode: s.mode,
          model: s.model,
          referenceImages: s.referenceImages,
          referenceVideos: s.referenceVideos,
        });
        valid = val.valid;
      }
    }
    e.dataTransfer.dropEffect = valid ? "copy" : "none";
    if (!dragging) setDragging(true);
  };

  const onDragLeave = (_e) => {
    dragEnterCountRef.current = Math.max(0, dragEnterCountRef.current - 1);
    if (dragEnterCountRef.current === 0) {
      setDragging(false);
    }
  };

  const onDrop = async (e) => {
    dragEnterCountRef.current = 0;
    setDragging(false);
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
      e.preventDefault();
      let addedImagesCount = 0;
      let addedVideosCount = 0;
      let skippedCount = 0;
      let lastErrorMessage = null;

      let currentRefImages = [...s.referenceImages];
      let currentRefVideos = [...s.referenceVideos];

      for (const item of itemsToProcess) {
        if (stagedReferenceCount(useStore.getState()) >= 50) { skippedCount += 1; lastErrorMessage = "The draft can stage fifty attachments. Remove one before adding more."; continue; }
        const validation = validateGenerationReference(item, {
          mode: s.mode,
          model: s.model,
          referenceImages: currentRefImages,
          referenceVideos: currentRefVideos,
        });

        if (!validation.valid) {
          skippedCount++;
          lastErrorMessage = validation.reason;
          continue;
        }

        if (validation.action === "add-image-ref") {
          currentRefImages.push(item.url);
          addedImagesCount++;
          await s.addReferenceFromUrl(item.url);
        } else if (validation.action === "add-video-ref") {
          currentRefVideos.push(item.url);
          addedVideosCount++;
          s.addReferenceVideo(item.url, item.prompt || "Video reference");
        }
      }

      if (addedImagesCount === 0 && addedVideosCount === 0) {
        showDragNotice("error", lastErrorMessage || "Cannot add reference.");
      } else if (skippedCount > 0) {
        const addedTotal = addedImagesCount + addedVideosCount;
        showDragNotice(
          "success",
          `Added ${addedTotal} reference${addedTotal > 1 ? "s" : ""}. ${skippedCount} skipped: ${lastErrorMessage}`
        );
      } else {
        const total = addedImagesCount + addedVideosCount;
        showDragNotice(
          "success",
          total === 1
            ? (addedVideosCount === 1 ? `Added reference clip for ${s.model}.` : `Added reference image for ${s.model}.`)
            : `Added ${total} references for ${s.model}.`
        );
      }
      return;
    }

    if (!isFileDrag(e)) return;
    e.preventDefault();
    addImageFiles(Array.from(e.dataTransfer.files));
  };

  // Depth mode is a different shape entirely (a video upload, not a prompt +
  // @tags), so it's a separate component rather than another branch woven
  // through the JSX below — after every hook above, never before, so hook
  // call order stays identical across a mode switch (rules of hooks).
  if (s.mode === "depth") {
    return <DepthComposer />;
  }
  if (s.mode === "upscale") {
    return <UpscalerComposer />;
  }

  return (
    <motion.div
      layout="size"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      style={{ width: `min(100%, ${preferredWidth}px)` }}
      onPaste={onPaste}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="composer-shell relative mx-auto max-w-full rounded-2xl border border-line bg-ink-800/90 p-2.5 shadow-panel backdrop-blur-xl"
    >
      {/* drop overlay */}
      {dragging && (() => {
        const primaryItem = s.draggedItem || (s.draggedAssets && s.draggedAssets[0]);
        const dragCount = s.draggedAssets?.length || (primaryItem ? 1 : 0);
        const dragValidation = primaryItem
          ? validateGenerationReference(primaryItem, {
              mode: s.mode,
              model: s.model,
              referenceImages: s.referenceImages,
              referenceVideos: s.referenceVideos,
            })
          : null;

        if (dragValidation) {
          return (
            <div
              className={cn(
                "pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed p-4 text-center backdrop-blur-md shadow-panel transition-colors duration-200",
                dragValidation.valid
                  ? "border-brand/70 bg-ink-900/90 text-brand"
                  : "border-amber-500/70 bg-amber-950/85 text-amber-300"
              )}
            >
              {dragValidation.valid ? (
                dragValidation.action === "add-video-ref" ? (
                  <Clapperboard className="h-7 w-7 text-brand" />
                ) : (
                  <ImagePlus className="h-7 w-7 text-brand" />
                )
              ) : (
                <AlertCircle className="h-7 w-7 text-amber-400" />
              )}
              <p className="text-sm font-semibold text-white/95">
                {dragValidation.valid
                  ? dragCount > 1
                    ? `Drop to use ${dragCount} references for ${s.model}`
                    : `Drop to use as ${dragValidation.action === "add-video-ref" ? "video" : "image"} reference for ${s.model}`
                  : "Cannot add reference"}
              </p>
              {!dragValidation.valid && (
                <p className="max-w-md text-xs leading-relaxed text-amber-200/90">
                  {dragValidation.reason}
                </p>
              )}
              {dragValidation.valid && primaryItem?.prompt && (
                <p className="max-w-md truncate text-xs text-white/60">
                  &ldquo;{primaryItem.prompt}&rdquo;
                </p>
              )}
            </div>
          );
        }

        return (
          <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-brand/60 bg-ink-900/85 backdrop-blur-sm">
            <Upload className="h-6 w-6 text-brand" />
            <p className="text-sm font-medium text-white/90">
              Drop images, video or audio to add as references
            </p>
          </div>
        );
      })()}

      {/* drag feedback banner */}
      <AnimatePresence>
        {dragNotice && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            className={cn(
              "mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-medium shadow-lg backdrop-blur-md",
              dragNotice.type === "error"
                ? "border border-amber-500/40 bg-amber-950/90 text-amber-200"
                : "border border-brand/40 bg-brand/15 text-brand"
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              {dragNotice.type === "error" ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
              ) : (
                <Check className="h-4 w-4 shrink-0 text-brand" />
              )}
              <span className="truncate">{dragNotice.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setDragNotice(null)}
              className="rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
              title="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {pickingClips && <VideoRefPicker onClose={() => setPickingClips(false)} />}

      <div role="status" aria-live="polite" aria-atomic="true">
        {uploading && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-brand/10 px-3 py-2 text-xs text-white/80">
            <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-brand" />
            <span>Uploading and preparing attachments… Generate will be available when they’re ready.</span>
          </div>
        )}
      </div>

      {extractingFrames > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-ink-750 px-3 py-2 text-xs text-white/70">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
          Reading a frame from {extractingFrames}{" "}
          {extractingFrames === 1 ? "video" : "videos"}…
        </div>
      )}

      {/* attached reference clips (video-to-video) */}
      {s.referenceVideos.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {s.referenceVideos.map((ref, i) => {
            const noteName = s.videoNotes?.[i]?.name;
            return (
              <span
                key={ref + i}
                className="flex items-center gap-1.5 rounded-lg bg-ink-750 py-1 pl-2 pr-1 text-xs text-white/75 ring-1 ring-line transition hover:ring-brand/40"
                title={`Reference clip ${i + 1}${noteName ? ` (${noteName})` : ""} — use @vid${i + 1} for motion or camera reference`}
              >
                <Clapperboard className="h-3.5 w-3.5 text-brand" />
                <span className="font-semibold text-brand">@vid{i + 1}</span>
                {noteName && noteName !== `Clip ${i + 1}` && (
                  <span className="max-w-[120px] truncate text-[11px] text-white/50">{noteName}</span>
                )}
                <button
                  type="button"
                  onClick={() => s.removeReferenceVideo(i)}
                  className="grid h-4 w-4 place-items-center rounded text-white/40 hover:bg-white/10 hover:text-white"
                  aria-label={`Remove reference clip ${i + 1}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* reference thumbnails — click to insert its @imgN tag into the prompt,
          drag to reorder. @imgN is a live index into referenceImages (see
          resolveReferences in mentions.ts), so reordering renumbers any
          @imgN already typed in the prompt via s.reorderReferences to keep
          each tag pointing at the same image. */}
      {s.referenceImages.length > 0 && <ReferenceStrip store={s} insertTag={(tag) => mentionRef.current?.insertTag(tag)} />}

      {/* @audioN chips are persisted Seedance audio references. */}
      {s.audioNotes.length > 0 && (
        <div className="scroll-none mb-2 flex gap-2 overflow-x-auto px-1 pb-1">
          {s.audioNotes.map((name, i) => (
            <div
              key={`${name}-${i}`}
              title={[typeof name === "string" ? name : name.name, typeof name?.duration === "number" ? formatAudioSeconds(name.duration) : null].filter(Boolean).join(" · ")}
              data-audio-rejected={audioProblem?.indexes.includes(i) || undefined}
              className={`group relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg bg-ink-750 px-1 ring-1 transition ${audioProblem?.indexes.includes(i) ? "ring-2 ring-red-400" : "ring-line hover:ring-brand/50"}`}
            >
              <button
                onClick={() => mentionRef.current?.insertTag(`@audio${i + 1}`)}
                className="flex flex-1 flex-col items-center justify-center gap-1"
              >
                <AudioLines className="h-4 w-4 text-brand" />
                <span className="line-clamp-1 w-full text-center text-[9px] leading-tight text-white/60">
                  {typeof name === "string" ? name : name.name}
                </span>
              </button>
              {typeof name?.duration === "number" && (
                <span className={`pointer-events-none absolute left-1 top-1 rounded px-1 text-[9px] font-semibold leading-[14px] tabular-nums ${audioProblem?.indexes.includes(i) ? "bg-red-600 text-white" : "bg-black/55 text-white/80"}`}>
                  {formatAudioSeconds(name.duration)}
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-semibold text-brand backdrop-blur-sm">
                @audio{i + 1}
              </span>
              <button
                type="button"
                aria-label={`Remove audio note ${i + 1}`}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  s.removeAudioNote(i);
                }}
                className="absolute right-1 top-1 z-30 grid h-5 w-5 place-items-center rounded-full bg-ink-950/85 text-white/90 shadow-md backdrop-blur-sm transition hover:bg-red-600 hover:text-white opacity-90 sm:opacity-0 sm:group-hover:opacity-100 cursor-pointer"
              >
                <X className="h-3 w-3 pointer-events-none" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Untagged mixed references risk being silently misread — e.g. a
          style/mood board folded into "another photo of the same face"
          because nothing marks it as a style reference (2026-08-17 fix,
          see prompt-assembler.js). Skipped when the more specific Higgsfield
          banner below already covers the same advice for that model. */}
      {s.referenceImages.length > 1 &&
        parseMentionIndices(s.prompt).length === 0 &&
        !(s.mode === "video" && isProviderModel(s.model, "higgsfield")) && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 py-1.5 text-[11px] leading-snug text-amber-200/90">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {s.referenceImages.length} references attached, none tagged — mixed
              references (a face plus a style or location board) can get
              misread as more photos of the same person. Tag each one for the
              right treatment: <b>@img1</b> for identity,{" "}
              <b>@img2 in this exact style</b> for a look/mood reference.
            </span>
          </div>
        )}

      {/* Higgsfield Seedance (via MCP) natively accepts multiple reference
          images, so several characters/locations can drive one shot. */}
      {s.mode === "video" &&
        isProviderModel(s.model, "higgsfield") &&
        s.referenceImages.length > 1 && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] leading-snug text-brand/90">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              All {s.referenceImages.length} references will be used — Seedance 2.0
              composes them into one shot. Tag them in your prompt as{" "}
              <b>@img1, @img2…</b> for left/right placement and roles.
            </span>
          </div>
        )}

      {/* First Frame & Optional Last Frame Staging */}
      {(s.firstFrameMode || s.firstFrame || s.continuationFrame || s.lastFrame) &&
        s.mode === "video" &&
        supportsFirstLastFrame(s.model) && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-brand/10 p-2 text-[11px] leading-snug text-brand/90">
            {/* First Frame */}
            {(s.firstFrame || s.continuationFrame) ? (
              <div className="flex items-center gap-1.5 rounded-lg bg-black/40 px-2 py-1 border border-brand/30">
                <img
                  src={s.firstFrame || s.continuationFrame}
                  alt="First frame"
                  className="h-8 w-8 shrink-0 rounded object-cover"
                />
                <div className="flex flex-col">
                  <span className="font-semibold text-white/95 text-[10px]">First Frame</span>
                  <span className="text-[9px] text-white/50">Start of video</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    s.setFirstFrame(null);
                    s.setContinuationFrame(null);
                  }}
                  className="ml-1 rounded p-0.5 text-brand/70 hover:bg-brand/20 hover:text-brand"
                  title="Remove first frame"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => firstFrameFileRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-brand/40 bg-black/20 px-2.5 py-1 text-brand/80 hover:bg-brand/20 hover:text-brand"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="text-[10px] font-medium">Add First Frame</span>
              </button>
            )}

            {/* Flow indicator */}
            <div className="flex items-center text-brand/60 px-0.5">
              <ArrowRight className="h-3.5 w-3.5" />
            </div>

            {/* Last Frame */}
            {s.lastFrame ? (
              <div className="flex items-center gap-1.5 rounded-lg bg-black/40 px-2 py-1 border border-brand/30">
                <img
                  src={s.lastFrame}
                  alt="Last frame"
                  className="h-8 w-8 shrink-0 rounded object-cover"
                />
                <div className="flex flex-col">
                  <span className="font-semibold text-white/95 text-[10px]">Last Frame</span>
                  <span className="text-[9px] text-white/50">End of video</span>
                </div>
                <button
                  type="button"
                  onClick={() => s.setLastFrame(null)}
                  className="ml-1 rounded p-0.5 text-brand/70 hover:bg-brand/20 hover:text-brand"
                  title="Remove last frame"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (!s.firstFrame && !s.continuationFrame) {
                    notify("Please select a first frame first.");
                    return;
                  }
                  lastFrameFileRef.current?.click();
                }}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-white/20 bg-black/20 px-2.5 py-1 text-white/60 hover:border-brand/40 hover:text-brand"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="text-[10px] font-medium">+ Last Frame (optional)</span>
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
              <span className="text-[10px] text-brand/70 hidden sm:block">
                {s.lastFrame
                  ? "Interpolates from first to last frame"
                  : s.firstFrame || s.continuationFrame
                  ? "Starts from first frame (adaptive ratio)"
                  : "Add a first frame to start"}
              </span>
              <button
                type="button"
                onClick={() => s.setFirstFrameMode(false)}
                className="rounded p-0.5 text-brand/60 hover:bg-brand/20 hover:text-brand"
                title="Turn off first frame mode"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

      {/* input row */}
      <div className="flex items-start gap-2">
        {/* upload */}
        <Dropdown
          side="top"
          trigger={(open) => (
            <span
              className={cn(
                "grid h-[58px] w-[58px] shrink-0 place-items-center rounded-xl border border-dashed border-white/15 text-white/55 transition-colors hover:border-brand/40 hover:text-brand",
                open && "border-brand/50 text-brand"
              )}
            >
              <span className="flex flex-col items-center gap-0.5">
                <Plus className="h-4 w-4" />
                <span className="text-[10px]">material</span>
              </span>
            </span>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  fileRef.current?.click();
                  close();
                }}
              >
                <Upload className="h-4 w-4 text-white/60" /> Local upload
              </MenuItem>
              {s.mode === "video" && (supportsFirstLastFrame(s.model) || supportsFirstFrameContinuation(s.model)) && (
                <>
                  <MenuItem
                    onClick={() => {
                      firstFrameFileRef.current?.click();
                      close();
                    }}
                  >
                    <SkipForward className="h-4 w-4 text-brand" /> Set First Frame
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      lastFrameFileRef.current?.click();
                      close();
                    }}
                  >
                    <ArrowRight className="h-4 w-4 text-brand" /> Set Last Frame (optional)
                  </MenuItem>
                </>
              )}
              {/* The entry point that was missing: without it the only way to
                  attach a clip was a button inside the detail modal, so the
                  @vid tags the composer advertises had no way to exist. */}
              <MenuItem
                disabled={!supportsVideoReference(s.model)}
                onClick={() => {
                  setPickingClips(true);
                  close();
                }}
              >
                <Clapperboard
                  className={cn(
                    "h-4 w-4",
                    supportsVideoReference(s.model) ? "text-brand" : "text-white/40"
                  )}
                />
                <span className="flex-1">Attach clip (video&#8209;to&#8209;video)</span>
              </MenuItem>
              {/* Opens the asset library (AssetLibrary.jsx) — saved characters,
                  outfits, locations, styles and props, referenced in a prompt
                  by their @slug. The whole path already worked server-side
                  (readAssets → assemblePrompt in queue/execute); this menu item
                  was the missing way in, which is why assets-db.js described
                  itself as "dormant in the UI". */}
              <MenuItem
                onClick={() => {
                  s.setAssetLibraryOpen(true);
                  close();
                }}
              >
                <BookOpen className="h-4 w-4 text-brand" /> Material library
              </MenuItem>
              <MenuItem
                onClick={() => {
                  s.setPortraitGalleryOpen(true);
                  close({ restoreFocus: false });
                }}
              >
                <Images className="h-4 w-4 text-brand" /> Portrait Gallery
              </MenuItem>
            </>
          )}
        </Dropdown>
        <div className="flex min-w-0 flex-1 flex-col">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={onFiles}
        />
        <input
          ref={firstFrameFileRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFrameUpload(file, "first");
            e.target.value = "";
          }}
        />
        <input
          ref={lastFrameFileRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFrameUpload(file, "last");
            e.target.value = "";
          }}
        />

        {referenceSubmissionWarning(s) && <p role="status" className="mb-1 text-xs text-amber-200">{referenceSubmissionWarning(s)}</p>}
        {s.draftStorageWarning && <p role="status" className="mb-1 text-xs text-amber-200">{s.draftStorageWarning}</p>}
        {normalizePromptMentions(s.prompt) !== s.prompt && <p role="status" className="mb-1 text-xs text-amber-200">Some reference tags are informal. They remain literal text; use @img1 for an exact reference.</p>}
        <div className="mb-2 flex gap-3 text-xs text-white/60"><button type="button" onClick={() => s.clearComposerDraft()}>New / Clear</button><button type="button" disabled={!s.recentSubmission} onClick={() => s.restoreRecentSubmission()}>Recent submission</button></div>
        <MentionTextarea
          ref={mentionRef}
          value={s.prompt}
          onChange={s.setPrompt}
          submitOnEnter={false}
          onSubmit={() => {
            // Purely a UX no-op here — the real gate is server-side in
            // generate/image and generate/video, which returns a readable
            // error either way. This just skips a submit already known to
            // fail rather than round-tripping to find that out.
            if (uploading || s.prompt.length > maxPromptLength) return;
            s.generate();
          }}
          assets={s.assets}
          references={s.referenceImages}
          videoRefs={s.referenceVideos}
          audioRefs={s.audioNotes}
          maxLength={maxPromptLength}
          placeholder={
            s.mode === "image"
              ? "Describe the image… type @ to reference uploaded images (@img1, @img2)."
              : "Describe the video… type @ to reference uploaded images (@img1, @img2)."
          }
        />
        </div>
      </div>

      {/* toolbar */}
      <div className="composer-controls-row mt-2 flex min-w-0 items-center gap-2">
        <div
          ref={toolbarMeasureRef}
          className="composer-toolbar flex min-w-0 flex-1 items-center gap-1.5 py-px"
        >
        {/* mode */}
        <Dropdown
          className="composer-mode shrink-0"
          label={`Generation mode: ${activeMode?.label ?? s.mode}`}
          side="top"
          trigger={(open) => (
            <Chip open={open}>
              {activeMode && MODE_ICONS[activeMode.icon] ? (
                (() => {
                  const I = MODE_ICONS[activeMode.icon];
                  return <I className="h-4 w-4 text-brand" />;
                })()
              ) : null}
              <span className="composer-mode-label font-medium">{activeMode?.label}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </Chip>
          )}
        >
          {(close) =>
            MODES.map((m) => {
              const I = MODE_ICONS[m.icon];
              return (
                <MenuItem
                  key={m.id}
                  active={m.id === s.mode}
                  disabled={!m.enabled}
                  onClick={() => {
                    if (m.id === "image" || m.id === "video" || m.id === "depth" || m.id === "upscale") s.setMode(m.id);
                    close();
                  }}
                >
                  {I && <I className="h-4 w-4" />}
                  <span className="flex-1">{m.label}</span>
                  {m.id === s.mode && <Check className="h-4 w-4 text-brand" />}
                  {!m.enabled && <span className="text-[10px] text-white/30">soon</span>}
                </MenuItem>
              );
            })
          }
        </Dropdown>

        {/* model */}
        <Dropdown
          className="composer-model min-w-0 flex-1"
          label={`Model: ${s.model}`}
          side="top"
          trigger={(open) => (
            <Chip open={open}>
              <Box className="h-4 w-4 text-white/55" />
              <span className="composer-model-label max-w-[14rem] truncate font-medium">
                {s.model}
              </span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </Chip>
          )}
        >
          {(close) =>
            modeModels.map((m) => (
              <MenuItem
                key={m.id}
                active={m.name === s.model}
                onClick={() => {
                  s.setModel(m.name);
                  close();
                }}
              >
                <Box className="h-4 w-4 text-white/50" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{m.name}</span>
                  {m.hint && (
                    <span className="text-[10px] leading-snug text-white/40">
                      {m.hint}
                    </span>
                  )}
                </span>
                {m.badge && (
                  <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                    {m.badge}
                  </span>
                )}
                {m.name === s.model && <Check className="h-4 w-4 text-brand" />}
              </MenuItem>
            ))
          }
        </Dropdown>

        {/* settings (aspect / resolution / duration / batch) */}
        <Dropdown
          key={`generation-settings-${s.mode}`}
          className="composer-settings shrink-0"
          label="Generation settings"
          align="right"
          side="top"
          panelClassName="w-max min-w-[230px] max-w-[min(92vw,340px)] p-3 max-h-[60vh] overflow-y-auto scroll-thin"
          trigger={(open) => (
            <Chip open={open}>
              <Settings2 className="h-4 w-4 text-white/55" />
              {editExtendApplies && videoTaskMode !== "generate" && (
                <>
                  <span className="composer-setting-value font-medium capitalize text-brand">
                    {videoTaskMode}
                  </span>
                  <span className="composer-setting-separator text-white/35">·</span>
                </>
              )}
              <span className="composer-setting-value font-medium">
                {videoTaskMode === "generate" && !s.firstFrameMode && !s.firstFrame && !s.continuationFrame
                  ? s.aspectRatio
                  : "Adaptive"}
              </span>
              <span className="composer-setting-separator text-white/35">·</span>
              <span className="composer-secondary-setting">{s.resolution}</span>
              {s.mode === "video" && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">
                    {videoTaskMode === "edit" ? "Auto" : `${s.duration}s`}
                  </span>
                </>
              )}
              {firstLastFrameApplies && (s.firstFrameMode || s.firstFrame || s.continuationFrame) && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting font-medium text-brand">1st Frame</span>
                </>
              )}
              {s.batchCount > 1 && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting text-brand">
                    {s.batchCount}×
                  </span>
                </>
              )}
              {/* Audio costs extra, so it is visible on the collapsed chip
                  rather than only inside the panel. Gated by audioApplies so it
                  never appears where the provider has no audio field. */}
              {audioApplies && s.generateAudio && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <Volume2 className="composer-secondary-setting h-3.5 w-3.5 text-brand" />
                </>
              )}
              {draftApplies && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">{s.draftMode ? "Draft" : "Final"}</span>
                </>
              )}
              {bitrateApplies && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">
                    {s.bitrateMode === "standard" ? "Low" : "High"}
                  </span>
                </>
              )}
            </Chip>
          )}
        >
          {() => (
            <div className="space-y-3">
              {/* Seedance 2.5 maps the selected mode to an explicit omni task
                  type when references are attached (see providers/seedance.js). */}
              {editExtendApplies && (
                <div>
                  <Segment
                    label="Video task"
                    options={VIDEO_TASK_MODES.map(
                      (m) => m[0].toUpperCase() + m.slice(1)
                    )}
                    value={videoTaskMode[0].toUpperCase() + videoTaskMode.slice(1)}
                    onChange={(v) => s.setVideoTaskMode(v.toLowerCase() )}
                  />
                  {videoTaskMode !== "generate" && s.referenceVideos.length === 0 && (
                    <p className="mt-1 text-[11px] leading-snug text-amber-400/90">
                      Attach a reference clip above to {videoTaskMode} a video.
                    </p>
                  )}
                </div>
              )}
              {firstLastFrameApplies && videoTaskMode === "generate" && (
                <div>
                  <Segment
                    label="First frame"
                    options={["Off", "On"]}
                    value={s.firstFrameMode || s.firstFrame || s.continuationFrame ? "On" : "Off"}
                    onChange={(v) => s.setFirstFrameMode(v === "On")}
                  />
                  <p className="mt-1 text-[11px] leading-snug text-white/35">
                    Start video from a keyframe with optional last frame interpolation.
                  </p>
                </div>
              )}
              {videoTaskMode === "generate" && !(s.mode === "video" && (s.firstFrame || s.continuationFrame || s.firstFrameMode)) ? (
                <Segment
                  label="Aspect ratio"
                  options={aspectRatiosForModel(s.model, s.mode)}
                  value={s.aspectRatio}
                  onChange={s.setAspectRatio}
                />
              ) : (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Aspect ratio
                  </p>
                  <p className="text-xs text-white/50">
                    {s.firstFrame || s.continuationFrame || s.firstFrameMode
                      ? "Adaptive — matches first frame"
                      : "Adaptive — matches the reference clip"}
                  </p>
                </div>
              )}
              <Segment
                label="Resolution"
                options={resolutionsForModel(s.model, s.mode, s.referenceImages.length > 0)}
                value={s.resolution}
                onChange={s.setResolution}
              />
              {s.mode === "video" && videoTaskMode === "edit" && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Duration
                  </p>
                  <p className="text-xs text-white/50">
                    Auto — matches the reference clip
                  </p>
                </div>
              )}
              {s.mode === "video" && videoTaskMode !== "edit" && durationRange && (
                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Duration
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={durationRange.min}
                      max={durationRange.max}
                      step={durationRange.step}
                      value={s.duration}
                      onChange={(e) => s.setDuration(Number(e.target.value))}
                      className="h-1.5 flex-1 cursor-pointer accent-brand"
                      aria-label="Duration"
                    />
                    <span className="w-8 shrink-0 text-right text-xs font-medium tabular-nums text-white/70">
                      {s.duration}s
                    </span>
                  </div>
                </div>
              )}
              {s.mode === "video" && videoTaskMode !== "edit" && !durationRange && (
                <Segment
                  label="Duration"
                  options={durationsForModel(s.model).map((d) => `${d}s`)}
                  value={`${s.duration}s`}
                  onChange={(v) => s.setDuration(parseInt(v))}
                />
              )}
              <Segment
                label="Batch (per generate)"
                options={["1×", "2×"]}
                value={`${s.batchCount}×`}
                onChange={(v) => s.setBatchCount(parseInt(v))}
              />
              {/* Only where the provider has the field. Omni's Interactions
                  request exposes no audio parameter, so showing this for it
                  would be a control that does nothing. */}
              {audioApplies && (
                <div>
                  <Segment
                    label="Audio"
                    options={["Off", "On"]}
                    value={s.generateAudio ? "On" : "Off"}
                    onChange={(v) => s.setGenerateAudio(v === "On")}
                  />
                  <p className="mt-1 text-[11px] leading-snug text-white/35">
                    Seedance scores the video with synchronised sound. Billed on
                    top of the video.
                  </p>
                </div>
              )}
              {draftApplies && (
                  <Segment
                    label="Render"
                    options={["Final", "Draft"]}
                    value={s.draftMode ? "Draft" : "Final"}
                    onChange={(v) => s.setDraftMode(v === "Draft")}
                  />
              )}
              {bitrateApplies && (
                  <Segment
                    label="Bitrate"
                    options={["Low", "High"]}
                    value={s.bitrateMode === "standard" ? "Low" : "High"}
                    onChange={(v) => s.setBitrateMode(v === "Low" ? "standard" : "high")}
                  />
              )}
            </div>
          )}
        </Dropdown>

        {/* destination: which project / folder new generations land in */}
        <Dropdown
          className="composer-destination shrink-0"
          label="Generation destination"
          align="right"
          side="top"
          panelClassName="min-w-[210px]"
          trigger={(open) => {
            const proj = s.projects.find((p) => p.id === s.activeProjectId);
            function findFolder(nodes, id) {
              for (const n of nodes) {
                if (n.id === id) return n;
                if (n.children?.length) {
                  const res = findFolder(n.children, id);
                  if (res) return res;
                }
              }
              return null;
            }
            const allFolders = [
              ...(s.libraryTree?.globalFolders ?? []),
              ...(proj ? (s.libraryTree?.projects?.find((p) => p.id === proj.id)?.folders ?? proj.folders ?? []) : [])
            ];
            const folder = findFolder(allFolders, s.activeFolderId);
            const folderLabel = s.activeFolderId === UNSORTED ? "Unsorted" : (folder ? folder.name : "All");
            return (
              <Chip open={open}>
                <FolderClosed className="h-4 w-4 text-white/55" />
                <span className="composer-project-label max-w-[110px] truncate font-medium">
                  {proj ? proj.name : "Global Library"}
                </span>
                <span className="composer-folder-separator text-white/35">/</span>
                <span className="composer-folder-label max-w-[80px] truncate">
                  {folderLabel}
                </span>
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
                />
              </Chip>
            );
          }}
        >
          {() => {
            const proj = s.projects.find((p) => p.id === s.activeProjectId);
            const foldersToDisplay = proj
              ? (s.libraryTree?.projects?.find((p) => p.id === proj.id)?.folders ?? proj.folders ?? [])
              : (s.libraryTree?.globalFolders ?? []);

            const renderFolderMenuItems = (folders, depth = 0) =>
              folders.map((f) => (
                <div key={f.id}>
                  <MenuItem
                    active={s.activeFolderId === f.id}
                    onClick={() => s.setActiveFolder(f.id)}
                    style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
                  >
                    <FolderClosed className="h-4 w-4 text-white/45" />
                    <span className="flex-1 truncate">{f.name}</span>
                    {s.activeFolderId === f.id && <Check className="h-4 w-4 text-brand" />}
                  </MenuItem>
                  {f.children?.length > 0 && renderFolderMenuItems(f.children, depth + 1)}
                </div>
              ));

            return (
              <div className="max-h-[340px] overflow-y-auto scroll-thin py-1">
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                  Scope
                </p>
                <MenuItem
                  active={s.activeProjectId === null}
                  onClick={() => {
                    s.setActiveProject(null);
                    s.setActiveFolder(null);
                  }}
                >
                  <Layers className="h-4 w-4 text-white/45" />
                  <span className="flex-1 truncate">Global Library</span>
                  {s.activeProjectId === null && <Check className="h-4 w-4 text-brand" />}
                </MenuItem>
                {s.projects.map((p) => (
                  <MenuItem
                    key={p.id}
                    active={p.id === s.activeProjectId}
                    onClick={() => {
                      s.setActiveProject(p.id);
                      s.setActiveFolder(null);
                    }}
                  >
                    <Layers className="h-4 w-4 text-white/45" />
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.id === s.activeProjectId && <Check className="h-4 w-4 text-brand" />}
                  </MenuItem>
                ))}
                <MenuItem
                  onClick={async () => {
                    const name = await askText({ title: "New project", label: "Project name", confirmLabel: "Create" });
                    if (name) s.createProject(name);
                  }}
                >
                  <Plus className="h-4 w-4 text-white/60" />
                  <span className="flex-1">New project</span>
                </MenuItem>

                <div className="my-1 h-px bg-line" />
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                  Folder in {proj ? proj.name : "Global Library"}
                </p>
                <MenuItem
                  active={s.activeFolderId === null}
                  onClick={() => s.setActiveFolder(null)}
                >
                  <Layers className="h-4 w-4 text-white/45" />
                  <span className="flex-1">
                    {proj ? "All in project" : "Global Root"}
                  </span>
                  {s.activeFolderId === null && <Check className="h-4 w-4 text-brand" />}
                </MenuItem>
                <MenuItem
                  active={s.activeFolderId === UNSORTED}
                  onClick={() => s.setActiveFolder(UNSORTED)}
                >
                  <Inbox className="h-4 w-4 text-white/45" />
                  <span className="flex-1">Unsorted</span>
                  {s.activeFolderId === UNSORTED && <Check className="h-4 w-4 text-brand" />}
                </MenuItem>

                {renderFolderMenuItems(foldersToDisplay)}
              </div>
            );
          }}
        </Dropdown>

        </div>

        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={() => s.generate()}
          disabled={uploading || !s.prompt.trim() || s.generating || s.prompt.length > maxPromptLength}
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-all duration-200",
            !uploading && s.prompt.trim() && !s.generating && s.prompt.length <= maxPromptLength
              ? "bg-gradient-to-br from-brand to-accent text-ink-900 shadow-glow hover:brightness-110"
              : "cursor-not-allowed bg-ink-650 text-white/30"
          )}
          aria-label="Generate"
          title={uploading ? "Waiting for attachments to finish uploading" : s.prompt.length > maxPromptLength ? `Prompt exceeds the ${maxPromptLength.toLocaleString()}-character limit` : undefined}
        >
          {s.generating || uploading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ArrowUp className="h-5 w-5" strokeWidth={2.4} />
          )}
        </motion.button>
      </div>
    </motion.div>
  );
}

function Chip({ open, children }) {
  return (
    <span
      className={cn(
        "control-chip flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/80 transition-colors hover:border-lineStrong hover:text-white",
        open && "border-brand/40 text-white"
      )}
    >
      {children}
    </span>
  );
}

function Segment({
  label,
  options,
  value,
  onChange,
}

) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              value === opt
                ? "bg-brand/20 text-brand ring-1 ring-brand/40"
                : "bg-ink-700 text-white/65 ring-1 ring-line hover:text-white"
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}


const REFERENCE_SESSION_TOKEN = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

/** Split a /api/media thumbnail URL into its media reference and requested width. */
export function splitMediaThumb(src) {
  if (typeof src !== "string" || !src.startsWith("/api/media/")) return { ref: null, width: undefined };
  const [path, query = ""] = src.split("#")[0].split("?");
  const width = Number(new URLSearchParams(query).get("w")) || undefined;
  return { ref: path, width };
}

export function referenceThumbnailUrl(url, portraitAssets = []) {
  const display = referenceDisplayUrl(url, portraitAssets);
  return display?.startsWith("/api/media/uploads/image-reference/") ? thumbUrl(display, 512) : display;
}

/** Where a reference came from, for the strip badge and failure copy. Portrait
 * Gallery references arrive as asset://, a provider URL carrying bp_asset_id,
 * or a stored portrait upload; materials keep their composer kind. */
export function referenceSource(ref, kind, portraitAssets = []) {
  const value = typeof ref === "string" ? ref : "";
  const assetId = value.startsWith("asset://")
    ? value.slice("asset://".length).split(/[?&#]/)[0]
    : value.match(/[#?&]bp[-_]asset(?:_id)?=([^&#]+)/)?.[1];
  const path = value.split("#")[0];
  const portrait = (Array.isArray(portraitAssets) ? portraitAssets : []).find((a) =>
    (assetId && (a?.byteplusAssetId === assetId || a?.id === assetId)) || (a?.imageUrl && a.imageUrl.split("#")[0] === path));
  if (kind === "portrait" || assetId || portrait || path.includes("/uploads/portrait/")) {
    return { type: "portrait", name: portrait?.name || null };
  }
  if (kind === "material" || path.includes("/uploads/material/")) return { type: "material", name: null };
  return { type: null, name: null };
}

/** Failed references stay in their original occurrence slots; a missing
 * thumbnail never shifts @imgN numbering or replaces another occurrence. */
function ReferenceThumbnail({ src, alt, className, portrait = false }) {
  const [failed, setFailed] = useState(false);
  // Private upload redirects expire; one token per page session keeps a fresh
  // first request without re-fetching on every remount.
  const displaySrc = useMemo(() => {
    if (!src?.startsWith("/api/media/uploads/image-reference/")) return src;
    const [path, fragment] = src.split("#");
    const fresh = `${path}${path.includes("?") ? "&" : "?"}reference_request=${encodeURIComponent(REFERENCE_SESSION_TOKEN)}`;
    return fragment ? `${fresh}#${fragment}` : fresh;
  }, [src]);
  // Prefer a direct storage URL when the backend can resolve one.
  const { ref: mediaRef, width: mediaWidth } = splitMediaThumb(src);
  const direct = useDirectMediaUrl(mediaRef, mediaWidth);
  const imageSrc = mediaRef && direct.src !== (mediaWidth ? thumbUrl(mediaRef, mediaWidth) : mediaRef) ? direct.src : displaySrc;
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    const [text, hint] = portrait
      ? ["Portrait removed", "This portrait is no longer available. Remove it and pick a current portrait."]
      : ["Reference unavailable", "This image is no longer available. Remove it and select another image."];
    return <span className={`${className} flex items-center justify-center bg-ink-950 p-1 text-center text-[10px] text-white/55`} role="img" aria-label={`${alt || "Reference"}: ${text}`} title={hint}>{text}</span>;
  }
  return <img src={imageSrc} alt={alt} draggable={false} className={className} onError={() => { if (!direct.onError()) setFailed(true); }} />;
}

/** Pointer sorting is confined to the grip; the strip itself remains a native
 * scroll surface. Only a completed gesture changes the draft's mention order. */
export function ReferenceStrip({ store: s, insertTag }) {
  const reducedMotion = useReducedMotion();
  const strip = useRef(null);
  const gesture = useRef(null);
  const frame = useRef(null);
  const [preview, setPreview] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const [positionId, setPositionId] = useState(null);
  const [position, setPosition] = useState(1);
  const [undoVisible, setUndoVisible] = useState(false);
  const ids = s.referenceIds?.length === s.referenceImages.length ? s.referenceIds : s.referenceImages.map((_, i) => `legacy-reference-${i}`);
  const visibleIds = preview?.ids || ids;
  const focusCard = (id) => requestAnimationFrame(() => {
    const card = Array.from(strip.current?.querySelectorAll('[data-reference-id]') || []).find((el) => el.dataset.referenceId === id);
    card?.querySelector('[data-reference-grip]')?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  const commit = (ordered, id) => {
    if (ordered.every((value, i) => value === ids[i])) return;
    s.reorderReferencesByIds(ordered);
    setAnnouncement(`Reference ${ids.indexOf(id) + 1} moved to position ${ordered.indexOf(id) + 1}`);
    setUndoVisible(true);
    focusCard(id);
  };
  const move = (id, target) => {
    const ordered = [...ids];
    ordered.splice(ordered.indexOf(id), 1);
    ordered.splice(Math.max(0, Math.min(ids.length - 1, target)), 0, id);
    commit(ordered, id);
  };
  const updateGesture = (now = performance.now()) => {
    const current = gesture.current;
    const container = strip.current;
    if (!current || !container) return;
    const bounds = container.getBoundingClientRect();
    // The edge speed is in pixels per 60 fps frame. Scale it by the real frame time so a busy or
    // slow machine scrolls the strip as fast as a smooth one; cap the step after a stalled frame.
    const elapsed = Math.min(64, Math.max(0, now - (current.lastFrame ?? now)));
    current.lastFrame = now;
    if (current.active) {
      const edge = 52;
      const speed = current.x < bounds.left + edge ? -Math.ceil((bounds.left + edge - current.x) / 4) : current.x > bounds.right - edge ? Math.ceil((current.x - bounds.right + edge) / 4) : 0;
      current.scrollCarry = (current.scrollCarry || 0) + Math.max(-24, Math.min(24, speed)) * (elapsed * 60 / 1000);
      const step = Math.trunc(current.scrollCarry);
      current.scrollCarry -= step;
      if (step) container.scrollLeft += step;
      const cards = Array.from(container.querySelectorAll('[data-reference-id]'));
      const others = cards.filter((el) => el.dataset.referenceId !== current.id);
      const target = others.findIndex((el) => current.x < el.getBoundingClientRect().left + el.offsetWidth / 2);
      const ordered = current.ids.filter((id) => id !== current.id);
      ordered.splice(target === -1 ? ordered.length : target, 0, current.id);
      current.ordered = ordered;
      // Re-render the strip only when the drop order or the pointer moved, not on every frame.
      const signature = `${ordered.join(",")}|${current.x}|${current.y}`;
      if (signature !== current.previewSignature) {
        current.previewSignature = signature;
        setPreview({ ids: ordered, id: current.id, x: current.x, y: current.y });
      }
    }
    frame.current = requestAnimationFrame(updateGesture);
  };
  useEffect(() => () => { cancelAnimationFrame(frame.current); gesture.current = null; }, []);
  const start = (e, id) => {
    if (e.button !== 0 || ids.length < 2) return;
    e.preventDefault();
    // Capture on the stationary scroll container. Moving a captured card in
    // the DOM can release capture before the pointer reaches the strip edge.
    strip.current.setPointerCapture(e.pointerId);
    gesture.current = { id, ids: [...ids], ordered: [...ids], startX: e.clientX, x: e.clientX, y: e.clientY, active: false };
    frame.current = requestAnimationFrame(updateGesture);
  };
  const end = (cancelled = false) => {
    cancelAnimationFrame(frame.current);
    const current = gesture.current;
    gesture.current = null;
    setPreview(null);
    if (current?.active && !cancelled) commit(current.ordered, current.id);
  };
  const activeIndex = preview ? ids.indexOf(preview.id) : -1;
  return <div className="mb-2" aria-label="Attached image references">
    <div className="mb-1 flex items-center justify-between text-[11px] text-white/55">
      <span>{ids.length} {ids.length === 1 ? "reference" : "references"}</span>
      {undoVisible && <button type="button" className="flex items-center gap-1 text-brand" onClick={() => { s.undoReferenceReorder(); setUndoVisible(false); setAnnouncement("Reference reorder undone"); }}><Undo2 className="h-3 w-3" />Undo reorder</button>}
    </div>
    <div ref={strip}
      onPointerMove={(e) => { const current = gesture.current; if (!current) return; current.x = e.clientX; current.y = e.clientY; if (Math.abs(current.x - current.startX) > 5) current.active = true; }}
      onPointerUp={() => end()} onPointerCancel={() => end(true)}
      data-testid="reference-strip" className="flex gap-2 overflow-x-auto overscroll-x-contain px-1 pb-2">
      {visibleIds.map((id, i) => {
        const sourceIndex = ids.indexOf(id);
        const tag = s.referenceTags?.[sourceIndex] || `@img${sourceIndex + 1}`;
        const source = referenceSource(s.referenceImages[sourceIndex], s.referenceKinds?.[sourceIndex], s.portraitAssets);
        const label = s.referenceLabels?.[sourceIndex] || source.name || (source.type === "portrait" ? "Portrait" : `Reference ${sourceIndex + 1}`);
        return <motion.div key={id} data-reference-id={id} data-reference-position={i + 1} layout={!gesture.current && !reducedMotion} transition={{ duration: reducedMotion ? 0 : 0.16 }}
          onKeyDown={(e) => { if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); move(id, sourceIndex + (e.key === "ArrowLeft" ? -1 : 1)); } }}
          className={cn("group relative w-24 shrink-0 rounded-lg border bg-ink-800 p-1 focus-within:ring-2 focus-within:ring-brand", preview?.id === id ? "border-brand border-l-4 ring-2 ring-brand/70 opacity-50" : "border-line")}>
          <div className="relative">
            <button type="button" aria-label={`Insert ${tag}`} onClick={() => insertTag(tag)} className="block h-20 w-full overflow-hidden rounded focus-visible:outline-brand">
              <ReferenceThumbnail src={referenceThumbnailUrl(s.referenceImages[sourceIndex], s.portraitAssets)} alt={label} portrait={source.type === "portrait"} className="h-full w-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 truncate bg-black/65 text-[11px] font-semibold text-brand">{tag}</span>
            </button>
            {source.type === "portrait" && (
              <span data-reference-source="portrait" title={source.name ? `Portrait Gallery: ${source.name}` : "From the Portrait Gallery"}
                className="absolute left-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-brand text-black shadow-sm">
                <UserRound className="h-2.5 w-2.5" />
              </span>
            )}
            {source.type === "material" && (
              <span data-reference-source="material" title={s.referenceLabels?.[sourceIndex] ? `Material: ${s.referenceLabels[sourceIndex]}` : "Material Library asset"}
                className="absolute left-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-purple-600 text-white shadow-sm">
                <Sparkles className="h-2.5 w-2.5" />
              </span>
            )}
            {s.unavailableReferences?.includes(s.referenceImages[sourceIndex]) && (
              <span data-reference-unavailable title="This portrait was removed or isn't ready for video. Remove it to generate."
                className="pointer-events-none absolute inset-0 grid place-items-center rounded bg-red-950/75 text-[10px] font-semibold text-red-100 ring-2 ring-inset ring-red-400">
                Unavailable
              </span>
            )}
            <button type="button" aria-label={`Remove reference ${sourceIndex + 1}`} onClick={() => s.removeReference(sourceIndex)} className="absolute right-0 top-0 grid h-6 w-6 place-items-center rounded bg-ink-950/90 text-white"><X className="h-3 w-3" /></button>
          </div>
          <p title={label} className="truncate text-[10px] text-white/65">{label}</p>
          <div className="flex items-center justify-center">
            <button type="button" aria-label={`Move reference ${sourceIndex + 1} left`} disabled={sourceIndex === 0} onClick={() => move(id, sourceIndex - 1)} className="grid h-8 w-6 place-items-center disabled:opacity-20"><ArrowLeft className="h-3 w-3" /></button>
            <button type="button" data-reference-grip aria-label={`Drag reference ${sourceIndex + 1} to reorder`} title="Drag to arrange; Alt + arrow keys also move" onPointerDown={(e) => start(e, id)}
              className="grid h-11 w-11 cursor-grab touch-none place-items-center rounded hover:bg-white/10 active:cursor-grabbing"><GripVertical className="h-5 w-5" /></button>
            <button type="button" aria-label={`Move reference ${sourceIndex + 1} right`} disabled={sourceIndex === ids.length - 1} onClick={() => move(id, sourceIndex + 1)} className="grid h-8 w-6 place-items-center disabled:opacity-20"><ArrowRight className="h-3 w-3" /></button>
          </div>
          <button type="button" aria-label={`Move reference ${sourceIndex + 1} to position`} onClick={() => { setPositionId(id); setPosition(sourceIndex + 1); }} className="sr-only w-full rounded text-[10px] text-white/60 focus:not-sr-only focus:text-brand">Move to position…</button>
        </motion.div>;
      })}
    </div>
    {preview && <div aria-hidden="true" className="pointer-events-none fixed z-[100] w-24 rounded-lg border-2 border-brand bg-ink-800 p-1 shadow-xl" style={{ left: preview.x - 48, top: preview.y - 80 }}>
      <ReferenceThumbnail src={referenceThumbnailUrl(s.referenceImages[activeIndex], s.portraitAssets)} alt="Reference" className="h-20 w-full rounded object-cover" />
      <span className="text-xs text-brand">Position {preview.ids.indexOf(preview.id) + 1}</span>
    </div>}
    {positionId && <form className="flex items-center gap-2 rounded border border-line p-2" onSubmit={(e) => { e.preventDefault(); move(positionId, Number(position) - 1); setPositionId(null); }}>
      <label className="text-xs">Move to position <input autoFocus type="number" min="1" max={ids.length} required value={position} onChange={(e) => setPosition(e.target.value)} className="ml-1 w-16 rounded bg-ink-950 p-1" /></label>
      <button type="submit" className="text-xs text-brand">Move</button><button type="button" onClick={() => setPositionId(null)} className="text-xs">Cancel</button>
    </form>}
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</span>
  </div>;
}


export function stagedReferenceCount(state) {
  return (state.referenceImages?.length || 0) + (state.referenceVideos?.length || 0) + (state.audioNotes?.length || 0);
}

export function referenceSubmissionWarning(state) {
  const messages = [];
  const maxImages = isProviderModel(state.model, "seedream") ? 10 : state.mode === "video" ? maxReferenceImagesForVideoModel(state.model) : null;
  const maxVideos = state.mode === "video" ? maxReferenceVideosForVideoModel(state.model) ?? MAX_REFERENCE_VIDEOS : 0;
  if (maxImages !== null && state.referenceImages?.length > maxImages) messages.push(`${state.model} accepts at most ${maxImages} image references per submission`);
  if (state.referenceVideos?.length > maxVideos || (state.referenceVideos?.length && !supportsVideoReference(state.model))) messages.push(`${state.model} cannot submit this many video references`);
  if (state.audioNotes?.length && !supportsAudio(state.model)) messages.push(`${state.model} does not accept audio references`);
  const audioProblem = state.mode === "video" ? referenceAudioProblem(state.model, state.audioNotes) : null;
  if (audioProblem) messages.push(audioProblem.message.replace(/\.$/, ""));
  return messages.length ? `${messages.join(". ")}. All attachments remain staged; remove extras or choose a compatible model before generating.` : null;
}
