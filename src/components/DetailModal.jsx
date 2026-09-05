import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { motion } from "framer-motion";
import {
  X,
  Download,
  Copy,
  Check,
  Trash2,
  Box,
  Sparkles,
  Play,
  ImagePlus,
  Star,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Layers,
  RefreshCw,
  SkipForward,
  Flag,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn, inlineMediaUrl, thumbUrl } from "@/lib/utils";
import { apiUrl } from "@/lib/api";
import { DEPTH_ENCODER_LABELS } from "@/lib/config";
import { supportsFirstFrameContinuation, supportsVideoReference } from "@/lib/config";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { useConfirmedAction } from "./useConfirmedAction";
import {
  hasFullscreenMedia,
  settleFullscreenBeforeMediaMutation,
} from "@/lib/fullscreen-guard";

/** Prompt in the details sidebar: minimized by default, hover reveals an
 *  expand cue in the top-right corner (same pattern as the feed). Keyed by
 *  item id upstream so switching items re-collapses. */
function DetailPrompt({ text }) {
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(
    text.length > 220 || text.split("\n").length > 3
  );
  const textRef = useRef(null);
  const contentId = useId();

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const next = element.scrollHeight > 73;
      setCollapsible(next);
      if (!next) setExpanded(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <motion.div layout className="group/dprompt relative mb-5">
      <motion.div
        id={contentId}
        initial={false}
        animate={{ height: collapsible && !expanded ? "4.5rem" : "auto" }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="overflow-hidden"
      >
        <p
          ref={textRef}
          className="whitespace-pre-wrap pr-8 text-sm leading-6 text-white/80"
        >
          {text}
        </p>
      </motion.div>
      {collapsible && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="absolute -top-1 right-0 flex items-center gap-1 rounded-md bg-ink-700/95 px-1.5 py-1 text-[10px] font-medium text-white/70 opacity-100 ring-1 ring-line backdrop-blur-sm transition-opacity hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 sm:opacity-0 sm:group-hover/dprompt:opacity-100 sm:focus-visible:opacity-100"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded ? "Collapse prompt" : "Expand prompt"}
          title={expanded ? "Collapse prompt" : "Show full prompt"}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Collapse
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Expand
            </>
          )}
        </button>
      )}
    </motion.div>
  );
}

function CopyPromptButton({ text }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard permission denied or unavailable — no-op
        }
      }}
      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      aria-label="Copy prompt"
      title="Copy prompt"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-emerald-400" /> Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" /> Copy
        </>
      )}
    </button>
  );
}

function ReferenceCollage({ images }) {
  // Every reference is shown — this panel scrolls (its parent carries
  // overflow-y-auto), so there's no layout reason to truncate. This used to
  // slice(0, 4) and print a "+N more" count for the rest with no way to
  // actually open them, so a job with more than 4 references had references
  // the user could never see or click through to.
  const layoutClass = images.length === 1 ? "grid-cols-1" : "grid-cols-2";

  return (
    <div className="mb-5">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
        Reference images
      </p>
      <div className={cn("grid gap-2", layoutClass)}>
        {images.map((src, i) => (
          <a
            key={i}
            href={src}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group relative overflow-hidden rounded-xl border border-line bg-ink-700 ring-1 ring-white/5 transition hover:border-brand/40 hover:ring-brand/20",
              images.length === 2 && "min-h-24"
            )}
            title="Open reference image"
          >
            <img src={thumbUrl(src, 320)} alt="" className="h-full w-full object-cover" />
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
          </a>
        ))}
      </div>
    </div>
  );
}

