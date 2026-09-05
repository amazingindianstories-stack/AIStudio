import {
  useEffect,
  useRef,
  useState,

} from "react";
import { motion, Reorder } from "framer-motion";
import {
  Plus,
  Image as ImageIcon,
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
  Sparkles,
  Volume2,
  SkipForward,
} from "lucide-react";
import { useStore, restoreComposerDraft } from "@/lib/store";
import { parseMentionIndices } from "@/lib/mentions";
import { limitDefinition } from "@/lib/limits";
import { extractFrame, isVideoFile } from "@/lib/video-frame";
import { VideoRefPicker } from "./VideoRefPicker";
import { DepthComposer } from "./DepthComposer";
import { Dropdown, MenuItem } from "./Dropdown";
import { MentionTextarea, } from "./MentionTextarea";
import {

  MODELS,
  MODES,
  aspectRatiosForModel,
  durationsForModel,
  durationRangeForModel,
  maxReferenceImagesForVideoModel,
  resolutionsForModel,
  supportsAudio,
  supportsVideoReference,
  supportsVideoEditExtend,
  VIDEO_TASK_MODES,
} from "@/lib/config";
import { cn } from "@/lib/utils";
import { isProviderModel } from "@/lib/model-registry";

import {
  REF_BATCH_BUDGET_BYTES,
  REF_BUDGET_STEPS,
  dataUrlBytes,
  downscaleBlob,
} from "@/lib/client-image-budget";

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
  // Edit/Extend only exist on Seedance 2.5 (config.supportsVideoEditExtend).
  // Both require BytePlus's ratio:"adaptive" and Edit also forces duration to
  // "match the source" — see the videoTaskMode branches on the Aspect
  // ratio/Duration segments below.
  const editExtendApplies = s.mode === "video" && supportsVideoEditExtend(s.model);
  const videoTaskMode = editExtendApplies ? s.videoTaskMode : "generate";
  // Seedance 2.0/2.5 take any integer duration within a bounded range rather
  // than a fixed enum (see durationRangeForModel) — non-null here switches
  // the Duration control below from Segment buttons to a slider.
  const durationRange = s.mode === "video" ? durationRangeForModel(s.model) : null;
  // Reorder.Group's drag physics expect `values` to update synchronously
  // within the same render as the gesture — bound straight to the Zustand
  // store, the set()→subscription→re-render round trip added just enough
  // lag to feel glitchy (items lagging the cursor, layout animations
  // fighting each other). Buffering the LIVE drag in local state keeps every
  // tick synchronous/local; only the settled result is committed to the
  // store (onDragEnd below), which is also all reorderReferences needs since
  // it only cares about start vs. end position, not the intermediate ones.
  const [dragRefs, setDragRefs] = useState(s.referenceImages);
  const dragRefsRef = useRef(dragRefs);
  useEffect(() => {
    dragRefsRef.current = s.referenceImages;
    setDragRefs(s.referenceImages);
  }, [s.referenceImages]);
  const fileRef = useRef(null);
  const mentionRef = useRef(null);
  const toolbarMeasureRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [extractingFrames, setExtractingFrames] = useState(0);
  const [pickingClips, setPickingClips] = useState(false);
  const [preferredWidth, setPreferredWidth] = useState(768);

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

  // Read image File objects (from upload, paste, or drop) into references.
  //
  // Payload-budget ladder: encode the WHOLE batch at each step, summing raw
  // bytes, and only step down (lower quality, then lower dimension) if the
  // batch would still risk Vercel's 4.5MB body limit. Keeps typical 1–3 ref
  // uploads at full REF_MAX_DIM fidelity — the density identity tiles are
  // cropped from — while the last step (1024px/q0.8, today's behavior) is a
  // guaranteed-to-fit floor.
  const addImageFiles = async (files) => {
    const referenceFiles = files.filter(
      (file) => isVideoFile(file) || file.type.startsWith("image/")
    );
    const maxReferences =
      s.mode === "video" ? maxReferenceImagesForVideoModel(s.model) : null;
    const available =
      maxReferences === null
        ? referenceFiles.length
        : Math.max(0, maxReferences - s.referenceImages.length);
    const acceptedReferenceFiles = referenceFiles.slice(0, available);
    if (acceptedReferenceFiles.length < referenceFiles.length) {
      alert(
        `${s.model} accepts at most ${maxReferences} reference images. ` +
          `Only the first ${acceptedReferenceFiles.length} new reference${acceptedReferenceFiles.length === 1 ? " was" : "s were"} added.`
      );
    }
    // Videos are accepted by pulling a still frame out of them in the browser.
    // No provider here takes an uploaded video (and a video could not survive
    // Vercel's 4.5MB body limit anyway), but every one of them takes an image —
    // so a frame turns "video → image" and "video → video" into paths that
    // already work. See lib/video-frame.ts.
    const videos = acceptedReferenceFiles.filter(isVideoFile);
    if (videos.length) {
      setExtractingFrames(videos.length);
      for (const file of videos) {
        try {
          const { dataUrl } = await extractFrame(file);
          s.addReference(dataUrl, "video");
        } catch (e) {
          console.error("Frame extraction failed", e);
          alert(
            e?.message ||
              `Could not read a frame from ${file.name}. Try a different format (MP4/WebM).`
          );
        }
      }
      setExtractingFrames(0);
    }

    // Audio has no image/video-style content to fold into a reference — no
    // provider here takes one, and there's no frame to extract. It's kept as
    // a filename-only @audioN tag purely so it can be mentioned in the
    // prompt text, never uploaded or stored anywhere.
    for (const file of files.filter((f) => f.type.startsWith("audio/"))) {
      s.addAudioNote(file.name);
    }

    const valid = acceptedReferenceFiles.filter((f) => f.type.startsWith("image/"));
    if (!valid.length) return;

    let dataUrls = [];
    for (let i = 0; i < REF_BUDGET_STEPS.length; i++) {
      const { dim, quality } = REF_BUDGET_STEPS[i];
      const encoded = await Promise.all(
        valid.map(async (f) => {
          try {
            return await downscaleBlob(f, dim, quality);
          } catch (e) {
            console.error("Failed to downscale image", e);
            return null;
          }
        })
      );
      dataUrls = encoded.filter((u) => u !== null);
      if (!dataUrls.length) return;
      const totalBytes = dataUrls.reduce((n, u) => n + dataUrlBytes(u), 0);
      if (totalBytes <= REF_BATCH_BUDGET_BYTES || i === REF_BUDGET_STEPS.length - 1) break;
    }

    for (const dataUrl of dataUrls) s.addReference(dataUrl);
  };

  const onFiles = (e) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  // Paste images from the clipboard (Cmd/Ctrl+V) — only intercept when the
  // clipboard actually carries images, so normal text paste is unaffected.
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  // Drag & drop image files from the OS file manager. Ignore internal drags
  // (e.g. moving cards between folders) which carry no files.
  const isFileDrag = (e) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragOver = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget )) setDragging(false);
  };

  const onDrop = (e) => {
    setDragging(false);
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

  return (
    <motion.div
      layout="size"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      style={{ width: `min(100%, ${preferredWidth}px)` }}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="composer-shell relative mx-auto max-w-full rounded-2xl border border-line bg-ink-800/90 p-2.5 shadow-panel backdrop-blur-xl"
    >
      {/* drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-brand/60 bg-ink-900/85 backdrop-blur-sm">
          <Upload className="h-6 w-6 text-brand" />
          <p className="text-sm font-medium text-white/90">
            Drop images or video to add as references
          </p>
        </div>
      )}
      {pickingClips && <VideoRefPicker onClose={() => setPickingClips(false)} />}

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
          {s.referenceVideos.map((ref, i) => (
            <span
              key={ref}
              className="flex items-center gap-1.5 rounded-lg bg-ink-750 py-1 pl-2 pr-1 text-xs text-white/75 ring-1 ring-line"
              title={`Reference clip ${i + 1} — type @vid${i + 1} to point at it`}
            >
              <Clapperboard className="h-3.5 w-3.5 text-brand" />
              @vid{i + 1}
              <button
                onClick={() => s.removeReferenceVideo(i)}
                className="grid h-4 w-4 place-items-center rounded text-white/40 hover:bg-white/10 hover:text-white"
                aria-label={`Remove reference clip ${i + 1}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* reference thumbnails — click to insert its @imgN tag into the prompt,
          drag to reorder. @imgN is a live index into referenceImages (see
          resolveReferences in mentions.ts), so reordering renumbers any
          @imgN already typed in the prompt via s.reorderReferences to keep
          each tag pointing at the same image. */}
      {dragRefs.length > 0 && (
        <Reorder.Group
          as="div"
          axis="x"
          values={dragRefs}
          onReorder={(newOrder) => {
            dragRefsRef.current = newOrder;
            setDragRefs(newOrder);
          }}
          className="scroll-none mb-2 flex gap-2 overflow-x-auto px-1 pb-1"
        >
          {dragRefs.map((src, i) => (
            <Reorder.Item
              key={src}
              value={src}
              as="div"
              // Without this the browser's own scroll/pan gesture on the
              // (overflow-x-auto) row competes with Framer's pointer-based
              // drag for the same horizontal axis — the trackpad/Magic Mouse
              // case that made this feel unreliable: some drags started a
              // page-scroll gesture instead of picking the tile up.
              style={{ touchAction: "none" }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              whileDrag={{ scale: 1.05, zIndex: 1 }}
              // dragRefsRef.current rather than the dragRefs closure: the
              // final onReorder tick and this onDragEnd can fire within the
              // same gesture-end dispatch, before React has re-rendered with
              // the last setDragRefs — reading the ref instead of the closed-
              // over state guarantees the store gets the settled order.
              onDragEnd={() => s.reorderReferences(dragRefsRef.current)}
              title={`Insert @img${i + 1} — drag to reorder`}
              className="group relative h-16 w-16 shrink-0 cursor-grab overflow-hidden rounded-lg ring-1 ring-line transition hover:ring-brand/50 active:cursor-grabbing"
              onClick={() => mentionRef.current?.insertTag(`@img${i + 1}`)}
            >
              {/* draggable=false + -webkit-user-drag:none: an <img> is
                  natively draggable in every browser, and that native
                  "drag the image out" gesture starts on the same mousedown
                  Framer needs to detect a reorder drag — whichever one wins
                  the race varies by OS/input device, which is exactly the
                  "sometimes it just doesn't grab" symptom. Suppressing the
                  native drag leaves the pointer event free for Framer. */}
              <img
                src={src}
                alt=""
                draggable={false}
                style={{ WebkitUserDrag: "none" } }
                className="h-full w-full object-cover"
              />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-semibold text-brand backdrop-blur-sm">
                @img{i + 1}
              </span>
              {/* This is still an @imgN tag functionally — @vid1 already
                  means something else entirely (an attached video-to-video
                  clip, see VideoRefPicker) — this badge just flags "this
                  particular image was a frame grabbed from a video file",
                  cosmetic only. */}
              {s.referenceKinds[i] === "video" && (
                <span
                  title="Extracted from a video file"
                  className="absolute left-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/85"
                >
                  <Clapperboard className="h-2.5 w-2.5" />
                </span>
              )}
              <span
                role="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  s.removeReference(i);
                }}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/90 opacity-0 transition group-hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      )}

      {/* @audioN chips — filename-only tags, no real attachment (see
          audioNotes' comment in store.js): clicking inserts the tag into the
          prompt text the same way an @imgN thumbnail does, but there is no
          file, upload, or provider on the other end of it. */}
      {s.audioNotes.length > 0 && (
        <div className="scroll-none mb-2 flex gap-2 overflow-x-auto px-1 pb-1">
          {s.audioNotes.map((name, i) => (
            <div
              key={`${name}-${i}`}
              title={name}
              className="group relative flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg bg-ink-750 px-1 ring-1 ring-line transition hover:ring-brand/50"
            >
              <button
                onClick={() => mentionRef.current?.insertTag(`@audio${i + 1}`)}
                className="flex flex-1 flex-col items-center justify-center gap-1"
              >
                <AudioLines className="h-4 w-4 text-brand" />
                <span className="line-clamp-1 w-full text-center text-[9px] leading-tight text-white/60">
                  {name}
                </span>
              </button>
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-semibold text-brand backdrop-blur-sm">
                @audio{i + 1}
              </span>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  s.removeAudioNote(i);
                }}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/90 opacity-0 transition group-hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </span>
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

      {/* Multi-shot chaining (Phase 3.3) — set by continueShot (DetailModal's
          "Continue this shot" button), not a standing preference. Shown so
          the user isn't puzzled why an otherwise-ordinary video request is
          actually starting from a specific frame; dismissible without
          discarding the rest of the composer's state. */}
      {s.continuationFrame && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] leading-snug text-brand/90">
          <img
            src={s.continuationFrame}
            alt="Continuation starting frame"
            className="h-8 w-8 shrink-0 rounded object-cover"
          />
          <SkipForward className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Continuing from this frame — write what happens next.
          </span>
          <button
            type="button"
            onClick={() => s.setContinuationFrame(null)}
            className="shrink-0 rounded p-0.5 text-brand/70 hover:bg-brand/20 hover:text-brand"
            aria-label="Remove continuation frame"
            title="Remove continuation frame"
          >
            <X className="h-3.5 w-3.5" />
          </button>
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
              <MenuItem disabled>
                <Images className="h-4 w-4" /> Portrait Gallery
              </MenuItem>
            </>
          )}
        </Dropdown>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={onFiles}
        />

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
            if (s.prompt.length > maxPromptLength) return;
            s.generate();
          }}
          assets={s.assets}
          references={s.referenceImages}
          videoRefs={s.referenceVideos}
          maxLength={maxPromptLength}
          placeholder={
            s.mode === "image"
              ? "Describe the image… type @ to reference uploaded images (@img1, @img2)."
              : "Describe the video… type @ to reference uploaded images (@img1, @img2)."
          }
        />
      </div>

      {/* toolbar */}
      <div className="mt-2 flex min-w-0 items-center gap-2">
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
                    if (m.id === "image" || m.id === "video" || m.id === "depth") s.setMode(m.id);
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
                {videoTaskMode === "generate" ? s.aspectRatio : "Adaptive"}
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
            </Chip>
          )}
        >
          {() => (
            <div className="space-y-3">
              {/* Edit/Extend only exist on Seedance 2.5 — BytePlus infers the
                  task type from this plus an attached reference clip, not a
                  request field (see providers/seedance.js). */}
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
              {videoTaskMode === "generate" ? (
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
                    Adaptive — matches the reference clip
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
            const folder = proj?.folders.find((f) => f.id === s.activeFolderId);
            return (
              <Chip open={open}>
                <FolderClosed className="h-4 w-4 text-white/55" />
                <span className="composer-project-label max-w-[110px] truncate font-medium">
                  {proj ? proj.name : "No project"}
                </span>
                <span className="composer-folder-separator text-white/35">/</span>
                <span className="composer-folder-label max-w-[80px] truncate">
                  {folder ? folder.name : "All"}
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
            return (
              <div>
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                  Project
                </p>
                {s.projects.map((p) => (
                  <MenuItem
                    key={p.id}
                    active={p.id === s.activeProjectId}
                    onClick={() => s.setActiveProject(p.id)}
                  >
                    <Layers className="h-4 w-4 text-white/45" />
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.id === s.activeProjectId && <Check className="h-4 w-4 text-brand" />}
                  </MenuItem>
                ))}
                <MenuItem
                  onClick={() => {
                    const name = window.prompt("New project name");
                    if (name?.trim()) s.createProject(name.trim());
                  }}
                >
                  <Plus className="h-4 w-4 text-white/60" />
                  <span className="flex-1">New project</span>
                </MenuItem>
                {proj && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                      Folder
                    </p>
                    <MenuItem
                      active={s.activeFolderId === null}
                      onClick={() => s.setActiveFolder(null)}
                    >
                      <Layers className="h-4 w-4 text-white/45" />
                      <span className="flex-1">All assets</span>
                      {s.activeFolderId === null && <Check className="h-4 w-4 text-brand" />}
                    </MenuItem>
                    {proj.folders.map((f) => (
                      <MenuItem
                        key={f.id}
                        active={s.activeFolderId === f.id}
                        onClick={() => s.setActiveFolder(f.id)}
                      >
                        <FolderClosed className="h-4 w-4 text-white/45" />
                        <span className="flex-1 truncate">{f.name}</span>
                        {s.activeFolderId === f.id && <Check className="h-4 w-4 text-brand" />}
                      </MenuItem>
                    ))}
                  </>
                )}
              </div>
            );
          }}
        </Dropdown>

        </div>

        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={() => s.generate()}
          disabled={!s.prompt.trim() || s.generating || s.prompt.length > maxPromptLength}
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-all duration-200",
            s.prompt.trim() && !s.generating && s.prompt.length <= maxPromptLength
              ? "bg-gradient-to-br from-brand to-accent text-ink-900 shadow-glow hover:brightness-110"
              : "cursor-not-allowed bg-ink-650 text-white/30"
          )}
          aria-label="Generate"
          title={s.prompt.length > maxPromptLength ? `Prompt exceeds the ${maxPromptLength.toLocaleString()}-character limit` : undefined}
        >
          {s.generating ? (
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
