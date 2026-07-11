"use client";

import { motion } from "framer-motion";
import {
  Play,
  Loader2,
  AlertCircle,
  ImageIcon,
  Trash2,
  ShieldAlert,
  Wand2,
  Pencil,
  Check,
  Star,
  Copy,
} from "lucide-react";
import type { GenerationItem } from "@/lib/types";
import { useStore } from "@/lib/store";
import { aspectToPadding, cn } from "@/lib/utils";
import { formatCost } from "@/lib/pricing";

export function MediaCard({
  item,
  selectable = false,
}: {
  item: GenerationItem;
  selectable?: boolean;
}) {
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

  const pending = item.status === "running" || item.status === "queued";
  const failed = item.status === "failed";
  const done = item.status === "succeeded";

  const creatorInitial = (creator?.name || creator?.email || "?")
    .charAt(0)
    .toUpperCase();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      whileHover={{ y: -3 }}
      onClick={() => {
        if (selectable && useStore.getState().selectedIds.length > 0) {
          toggleSelect(item.id);
        } else if (done) {
          setActiveId(item.id);
        }
      }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl bg-ink-750 ring-1 transition-shadow duration-300 hover:shadow-pop",
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
            src={item.url}
            alt={item.prompt}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        )}
        {done && item.kind === "video" && (
          <>
            {item.url ? (
              <video
                src={item.url}
                poster={item.poster}
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
              item.poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.poster}
                  alt={item.prompt}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )
            )}
            <div className="pointer-events-none absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/45 backdrop-blur-sm">
              <Play className="h-3.5 w-3.5 translate-x-px fill-white text-white" />
            </div>
          </>
        )}

        {/* pending skeleton */}
        {pending && (
          <div className="skeleton absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-brand/80" />
            <span className="text-[11px] font-medium text-white/55">
              {item.status === "queued" ? "Queued…" : "Generating…"}
            </span>
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

            <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
              {item.moderationBlocked && item.kind === "video" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    retryTextToVideo(item.id);
                  }}
                  className="flex items-center gap-1 rounded-md bg-brand/20 px-2 py-1 text-[11px] font-semibold text-brand transition hover:bg-brand/30"
                >
                  <Wand2 className="h-3 w-3" /> Retry as text-to-video
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  cloneToComposer(item.id);
                }}
                className="flex items-center gap-1 rounded-md bg-brand/20 px-2 py-1 text-[11px] font-semibold text-brand transition hover:bg-brand/30"
                title="Restore this prompt, settings and references into the composer"
              >
                <Copy className="h-3 w-3" /> Clone &amp; try
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  editInComposer(item.id);
                }}
                className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/20"
              >
                <Pencil className="h-3 w-3" /> Edit prompt
              </button>
            </div>
          </div>
        )}

        {/* favourite toggle */}
        <button
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
        </button>

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
                <span className="shrink-0">{formatCost(item.costCents ?? 0)}</span>
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
        <div className="pointer-events-none absolute right-2 top-10 z-10 flex items-center gap-1 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/80 backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100">
          {item.kind === "image" ? (
            <ImageIcon className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {item.kind}
        </div>

        {/* hover prompt + delete */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 translate-y-2 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-2.5 pt-10 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <p className="line-clamp-2 pl-7 pr-9 text-[11px] leading-snug text-white/90">
            {item.prompt}
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeItem(item.id);
          }}
          className="absolute bottom-2 right-2 z-20 grid h-7 w-7 place-items-center rounded-md bg-black/55 text-white/70 opacity-0 backdrop-blur-sm transition hover:bg-red-500/80 hover:text-white group-hover:opacity-100"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  );
}