export function DetailModal() {
  const activeId = useStore((s) => s.activeId);
  const items = useStore((s) => s.items);
  const gridColumns = useStore((s) => s.gridColumns);
  // rightTab/search/filterKind are no longer read here: the feed arrives
  // already filtered and ordered by those, so re-deriving them would only
  // create a second, drifting definition of the same list.
  const setActiveId = useStore((s) => s.setActiveId);
  const cloneToComposer = useStore((s) => s.cloneToComposer);
  const regenerateWithSameSeed = useStore((s) => s.regenerateWithSameSeed);
  const continueShot = useStore((s) => s.continueShot);
  const addReferenceFromUrl = useStore((s) => s.addReferenceFromUrl);
  const addReferenceFromVideo = useStore((s) => s.addReferenceFromVideo);
  const addReferenceVideo = useStore((s) => s.addReferenceVideo);
  const model = useStore((s) => s.model);
  const setMode = useStore((s) => s.setMode);
  const removeItem = useStore((s) => s.removeItem);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const toggleFlag = useStore((s) => s.toggleFlag);
  const confirmation = useConfirmedAction();
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const suppressNextNativeFullscreenEscapeRef = useRef(false);
  const escapeCloseTimerRef = useRef(null);

  // `items` is already the scope the user is looking at — server-filtered and
  // in the same order the grid renders — so Left/Right (reading order) just
  // walks it. The old per-tab re-filter and re-sort here duplicated the
  // panel's rules and had already drifted from them (it sorted favourites by
  // favoritedAt but the grid did not), which showed up as arrow-key
  // navigation jumping to a different image than the one visually next to
  // the current card.
  const item = items.find((i) => i.id === activeId) || null;
  const navigableItems = useMemo(
    () =>
      items.filter(
        (candidate) =>
          candidate.status === "succeeded" && Boolean(candidate.url || candidate.poster)
      ),
    [items]
  );

  // Up/Down can't reuse flat `items` order the way Left/Right does: the grid
  // is a packed masonry (AssetGrid's packColumns), so the item immediately
  // before/after the current one in list order usually lands in a *different*
  // column at a similar row, not the card visually above/below it — pressing
  // Up would as often show something below as above. `gridColumns` is the
  // actual column assignment AssetGrid just rendered, published live via the
  // store; each column is filtered down to navigable ids (preserving order)
  // so the placeholder/failed cards the grid also renders don't break the
  // walk. Falls back to flat order (same as Left/Right) when the active item
  // isn't in any column — DetailModal can be opened from views with no grid
  // mounted at all, e.g. a chat thread.
  const navigableColumns = useMemo(
    () => {
      const navigableIds = new Set(navigableItems.map((i) => i.id));
      return gridColumns
        .map((col) => col.filter((id) => navigableIds.has(id)))
        .filter((col) => col.length > 0);
    },
    [gridColumns, navigableItems]
  );

  useEffect(() => {
    if (!activeId) return;
    if (escapeCloseTimerRef.current) {
      window.clearTimeout(escapeCloseTimerRef.current);
      escapeCloseTimerRef.current = null;
    }
    closingRef.current = false;
    setClosing(false);
    return () => {
      if (escapeCloseTimerRef.current) {
        window.clearTimeout(escapeCloseTimerRef.current);
        escapeCloseTimerRef.current = null;
      }
    };
  }, [activeId]);

  useEffect(() => {
    const video = document.querySelector("[data-detail-video]");
    if (!video) return undefined;
    const onBeginFullscreen = () => {
      suppressNextNativeFullscreenEscapeRef.current = true;
    };
    const onEndFullscreen = () => {
      // Safari can deliver the Escape key to the page after it has already
      // flipped webkitDisplayingFullscreen to false but before the native
      // transition has handed control back. The next page-level Escape is the
      // replay of that native action and is consumed exactly once below.
      suppressNextNativeFullscreenEscapeRef.current = true;
    };
    video.addEventListener("webkitbeginfullscreen", onBeginFullscreen);
    video.addEventListener("webkitendfullscreen", onEndFullscreen);
    return () => {
      suppressNextNativeFullscreenEscapeRef.current = false;
      video.removeEventListener("webkitbeginfullscreen", onBeginFullscreen);
      video.removeEventListener("webkitendfullscreen", onEndFullscreen);
    };
  }, [item?.id]);

  // Never unmount a native-fullscreen video until the browser has completed
  // its exit paints. The old workaround returned after exitFullscreen(), so
  // one Escape merely exited fullscreen and a close during that transition
  // could still leave Chrome's page hit-testing wedged until reload.
  const closeModal = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      await settleFullscreenBeforeMediaMutation();
      // Safari may pause React's queued work after returning from native video
      // fullscreen. The media is now conclusively out of fullscreen, so commit
      // this single teardown synchronously instead of leaving a dead viewer
      // mounted until some unrelated interaction wakes the scheduler.
      flushSync(() => setActiveId(null));
    } catch {
      // Keep the viewer mounted when the browser refuses to leave fullscreen;
      // removing the active media in this state is what wedges page input.
      closingRef.current = false;
      setClosing(false);
    }
  }, [setActiveId]);

  useEffect(() => {
    if (!item) return;
    const onKeyDown = (event) => {
      if (confirmation.dialogProps.open) return;
      if (event.key === "Escape") {
        // Native fullscreen owns the first Escape. Starting closeModal while
        // Safari is still handing the video back to the page can freeze its
        // scheduled paint/timer work forever, leaving the viewer mounted with
        // pointer-events disabled. Once fullscreen has exited, a second Escape
        // (or the visible close button) performs the normal guarded teardown.
        if (hasFullscreenMedia()) return;
        if (suppressNextNativeFullscreenEscapeRef.current) {
          suppressNextNativeFullscreenEscapeRef.current = false;
          return;
        }
        if (item.kind === "video" || item.kind === "depth") {
          if (escapeCloseTimerRef.current) return;
          // Safari may already report native fullscreen as false while the
          // same Escape is still transferring control back to the page. Defer
          // video teardown until that handoff has finished, then recheck.
          escapeCloseTimerRef.current = window.setTimeout(() => {
            escapeCloseTimerRef.current = null;
            if (!hasFullscreenMedia()) {
              void closeModal();
            }
          }, 400);
          return;
        }
        void closeModal();
        return;
      }
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const isVertical = event.key === "ArrowUp" || event.key === "ArrowDown";
      const isHorizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (!isVertical && !isHorizontal) return;
      // While a video is fullscreen, arrow keys belong to its native controls.
      // Swapping the active item here would unmount the fullscreen element.
      if (hasFullscreenMedia()) return;
      const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;

      if (isVertical) {
        const column = navigableColumns.find((col) => col.includes(item.id));
        if (column && column.length > 1) {
          event.preventDefault();
          const currentIndex = column.indexOf(item.id);
          const nextIndex = (currentIndex + delta + column.length) % column.length;
          setActiveId(column[nextIndex]);
          return;
        }
        // No column info (or a lone item in its column) — fall through to
        // the same flat-order walk Left/Right uses, rather than doing
        // nothing.
      }

      if (navigableItems.length < 2) return;
      event.preventDefault();
      const currentIndex = navigableItems.findIndex(
        (candidate) => candidate.id === item.id
      );
      const nextIndex =
        (currentIndex + delta + navigableItems.length) % navigableItems.length;
      setActiveId(navigableItems[nextIndex].id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeModal, confirmation.dialogProps.open, item, navigableItems, navigableColumns, setActiveId]);

  return (
    <>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className={cn(
            "fixed inset-0 z-[60] flex items-stretch justify-center bg-black/80 backdrop-blur-md",
            closing && "pointer-events-none"
          )}
          onClick={() => void closeModal()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="relative flex h-full w-full flex-col lg:flex-row"
          >
            {/* media stage */}
            <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-4 sm:p-8">
              <button
                onClick={() => void closeModal()}
                aria-label="Close viewer"
                className="absolute left-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white/90 backdrop-blur hover:bg-white/20"
              >
                <X className="h-5 w-5" />
              </button>

              <div className="h-full min-h-0 w-full max-w-5xl overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
                {item.kind === "image" && item.url && (
                  <img
                    src={apiUrl(item.url)}
                    alt={item.prompt}
                    className="h-full w-full object-contain"
                  />
                )}
                {item.kind === "video" && (
                  <video
                    data-detail-video
                    src={apiUrl(item.url)}
                    poster={apiUrl(item.poster)}
                    controls
                    autoPlay
                    loop
                    playsInline
                    className="h-full w-full object-contain"
                  />
                )}
                {item.kind === "depth" && item.url && (
                  <video
                    data-detail-video
                    src={apiUrl(item.url)}
                    controls
                    autoPlay
                    loop
                    playsInline
                    className="h-full w-full object-contain"
                  />
                )}
              </div>
            </div>

            {/* info panel */}
            <aside className="flex max-h-[52dvh] min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-line bg-ink-850 lg:max-h-none lg:w-[clamp(20rem,25vw,24rem)] lg:border-l lg:border-t-0">
              <div className="scroll-thin flex flex-1 flex-col overflow-y-auto p-5 pb-6">
              <div className="mb-4 flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand/30 to-accent/10 ring-1 ring-brand/30">
                  {item.kind === "image" ? (
                    <Sparkles className="h-4 w-4 text-brand" />
                  ) : item.kind === "depth" ? (
                    <Layers className="h-4 w-4 text-brand" />
                  ) : (
                    <Play className="h-4 w-4 text-brand" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{item.model}</p>
                  <p className="text-xs capitalize text-white/45">{item.kind} generation</p>
                </div>
                <button
                  onClick={() => toggleFlag(item.id)}
                  className={cn(
                    "ml-auto grid h-8 w-8 place-items-center rounded-lg border transition",
                    item.flagged
                      ? "border-red-400/35 bg-red-500/15 text-red-300"
                      : "border-line bg-ink-700 text-white/55 hover:text-white"
                  )}
                  aria-label={
                    item.flagged
                      ? "Unflag this generation"
                      : "Flag this generation for quality review"
                  }
                  title={
                    item.flagged
                      ? item.flagReason
                        ? `Flagged: ${item.flagReason}`
                        : "Flagged — click to unflag"
                      : "Flag this generation for quality review"
                  }
                >
                  <Flag className={cn("h-4 w-4", item.flagged && "fill-current")} />
                </button>
                <button
                  onClick={() => toggleFavorite(item.id)}
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded-lg border transition",
                    item.isFavorite
                      ? "border-amber-300/35 bg-amber-400/15 text-amber-300"
                      : "border-line bg-ink-700 text-white/55 hover:text-white"
                  )}
                  aria-label={
                    item.isFavorite ? "Remove from favourites" : "Add to favourites"
                  }
                  title={item.isFavorite ? "Remove from favourites" : "Add to favourites"}
                >
                  <Star
                    className={cn("h-4 w-4", item.isFavorite && "fill-current")}
                  />
                </button>
              </div>
              {item.flagged && (
                <div className="mb-5 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-red-300">
                    <Flag className="h-3 w-3 fill-current" /> Flagged for review
                  </p>
                  {item.flagReason && (
                    <p className="mt-1 text-xs text-red-200/80">{item.flagReason}</p>
                  )}
                </div>
              )}

              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
                Parameters
              </p>
              <div className="mb-6 grid grid-cols-2 gap-2">
                <Param label="Aspect" value={item.aspectRatio} />
                {item.kind === "depth" ? (
                  <>
                    {item.resolution && (
                      <Param
                        label="Quality"
                        value={DEPTH_ENCODER_LABELS[item.resolution]?.label ?? item.resolution}
                      />
                    )}
                    {item.trackCharacters && (
                      <Param label="Character tracking" value="On" />
                    )}
                  </>
                ) : (
                  item.resolution && <Param label="Resolution" value={item.resolution} />
                )}
                {item.duration && <Param label="Duration" value={`${item.duration}s`} />}
                <Param label="Model" value={item.model} icon={<Box className="h-3.5 w-3.5" />} />
                {item.seed != null && <Param label="Seed" value={item.seed} />}
              </div>

              {item.referenceImages && item.referenceImages.length > 0 && (
                <ReferenceCollage images={item.referenceImages} />
              )}

              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-white/40">
                  Prompt
                </p>
                <CopyPromptButton text={item.prompt} />
              </div>
              <DetailPrompt key={item.id} text={item.prompt} />
              </div>

              {/* sticky bottom actions */}
              <div className="flex flex-col gap-2 p-5 pt-2 border-t border-white/5 bg-ink-850/95 backdrop-blur z-10 shadow-[0_-10px_20px_rgba(0,0,0,0.2)]">
                {item.kind === "image" && item.url && (
                  <button
                    onClick={() => {
                      addReferenceFromUrl(item.url);
                      setMode("image");
                      setActiveId(null);
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/15 py-2.5 text-sm font-semibold text-brand hover:bg-brand/25"
                    title="Add this image as a reference — generate a clean hero, then place them in a crowd"
                  >
                    <ImagePlus className="h-4 w-4" /> Use as reference
                  </button>
                )}
                {/* Videos get the same affordance via a still frame. No
                    provider here accepts a video as input, but the frame the
                    user is currently paused on is an ordinary image reference,
                    which every model does accept — so this is how a clip feeds
                    back into the next generation. */}
                {item.kind === "video" && item.url && (
                  <button
                    onClick={() => {
                      const video = document.querySelector(
                        "[data-detail-video]"
                      );
                      // Take the frame the user is actually looking at; fall
                      // back to the library default if the element is gone.
                      addReferenceFromVideo(item.url, video?.currentTime);
                      setActiveId(null);
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/15 py-2.5 text-sm font-semibold text-brand hover:bg-brand/25"
                    title="Grab the current frame and add it to the composer as a reference image"
                  >
                    <ImagePlus className="h-4 w-4" /> Use this frame as reference
                  </button>
                )}
                {/* Multi-shot chaining (Phase 3.3) — extracts the LAST frame
                    (not "the frame you're paused on", unlike the button
                    above) and submits it as the next generation's starting
                    frame, so a sequence of shots can flow continuously.
                    Gated on the ITEM's own model, not the composer's current
                    one — continueShot switches the composer to item.model
                    itself, so the button's availability should track what
                    the source clip can actually continue from. */}
                {item.kind === "video" &&
                  item.url &&
                  supportsFirstFrameContinuation(item.model) && (
                    <button
                      onClick={() => {
                        confirmation.ask("continueShot", async () => {
                          const result = await continueShot(item.id);
                          if (result === false || result?.ok === false) return result;
                          setActiveId(null);
                          return true;
                        });
                      }}
                      className="flex items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/15 py-2.5 text-sm font-semibold text-brand hover:bg-brand/25"
                      title="Start a new video from this clip's last frame — write what happens next"
                    >
                      <SkipForward className="h-4 w-4" /> Continue this shot
                    </button>
                  )}
                {/* True video-to-video, BytePlus only. Gated on the model the
                    composer is set to, because it is the only one with a
                    reference_video field — offering it otherwise would attach a
                    clip that the provider silently ignores. */}
                {item.kind === "video" && item.url && supportsVideoReference(model) && (
                  <button
                    onClick={() => {
                      addReferenceVideo(item.url);
                      setMode("video");
                      setActiveId(null);
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-line bg-white/[0.06] py-2.5 text-sm font-semibold text-white/85 hover:bg-white/[0.1]"
                    title="Use this whole clip as a video reference (Seedance 2.0 video-to-video)"
                  >
                    <Clapperboard className="h-4 w-4" /> Use clip as video reference
                  </button>
                )}
                <button
                  onClick={() => {
                    confirmation.ask("cloneToComposer", async () => {
                      const result = await cloneToComposer(item.id);
                      if (result === false || result?.ok === false) return result;
                      setActiveId(null);
                      return true;
                    });
                  }}
                  className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-accent py-2.5 text-sm font-semibold text-ink-900 shadow-glow hover:brightness-110"
                >
                  <Copy className="h-4 w-4" /> Clone &amp; try
                </button>
                {/* Only offered when this row actually carries a seed —
                    config.supportsSeed models only (Nano Banana Pro, native
                    BytePlus Seedance), and only rows generated after Phase
                    3.1 shipped. Distinct from Clone & try: this pins the
                    ORIGINAL seed rather than starting a fresh render, so the
                    two buttons produce deliberately different results. */}
                {item.seed != null && (
                  <button
                    onClick={() => {
                      confirmation.ask("regenerateWithSameSeed", async () => {
                        const result = await regenerateWithSameSeed(item.id);
                        if (result === false || result?.ok === false) return result;
                        setActiveId(null);
                        return true;
                      });
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-line bg-white/[0.06] py-2.5 text-sm font-semibold text-white/85 hover:bg-white/[0.1]"
                    title={`Regenerate using the same seed (${item.seed}) for a reproducible result`}
                  >
                    <RefreshCw className="h-4 w-4" /> Regenerate (same seed)
                  </button>
                )}
                <div className="flex gap-2">
                  {item.url && (
                    <a
                      href={inlineMediaUrl(item.url)}
                      download
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-ink-700 py-2.5 text-sm text-white/80 hover:text-white"
                    >
                      <Download className="h-4 w-4" /> Download
                    </a>
                  )}
                  <button
                    onClick={() => {
                      confirmation.ask("deleteGeneration", async () => {
                        const result = await removeItem(item.id);
                        if (result === false || result?.ok === false) return result;
                        setActiveId(null);
                        return true;
                      });
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-line bg-ink-700 px-4 py-2.5 text-sm text-red-300/80 hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </aside>
          </motion.div>
        </motion.div>
      )}
      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}

function Param({
  label,
  value,
  icon,
}

) {
  return (
    <div className="rounded-lg border border-line bg-ink-800 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-white/35">{label}</p>
      <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-white/85">
        {icon}
        {value}
      </p>
    </div>
  );
}
