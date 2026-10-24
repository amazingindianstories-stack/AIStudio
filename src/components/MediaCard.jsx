"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  BadgeCheck,
  CheckSquare,
  Download,
  FolderOpen,
  Layers,
  Maximize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Square,
  Star,
  Trash2,
  Wand2,
  Check,
} from "lucide-react";

import { useMaintenance } from "@/lib/maintenance-client";
import { MAINTENANCE_MESSAGE } from "@/lib/maintenance";
import { UNSORTED } from "@/lib/feed-scope";
import { useStore } from "@/lib/store";
import { useDirectMediaUrl } from "@/lib/media-resolver";
import { aspectToPadding, cn, generationDownloadUrl } from "@/lib/utils";
import { useNearViewport } from "@/lib/use-near-viewport";
import { validateDraftForFinalization } from "@/lib/seedance-finalization";
import { CardContextMenu } from "./CardContextMenu";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { CreatorAvatar, GenerationDetails } from "./GenerationDetails";
import { useConfirmedAction } from "./useConfirmedAction";
import { ProgressiveImage } from "./ProgressiveImage";
import { GenerationStatus, waitingNote } from "./GenerationStatus";
import { setAssetDragData } from "@/lib/asset-drag-contract";

// Grid cards render at ~160–320 CSS px; request a modest fixed width
// (covers up to ~2x device pixel ratio at the larger end) instead of the
// full-resolution original.
const CARD_THUMB_WIDTH = 480;

// Touch has no right click: holding a card this long opens its menu instead.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/** Fixed milestone sequence worker.py's _report_progress calls send, in
 *  order — see depth-worker/worker.py's _process_job/_run_depth. Matched by
 *  exact message text since the worker has no structured step enum; always
 *  7 steps (compositing vs. encoding are mutually exclusive on
 *  trackCharacters, never both fire). Cosmetic, not load-bearing — an
 *  unrecognized message just omits the step count rather than breaking. */
function depthStepList(trackCharacters) {
  return [
    "Downloading input video",
    "Loading model",
    "Reading input video",
    "Running depth estimation",
    trackCharacters ? "Compositing character tracking" : "Encoding output video",
    "Requesting an upload slot",
    "Uploading result",
  ];
}
const DEPTH_STEP_COUNT = 7;

/** Live mm:ss ticking off item.createdAt — "how long this has been
 *  running", not a predictive ETA (nothing here tracks past-job durations
 *  to estimate one from). */
