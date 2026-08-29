"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Play,
  Loader2,
  AlertCircle,
  ImageIcon,
  Layers,
  Trash2,
  ShieldAlert,
  Wand2,
  Pencil,
  Check,
  Star,
  Copy,
  Download,
  MoreHorizontal,
} from "lucide-react";

import { useStore } from "@/lib/store";
import { aspectToPadding, cn, inlineMediaUrl, thumbUrl } from "@/lib/utils";
import { useNearViewport } from "@/lib/use-near-viewport";
import { Dropdown, MenuItem } from "./Dropdown";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { useConfirmedAction } from "./useConfirmedAction";

// Grid cards render at ~160–320 CSS px; request a modest fixed width
// (covers up to ~2x device pixel ratio at the larger end) instead of the
// full-resolution original.
const CARD_THUMB_WIDTH = 480;
import { formatCost } from "@/lib/pricing";
import { costBasisForGeneration } from "@/lib/cost-basis";

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

export function MediaCard({
  item,
  selectable = false,
}

) {
  const setActiveId = useStore((s) => s.setActiveId);
  const removeItem = useStore((s) => s.removeItem);
  const retryTextToVideo = useStore((s) => s.retryTextToVideo);
  const editInComposer = useStore((s) => s.editInComposer);
  const cloneToComposer = useStore((s) => s.cloneToComposer);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const selected = useStore((s) => s.selectedIds.includes(item.id));
  const toggleSelect = useStore((s) => s.toggleSelect);
  const creator = useStore((s) =>
    item.userId ? s.usersById[item.userId] : undefined
  );
  const confirmation = useConfirmedAction();

  const pending = item.status === "running" || item.status === "queued";
  const failed = item.status === "failed";
  const done = item.status === "succeeded";
  const costBasis = costBasisForGeneration(item);
  const depthStepIndex =
    item.kind === "depth" && item.progressMessage
      ? depthStepList(item.trackCharacters).indexOf(item.progressMessage) + 1 || null
      : null;

  const creatorInitial = (creator?.name || creator?.email || "?")
    .charAt(0)
    .toUpperCase();

  // Only cards near the viewport mount a real <video>. An infinite feed can
  // hold hundreds of them, and each one that stays mounted holds a decoder and
  // its buffered metadata for the rest of the session — see use-near-viewport.
  const cardRef = useRef(null);
  const nearViewport = useNearViewport(cardRef);

  return (
    <>
    {/* No `layout` prop, deliberately. It made every card FLIP-animate to any
        new position, so each appended page of an infinite scroll set the entire
        grid sliding around under the pointer. Hover lift is CSS-composited for
        the same reason: it cannot move a neighbouring card. */}
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => {
        if (selectable && useStore.getState().selectedIds.length > 0) {
          toggleSelect(item.id);
        } else if (done) {
          setActiveId(item.id);
        }
      }}
      // `contain-intrinsic-size: auto <fallback>` — the `auto` keyword is what
      // makes the browser remember each card's last rendered height and reuse
      // it when the card scrolls back out of range. Without it every skipped
      // card collapsed to a flat 200px placeholder, so the scroll container's
      // height changed as cards entered and left the rendering window and the
      // viewport visibly jumped. The fallback only applies before a card has
      // ever been rendered.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 240px" }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl bg-ink-750 ring-1 transition duration-200 hover:-translate-y-0.5 hover:shadow-pop motion-reduce:hover:translate-y-0",
        selected
          ? "ring-2 ring-brand"
          : "ring-line hover:ring-lineStrong"
      )}
    >
      {/* selection checkbox */}
      {selectable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleSelect(item.id);
          }}
          className={cn(
            "absolute left-2 top-2 z-30 grid h-6 w-6 place-items-center rounded-md border backdrop-blur-sm transition",
            selected
              ? "border-brand bg-brand text-ink-900"
              : "border-white/50 bg-black/40 text-transparent opacity-0 hover:border-white group-hover:opacity-100"
          )}
          aria-label={selected ? "Deselect" : "Select"}
        >
          <Check className="h-4 w-4" strokeWidth={3} />
        </button>
      )}

      <div style={{ paddingBottom: aspectToPadding(item.aspectRatio) }} className="relative w-full">
        {/* media */}
        {done && item.kind === "image" && item.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbUrl(item.url, CARD_THUMB_WIDTH)}
            alt={item.prompt}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        )}
        {done && item.kind === "video" && (
          <>
            {item.url && nearViewport ? (
              <video
                src={item.url}
                poster={thumbUrl(item.poster, CARD_THUMB_WIDTH)}
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
              item.poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbUrl(item.poster, CARD_THUMB_WIDTH)}
                  alt={item.prompt}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )
            )}
            <div className="pointer-events-none absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/45 backdrop-blur-sm">
              <Play className="h-3.5 w-3.5 translate-x-px fill-white text-white" />
            </div>
          </>
        )}
        {done && item.kind === "depth" && item.url && (
          // Same treatment as the video kind — depth output is a real video
          // file (see worker.py), just never a poster (nothing renders one
          // for depth, same as real image/video generations today; only
          // MOCK_GENERATION sets poster). <video preload="metadata"> shows
          // its own first frame with no poster needed. Layers badge instead
          // of Play to match the Depth Map mode's icon in config.js's MODES.
          <>
            {/* Gated on proximity for the same reason as the video kind, and
                it matters more here: with no poster there is nothing else
                holding the frame, so an ungated depth card is a media element
                that can never be replaced by an image. Off-screen it falls
                back to the flat tile below, which is all a skipped card was
                rendering anyway under content-visibility. */}
            {nearViewport ? (
              <video
                src={item.url}
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
            <div className="pointer-events-none absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/45 backdrop-blur-sm">
              <Layers className="h-3.5 w-3.5 text-white" />
            </div>
          </>
        )}

        {/* pending skeleton */}
        {pending && (
          <div className="skeleton absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-brand/80" />
            <span className="text-[11px] font-medium text-white/55">
              {item.status === "queued" ? "Queued…" : "Generating…"}
            </span>
            {/* A job held by the spend gate is healthy and self-starting, so it
                keeps the normal pending treatment — only the caption changes.
                Showing it as an error would be the "not a good look" this whole
                gate exists to avoid. */}
            {item.queueNote && (
              <span className="text-[10px] leading-snug text-white/40">
                {item.queueNote}
              </span>
            )}
            {item.kind === "video" && item.pollWarning && (
              <span className="text-[10px] leading-snug text-amber-300/80">
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
              <div className="mt-1 w-full max-w-[140px]">
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-500"
                    style={{ width: `${item.progressPercent}%` }}
                  />
                </div>
                {item.progressMessage && (
                  <span className="mt-1 block truncate text-[10px] leading-snug text-white/40">
                    {item.progressMessage}
                  </span>
                )}
                {item.progressMessage === "Running depth estimation" && (
                  <span className="mt-1 block text-[9px] leading-snug text-white/35">
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
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0 flex cursor-default flex-col items-center justify-center gap-1.5 bg-red-950/30 p-3 text-center"
          >
            {item.moderationBlocked ? (
              <ShieldAlert className="h-6 w-6 text-amber-400/90" />
            ) : (
              <AlertCircle className="h-6 w-6 text-red-400/90" />
            )}
            <span className="line-clamp-3 text-[11px] text-red-100/80">
              {item.error || "Failed"}
            </span>

            <div className="mt-1 flex max-w-full items-center justify-center gap-1.5">
              {item.moderationBlocked && item.kind === "video" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmation.ask("retryTextToVideo", () => retryTextToVideo(item.id));
                  }}
                  className="flex h-7 min-w-0 items-center gap-1 rounded-md bg-brand/20 px-2 text-[11px] font-semibold text-brand transition hover:bg-brand/30"
                >
                  <Wand2 className="h-3 w-3 shrink-0" /> Retry
                </button>
              )}
              {/* cloneToComposer/editInComposer restore prompt/references
                  from image/video-shaped fields (referenceImages, prompt as
                  free text) that a depth row doesn't have in a usable form —
                  it has referenceVideos and a placeholder label instead, so
                  both would silently just switch to an empty DepthComposer
                  rather than actually cloning anything. Suppressed for depth
                  rather than shipping a dead-end button. */}
              {!item.moderationBlocked && item.kind !== "depth" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmation.ask("editPrompt", () => editInComposer(item.id));
                  }}
                  className="flex h-7 min-w-0 items-center gap-1 rounded-md bg-brand/20 px-2 text-[11px] font-semibold text-brand transition hover:bg-brand/30"
                >
                  <Pencil className="h-3 w-3 shrink-0" /> Edit
                </button>
              )}
              <Dropdown
                align="right"
                side="bottom"
                label="Generation actions"
                panelClassName="w-56"
                trigger={(open) => (
                  <span
                    className={cn(
                      "grid h-7 w-7 place-items-center rounded-md bg-black/45 text-white/70 transition hover:bg-white/15 hover:text-white",
                      open && "bg-white/15 text-white"
                    )}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </span>
                )}
              >
                {(close) => (
                  <>
                    {item.kind !== "depth" && (
                      <MenuItem
                        onClick={() => {
                          close();
                          confirmation.ask("cloneToComposer", () => cloneToComposer(item.id));
                        }}
                      >
                        <Copy className="h-4 w-4" /> Clone &amp; try
                      </MenuItem>
                    )}
                    {item.moderationBlocked && item.kind !== "depth" && (
                      <MenuItem
                        onClick={() => {
                          close();
                          confirmation.ask("editPrompt", () => editInComposer(item.id));
                        }}
                      >
                        <Pencil className="h-4 w-4" /> Edit prompt
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        close();
                        confirmation.ask("deleteGeneration", () => removeItem(item.id));
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-300" />
                      <span className="text-red-200">Delete</span>
                    </MenuItem>
                  </>
                )}
              </Dropdown>
            </div>
          </div>
        )}

        {/* favourite toggle */}
        {!failed && <button
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(item.id);
          }}
          className={cn(
            "absolute right-2 top-2 z-30 grid h-7 w-7 place-items-center rounded-md bg-black/55 backdrop-blur-sm transition",
            item.isFavorite
              ? "text-amber-300 opacity-100 hover:bg-amber-400/20"
              : "text-white/70 opacity-0 hover:bg-white/15 hover:text-white group-hover:opacity-100"
          )}
          aria-label={item.isFavorite ? "Remove from favourites" : "Add to favourites"}
          title={item.isFavorite ? "Remove from favourites" : "Add to favourites"}
        >
          <Star
            className={cn("h-3.5 w-3.5", item.isFavorite && "fill-current")}
          />
        </button>}

        {done && item.url && (
          <a
            href={inlineMediaUrl(item.url)}
            download
            onClick={(e) => e.stopPropagation()}
            className="absolute right-10 top-2 z-30 grid h-7 w-7 place-items-center rounded-md bg-black/55 text-white/70 opacity-0 backdrop-blur-sm transition hover:bg-white/15 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 group-hover:opacity-100"
            aria-label="Download"
            title="Download"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        )}

        {/* creator attribution — small circle; hover for who/cost/when */}
        {creator && (
          <div className="group/u pointer-events-none absolute inset-x-2 bottom-2 z-30">
            <span
              className="pointer-events-auto relative grid h-6 w-6 cursor-default place-items-center overflow-hidden rounded-full text-[11px] font-semibold text-ink-900 ring-2 ring-black/40"
              style={{ background: creator.color || "#34d399" }}
            >
              {creator.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={creator.avatarUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                creatorInitial
              )}
            </span>
            <div className="invisible absolute bottom-8 left-0 right-0 translate-y-1 rounded-lg border border-line bg-ink-650/95 px-2.5 py-2 text-[11px] text-white/90 opacity-0 shadow-pop backdrop-blur-md transition duration-150 group-hover/u:visible group-hover/u:translate-y-0 group-hover/u:opacity-100">
              <p className="truncate font-medium">{creator.name || creator.email}</p>
              <p className="truncate text-white/45">{creator.email}</p>
              <p className="mt-1 flex min-w-0 items-center gap-1.5 text-white/55">
                <span
                  className="shrink-0"
                  title={
                    costBasis === "reconciled"
                      ? "Reconciled from provider-reported usage"
                      : "Estimated from the configured pricing table"
                  }
                >
                  {costBasis === "estimated" ? "≈" : ""}{formatCost(item.costCents ?? 0)}
                </span>
                <span aria-hidden className="text-white/25">
                  ·
                </span>
                <span className="min-w-0 truncate">
                  {new Date(item.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </p>
            </div>
          </div>
        )}

        {/* kind chip */}
        {!failed && <div className="pointer-events-none absolute right-2 top-10 z-10 flex items-center gap-1 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/80 backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100">
          {item.kind === "image" ? (
            <ImageIcon className="h-3 w-3" />
          ) : item.kind === "depth" ? (
            <Layers className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {item.kind}
        </div>}

        {/* hover prompt + delete */}
        {!failed && <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 translate-y-2 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-2.5 pt-10 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <p className="line-clamp-2 pl-7 pr-9 text-[11px] leading-snug text-white/90">
            {item.prompt}
          </p>
        </div>}
        {!failed && <button
          onClick={(e) => {
            e.stopPropagation();
            confirmation.ask("deleteGeneration", () => removeItem(item.id));
          }}
          className="absolute bottom-2 right-2 z-20 grid h-7 w-7 place-items-center rounded-md bg-black/55 text-white/70 opacity-0 backdrop-blur-sm transition hover:bg-red-500/80 hover:text-white group-hover:opacity-100"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>}
      </div>
    </motion.div>
      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}