function ElapsedTime({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const totalSeconds = Math.max(0, Math.floor((now - since) / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return (
    <span title="Elapsed time (not an estimated time remaining)">
      Elapsed {mm}:{ss}
    </span>
  );
}

/** A library card is the media and very little else: the creator's avatar,
 *  "Draft" on drafts, a star on favourites, and - on hover or keyboard focus -
 *  a select checkbox, a "..." button and the favourite toggle. Everything else (details and actions) lives in the card's
 *  context menu, opened by right click, the "..." button, the keyboard
 *  (ContextMenu key or Shift+F10) or a long press on touch. The face scales
 *  with the card's rendered width through the container queries on
 *  .media-card-body in globals.css. */
export function MediaCard({
  item,
  selectable = false,
}

) {
  const isAdmin = useStore((s) => s.currentUser?.role === "admin");
  const reducedMotion = useReducedMotion();
  const setActiveId = useStore((s) => s.setActiveId);
  // A selectable card sits in the library grid and steps through that grid;
  // a lone card (inline in a chat) has no list around it.
  const viewerSource = selectable ? "feed" : "single";
  const removeItem = useStore((s) => s.removeItem);
  const retryTextToVideo = useStore((s) => s.retryTextToVideo);
  const regenerate = useStore((s) => s.regenerate);
  const cloneToComposer = useStore((s) => s.cloneToComposer);
  const finalizeDraft = useStore((s) => s.finalizeDraft);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const libraryTree = useStore((s) => s.libraryTree);
  const generating = useStore((s) => s.generating);
  const selected = useStore((s) => s.selectedIds.includes(item.id));
  const focusedAssetId = useStore((s) => s.focusedAssetId);
  const isFocused = focusedAssetId === item.id;
  const isRovingTabTarget = useStore((s) =>
    s.focusedAssetId ? s.focusedAssetId === item.id : s.items[0]?.id === item.id
  );
  const setFocusedAssetId = useStore((s) => s.setFocusedAssetId);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const isDraggingRef = useRef(false);
  const [isCardDragging, setIsCardDragging] = useState(false);
  const creator = useStore((s) =>
    item.userId ? s.usersById[item.userId] : undefined
  );
  const confirmation = useConfirmedAction();
  const [unplayableUrl, setUnplayableUrl] = useState(null);

  const pending = item.status === "running" || item.status === "queued";
  const failed = item.status === "failed";
  const done = item.status === "succeeded";
  const isDraft = item.kind === "video" && item.draftMode === true;
  // Media loads straight from storage once resolved; /api/media is the fallback.
  const imageMedia = useDirectMediaUrl(done && item.kind === "image" ? item.url : null, CARD_THUMB_WIDTH);
  const posterMedia = useDirectMediaUrl(done && item.poster ? item.poster : null, CARD_THUMB_WIDTH);
  const videoMedia = useDirectMediaUrl(done && (item.kind === "video" || item.kind === "depth") ? item.url : null);
  const depthStepIndex =
    item.kind === "depth" && item.progressMessage
      ? depthStepList(item.trackCharacters).indexOf(item.progressMessage) + 1 || null
      : null;

  // Only cards near the viewport mount a real <video>. An infinite feed can
  // hold hundreds of them, and each one that stays mounted holds a decoder and
  // its buffered metadata for the rest of the session — see use-near-viewport.
  const cardRef = useRef(null);
  const moreRef = useRef(null);
  const nearViewport = useNearViewport(cardRef);

  // ── context menu ──────────────────────────────────────────────────────
  // `menu` holds the anchor rect (a zero-size rect at the pointer, or the
  // "..." button's rect) captured when it opened.
  const [menu, setMenu] = useState(null);
  const longPressRef = useRef(null);
  const suppressClickRef = useRef(false);
  const openedAtRef = useRef(0);

  const openMenu = useCallback((anchor, { gap = 0, focusFirst = false } = {}) => {
    openedAtRef.current = Date.now();
    setMenu({ anchor, gap, focusFirst });
  }, []);
  const openAtPoint = useCallback((x, y, options) => {
    openMenu({ left: x, right: x, top: y, bottom: y }, options);
  }, [openMenu]);
  const openFromButton = useCallback((focusFirst) => {
    const rect = (moreRef.current || cardRef.current)?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, { gap: 4, focusFirst });
  }, [openMenu]);
  const closeMenu = useCallback(({ restoreFocus = false } = {}) => {
    setMenu(null);
    if (restoreFocus) cardRef.current?.focus({ preventScroll: true });
  }, []);

  const cancelLongPress = () => {
    clearTimeout(longPressRef.current?.timer);
    longPressRef.current = null;
  };
  useEffect(() => () => clearTimeout(longPressRef.current?.timer), []);

  const handlePointerDown = (e) => {
    suppressClickRef.current = false;
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    cancelLongPress();
    const { clientX: x, clientY: y } = e;
    longPressRef.current = {
      x,
      y,
      timer: setTimeout(() => {
        longPressRef.current = null;
        // The finger lifting next must not also open the viewer.
        suppressClickRef.current = true;
        openAtPoint(x, y);
      }, LONG_PRESS_MS),
    };
  };
  const handlePointerMove = (e) => {
    const press = longPressRef.current;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) cancelLongPress();
  };

  const handleDragStart = (e) => {
    cancelLongPress();
    setMenu(null);
    isDraggingRef.current = true;
    setIsCardDragging(true);

    const s = useStore.getState();
    const selectedIds = s.selectedIds;
    const isMulti = selectedIds.includes(item.id) && selectedIds.length > 1;
    const dragItems = isMulti
      ? s.items.filter((i) => selectedIds.includes(i.id))
      : [item];

    setAssetDragData(e.dataTransfer, dragItems, item);
    s.setDraggedAssets({ items: dragItems, primaryItem: item });
  };

  const handleDragEnd = () => {
    setIsCardDragging(false);
    useStore.getState().clearDraggedAssets();
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 120);
  };

  const handleClick = (e) => {
    if (isDraggingRef.current) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    if (selectable && (e.metaKey || e.ctrlKey)) {
      toggleSelect(item.id);
    } else if (selectable && e.shiftKey) {
      const itemIds = useStore.getState().items.map((i) => i.id);
      selectRange(item.id, itemIds);
    } else if (done) {
      // A normal click on a finished card opens the viewer.
      setActiveId(item.id, viewerSource);
    } else {
      // Queued, rendering and failed cards have no viewer; their actions do.
      openAtPoint(e.clientX, e.clientY);
    }
  };

  const handleDoubleClick = () => {
    if (done) {
      setActiveId(item.id, viewerSource);
    }
  };

  const handleKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      e.stopPropagation();
      openFromButton(true);
    } else if (e.key === "Enter") {
      if (done) {
        e.preventDefault();
        e.stopPropagation();
        setActiveId(item.id, viewerSource);
      }
    } else if (e.key === " " && selectable) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelect(item.id);
    }
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelLongPress();
    // A keyboard open or a long press that already opened the menu can be
    // followed by the browser's own contextmenu event; that one is a repeat.
    if (menu && Date.now() - openedAtRef.current < 700) return;
    openAtPoint(e.clientX, e.clientY);
  };

  // ── menu contents ─────────────────────────────────────────────────────
  const ask = (kind, run) => () => confirmation.ask(kind, run);
  const folder = resolveGenerationFolder(item, libraryTree || {});
  const finalizeBlocked = isDraft && item.model === "Seedance 2.5" && done
    ? validateDraftForFinalization(item)
    : undefined;
  const downloadExtension = item.filename?.includes(".")
    ? item.filename.split(".").pop().toUpperCase()
    : null;
  const displayName = item.filename?.replace(/\.[^.]+$/, "") || "";
  // Only the ancestry stem may shrink. Keep the entire sequence, including
  // sequences longer than four digits, visible at every grid zoom level.
  const nameParts = displayName.match(/^([\s\S]*?)(_\d+)$/);
  const busyReason = "Another generation is starting - try again in a moment";
  const editable = item.kind !== "depth";

  const maintenance = useMaintenance((s) => s.enabled);
  const menuGroups = [
    [
      editable && (done || failed) && {
        key: "retry",
        label: "Retry",
        hint: "Generate again with the same prompt, settings and references",
        icon: RefreshCw,
        disabled: generating,
        reason: busyReason,
        onSelect: ask("regenerate", () => regenerate(item.id)),
      },
      failed && item.moderationBlocked && item.kind === "video" && {
        key: "retry-text",
        label: "Retry without references",
        hint: "Starts a new billable generation with all references removed",
        icon: Wand2,
        disabled: generating,
        reason: busyReason,
        onSelect: ask("retryTextToVideo", () => retryTextToVideo(item.id)),
      },
      // Depth rows have no image/video-shaped prompt/reference fields to restore.
      editable && {
        key: "edit",
        label: "Edit & retry",
        hint: "Load prompt, references and settings into the composer",
        icon: Pencil,
        onSelect: ask("editRetry", () => cloneToComposer(item.id)),
      },
      finalizeBlocked !== undefined && {
        key: "finalize",
        label: "Generate 1080p final",
        hint: "Render this draft again as the full 1080p final",
        icon: BadgeCheck,
        disabled: finalizeBlocked !== null,
        reason: finalizeBlocked,
        onSelect: ask("finalizeDraft", () => finalizeDraft(item.id)),
      },
    ],
    [
      done && {
        key: "open",
        label: "Open details",
        hint: "Open the viewer",
        icon: Maximize2,
        onSelect: () => setActiveId(item.id, viewerSource),
      },
      done && item.url && {
        key: "download",
        label: "Download",
        hint: item.filename ? `Download ${item.filename}` : "Download the original",
        detail: downloadExtension,
        icon: Download,
        onSelect: ask("downloadOriginal", () => {
          const link = document.createElement("a");
          link.href = generationDownloadUrl(item.id);
          link.download = item.filename || "";
          document.body.appendChild(link);
          link.click();
          link.remove();
          return true;
        }),
      },
      done && {
        key: "favorite",
        label: item.isFavorite ? "Unfavourite" : "Favourite",
        icon: Star,
        active: item.isFavorite,
        onSelect: ask(item.isFavorite ? "removeFavorite" : "addFavorite", async () => {
          await toggleFavorite(item.id);
          return true;
        }),
      },
      {
        key: "folder",
        label: "Open folder",
        hint: folder.label,
        detail: folder.navigable ? folder.label.split(" / ").pop() : null,
        icon: FolderOpen,
        disabled: !folder.navigable,
        reason: folder.label,
        onSelect: () => {
          setActiveProject(item.projectId || null);
          setActiveFolder(item.folderId || UNSORTED);
        },
      },
    ],
    [
      selectable && {
        key: "select",
        label: selected ? "Deselect" : "Select",
        icon: selected ? CheckSquare : Square,
        onSelect: () => toggleSelect(item.id),
      },
    ],
    [
      isAdmin && {
        key: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        // Accepted provider work is billed; it can be deleted once it finishes.
        disabled: pending,
        reason: "Still rendering - delete after it finishes",
        onSelect: ask("deleteGeneration", () => removeItem(item.id)),
      },
    ],
  ];

  if (maintenance) {
    for (const group of menuGroups) for (const action of group) {
      if (action && ["retry", "retry-text", "finalize", "favorite", "delete"].includes(action.key)) {
        action.disabled = true;
        action.reason = MAINTENANCE_MESSAGE;
      }
    }
  }
  const menuOpen = menu !== null;
  // Hover/keyboard-focus chrome; the checkbox also stays while selected.
  const revealOnHover =
    "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100";
  const statusInset = { insetInline: "calc(var(--face-inset) * 2 + var(--face-avatar))" };

  return (
    <>
    <motion.div
      ref={cardRef}
      data-asset-card-id={item.id}
      data-testid={`media-card-${item.id}`}
      tabIndex={selectable ? (isRovingTabTarget ? 0 : -1) : undefined}
      role={selectable ? "button" : undefined}
      aria-selected={selectable ? selected : undefined}
      aria-haspopup="menu"
      data-selected={selected ? "true" : undefined}
      data-menu-open={menuOpen ? "true" : undefined}
      draggable={done && Boolean(item.url)}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onFocus={(e) => {
        if (selectable && e.target === e.currentTarget && focusedAssetId !== item.id) {
          setFocusedAssetId(item.id);
        }
      }}
      onContextMenu={handleContextMenu}
      initial={reducedMotion ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.96 }}
      transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 240px" }}
      className={cn(
        "media-card group relative cursor-pointer overflow-hidden rounded-xl bg-ink-750 select-none outline-none transition duration-150 [-webkit-touch-callout:none]",
        "hover:-translate-y-0.5 hover:shadow-pop motion-reduce:hover:translate-y-0",
        selected
          ? "ring-2 ring-brand bg-brand/10 shadow-sm"
          : menuOpen
            ? "ring-2 ring-white/45"
            : "ring-1 ring-line hover:ring-lineStrong",
        isFocused && "outline outline-2 outline-white ring-2 ring-white/40 ring-offset-2 ring-offset-ink-900 z-20",
        isCardDragging && "opacity-40 scale-[0.98]"
      )}
    >
      <div style={{ paddingBottom: aspectToPadding(item.aspectRatio) }} className="media-card-body relative w-full">
        {/* media */}
        {done && item.kind === "image" && item.url && (
          <ProgressiveImage
            src={imageMedia.src}
            onSourceError={imageMedia.onError}
            alt={item.prompt}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full"
            imageClassName="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        )}
        {done && item.kind === "video" && (
          <>
            {unplayableUrl === item.url && (
              <div className="absolute inset-0 flex items-center justify-center bg-ink-800 p-4 text-center text-xs text-white/70">Preview unavailable. Open to download the original.</div>
            )}
            {item.poster && (
              <ProgressiveImage
                src={posterMedia.src}
                onSourceError={posterMedia.onError}
                alt={item.prompt}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full"
                imageClassName="object-cover"
              />
            )}
            {item.url && nearViewport && (
              <video
                src={videoMedia.src}
                muted
                loop
                playsInline
                preload="metadata"
                onCanPlay={(e) => e.currentTarget.classList.remove("opacity-0")}
                onError={() => { if (!videoMedia.onError()) setUnplayableUrl(item.url); }}
                onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                onMouseLeave={(e) => {
                  e.currentTarget.pause();
                  e.currentTarget.currentTime = 0;
                }}
                className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-200"
              />
            )}
            {!item.poster && !nearViewport && (
              // Either scrolled away (the <video> is unmounted rather than left
              // holding a decoder) or still rendering (no url yet). Same markup
              // for both: the poster is what a <video> displays until it is
              // hovered, so the pixels are identical either way.
              //
              // `loading="lazy"` is load-bearing, not decoration. Without it
              // every card the user scrolls past fetches its poster eagerly,
              // and each distinct (key, width) miss is a real /api/media
              // invocation — trading one leaked decoder per row for one eager
              // request per row. content-visibility does NOT defer this: it
              // skips layout and paint, not resource loading.
              <div className="absolute inset-0 bg-ink-800" />
            )}
          </>
        )}
        {done && item.kind === "depth" && item.url && (
          // Same treatment as the video kind — depth output is a real video
          // file (see worker.py), just never a poster (nothing renders one
          // for depth, same as real image/video generations today; only
          // MOCK_GENERATION sets poster). <video preload="metadata"> shows
          // its own first frame with no poster needed.
          <>
            {/* Gated on proximity for the same reason as the video kind, and
                it matters more here: with no poster there is nothing else
                holding the frame, so an ungated depth card is a media element
                that can never be replaced by an image. Off-screen it falls
                back to the flat tile below, which is all a skipped card was
                rendering anyway under content-visibility. */}
            {nearViewport ? (
              <video
                src={videoMedia.src}
                onError={() => videoMedia.onError()}
                muted
                loop
                playsInline
                preload="metadata"
                onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                onMouseLeave={(e) => {
                  e.currentTarget.pause();
                  e.currentTarget.currentTime = 0;
                }}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center bg-ink-800">
                <Layers className="h-6 w-6 text-white/20" />
              </div>
            )}
          </>
        )}

        {/* pending skeleton */}
        {pending && (
          <div className="absolute inset-0">
            <GenerationStatus status={item.status} />
            {/* A job held by the spend gate is healthy and self-starting, so it
                keeps the normal pending treatment — only the caption changes.
                Showing it as an error would be the "not a good look" this whole
                gate exists to avoid. Captions sit between the avatar and the
                "..." button on the bottom row. */}
            {item.queueNote && (
              <span style={statusInset} className="absolute bottom-2 z-10 text-center text-[10px] leading-snug text-white/40">
                {item.queueNote}
              </span>
            )}
            {waitingNote(item) && (
              <span data-portrait-waiting style={statusInset} className="absolute bottom-2 z-10 text-center text-[10px] leading-snug text-sky-200/80">
                {item.progressMessage}
              </span>
            )}
            {item.kind === "video" && item.pollWarning && (
              <span style={statusInset} className="absolute bottom-2 z-10 text-center text-[10px] leading-snug text-amber-300/80">
                {item.pollWarning}
              </span>
            )}
            {/* Depth jobs are the one kind with real progress to show — the
                worker POSTs progressPercent/progressMessage periodically (see
                CLAUDE.md's depth-map-worker section) and pollDepthStatus in
                store.js already patches them onto this exact item every
                2.5s, so no new data plumbing is needed here, only the
                render. Other kinds never populate these fields. */}
            {item.kind === "depth" && item.progressPercent != null && (
              <div style={statusInset} className="absolute bottom-2 z-10 mx-auto max-w-[140px]">
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-500"
                    style={{ width: `${item.progressPercent}%` }}
                  />
                </div>
                {item.progressMessage && (
                  <span className="mt-1 block truncate text-center text-[10px] leading-snug text-white/40">
                    {item.progressMessage}
                  </span>
                )}
                {item.progressMessage === "Running depth estimation" && (
                  <span className="mt-1 block text-center text-[9px] leading-snug text-white/35">
                    Depth estimation is normally the longest stage.
                  </span>
                )}
                {/* Step count derived from the worker's own fixed milestone
                    sequence (depthStepList above); elapsed time ticks off
                    createdAt — "how long this has been running", not a
                    predictive ETA. */}
                <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[9px] text-white/30">
                  {depthStepIndex != null && (
                    <span>
                      Step {depthStepIndex}/{DEPTH_STEP_COUNT}
                    </span>
                  )}
                  <ElapsedTime since={item.createdAt} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* failed */}
        {failed && (
          <div
            style={{ paddingBottom: "calc(var(--face-inset) * 2 + var(--face-avatar))" }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-red-950/30 px-3 pt-3 text-center"
          >
            {item.moderationBlocked ? (
              <ShieldAlert className="h-6 w-6 text-amber-400/90" />
            ) : (
              <AlertCircle className="h-6 w-6 text-red-400/90" />
            )}
            <span className="line-clamp-3 text-[11px] text-red-100/80">
              {item.error || "Failed"}
            </span>
          </div>
        )}

        {/* card face */}
        <div className="media-card-face pointer-events-none absolute inset-0 z-30">
          {isDraft && (
            <span data-draft-label className="media-card-draft absolute right-0 top-0 flex items-start justify-end font-semibold leading-none tracking-wide text-white">
              Draft
            </span>
          )}

          {selectable && (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label="Select"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                toggleSelect(item.id);
              }}
              className={cn(
                "media-card-control pointer-events-auto absolute left-[var(--face-inset)] top-[var(--face-inset)] grid place-items-center rounded-md border backdrop-blur-sm",
                selected
                  ? "border-brand bg-brand text-ink-900 opacity-100 shadow-sm"
                  : cn("border-white/60 bg-black/35 text-transparent hover:border-white hover:bg-black/50", revealOnHover)
              )}
            >
              <Check className="media-card-icon" strokeWidth={3} />
            </button>
          )}

          {creator && (
            <CreatorAvatar
              creator={creator}
              className="media-card-avatar absolute bottom-[var(--face-inset)] left-[var(--face-inset)] ring-2 ring-black/35"
            />
          )}

          {/* Bottom right: the favourite star owns the corner (a mark while
              favourited, a one-click toggle on hover) and "..." sits beside it,
              so neither moves when the hover controls appear. */}
          <div className="media-card-corner absolute bottom-[var(--face-inset)] right-[var(--face-inset)] flex items-center">
          <button
            ref={moreRef}
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            tabIndex={selectable ? (isRovingTabTarget ? 0 : -1) : 0}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) closeMenu({ restoreFocus: false });
              else openFromButton(e.detail === 0);
            }}
            onKeyDown={(e) => {
              // The card and grid treat Space/Enter/arrows as selection and
              // navigation; on this button they belong to the button.
              e.stopPropagation();
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                openFromButton(true);
              }
            }}
            className={cn(
              "media-card-more pointer-events-auto grid place-items-center rounded-full bg-black/55 text-white/90 shadow-sm backdrop-blur-sm hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 [@media(hover:none)]:opacity-100",
              menuOpen ? "bg-black/75 opacity-100" : revealOnHover
            )}
          >
            <MoreHorizontal className="media-card-icon" />
          </button>
          {/* During maintenance only a favourite keeps its (disabled) star; the
              hover-only "add" star would be revealed by the paused-control dimming. */}
          {done && (item.isFavorite || !maintenance) && (
            <button
              type="button"
              disabled={maintenance}
              aria-label={item.isFavorite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={item.isFavorite === true}
              title={item.isFavorite ? "Remove from favourites" : "Add to favourites"}
              tabIndex={-1}
              data-favorite-star
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                // Free and undone by a second click, so it toggles at once;
                // the context menu keeps its confirmed Favourite item.
                e.stopPropagation();
                void toggleFavorite(item.id);
              }}
              className={cn(
                "media-card-more pointer-events-auto grid place-items-center rounded-full bg-black/55 shadow-sm backdrop-blur-sm transition-[opacity,transform,color] duration-150 hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:scale-90 motion-reduce:active:scale-100",
                item.isFavorite
                  ? "text-amber-300 opacity-100"
                  : cn("text-white/90 hover:text-amber-200 [@media(hover:none)]:opacity-100", revealOnHover)
              )}
            >
              <Star className={cn("media-card-icon", item.isFavorite && "fill-current")} />
            </button>
          )}
          </div>
        </div>
      </div>
      {displayName && (
        <div data-generation-name title={item.filename} className="flex min-w-0 px-2 py-1.5 text-[11px] leading-4 text-white/80">
          <span className="min-w-0 truncate">{nameParts ? nameParts[1] : displayName}</span>
          {nameParts && <span className="shrink-0">{nameParts[2]}</span>}
        </div>
      )}
    </motion.div>
      {menu && (
        <CardContextMenu
          anchor={menu.anchor}
          gap={menu.gap}
          focusFirst={menu.focusFirst}
          toggle={moreRef}
          label="Generation actions"
          header={<GenerationDetails item={item} creator={creator} />}
          groups={menuGroups}
          onClose={closeMenu}
        />
      )}
      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}

export function resolveGenerationFolder(item, tree) {
  const project = item.projectId ? tree.projects?.find((p) => p.id === item.projectId) : null;
  if (item.projectId && !project) return { label: "Project unavailable", navigable: false };
  const root = project ? project.name : "Global";
  if (!item.folderId) return { label: `${root} / Unsorted`, navigable: true };
  const find = (nodes, parents = []) => {
    for (const node of nodes || []) {
      const path = [...parents, node.name];
      if (node.id === item.folderId) return path;
      const result = find(node.children, path);
      if (result) return result;
    }
    return null;
  };
  const path = find(project ? project.folders : tree.globalFolders);
  return { label: `${root} / ${path ? path.join(" / ") : "Folder unavailable"}`, navigable: Boolean(path) };
}

export function GenerationFolderCue({ item }) {
  const tree = useStore((state) => state.libraryTree);
  const setProject = useStore((state) => state.setActiveProject);
  const setFolder = useStore((state) => state.setActiveFolder);
  const resolved = resolveGenerationFolder(item, tree);
  return <button type="button" disabled={!resolved.navigable} title={resolved.label} onClick={(e) => { e.stopPropagation(); setProject(item.projectId || null); setFolder(item.folderId || UNSORTED); }} className="block max-w-full truncate text-left text-[11px] text-white/55 hover:text-brand disabled:cursor-default disabled:hover:text-white/55">▱ {resolved.label}</button>;
}

export function relativeGenerationTime(timestamp, now = Date.now()) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return null;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return null;
  const seconds = Math.round((time - now) / 1000);
  const [amount, unit] = Math.abs(seconds) < 60 ? [seconds, "second"] : Math.abs(seconds) < 3600 ? [Math.round(seconds / 60), "minute"] : Math.abs(seconds) < 86400 ? [Math.round(seconds / 3600), "hour"] : [Math.round(seconds / 86400), "day"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" }).format(amount, unit);
}

export function GenerationTimestamp({ timestamp }) {
  const [now, setNow] = useState(null);
  useEffect(() => { setNow(Date.now()); const interval = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(interval); }, []);
  const label = relativeGenerationTime(timestamp, now || 0);
  if (!label) return <span className="text-[11px] text-white/40">Time unavailable</span>;
  const date = new Date(timestamp);
  return <time dateTime={date.toISOString()} title={now ? date.toLocaleString() : date.toISOString()} className="text-[11px] text-white/60">{now ? label : date.toISOString()}</time>;
}
