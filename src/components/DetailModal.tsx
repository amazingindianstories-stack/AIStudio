"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Download,
  Copy,
  Trash2,
  Box,
  Sparkles,
  Play,
  ImagePlus,
  Star,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Prompt in the details sidebar: minimized by default, hover reveals an
 *  expand cue in the top-right corner (same pattern as the feed). Keyed by
 *  item id upstream so switching items re-collapses. */
function DetailPrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(
    text.length > 220 || text.split("\n").length > 3
  );
  const textRef = useRef<HTMLParagraphElement>(null);
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

function ReferenceCollage({ images }: { images: string[] }) {
  const visible = images.slice(0, 4);
  const extra = images.length - visible.length;
  const layoutClass =
    visible.length === 1
      ? "grid-cols-1"
      : visible.length === 2
      ? "grid-cols-2"
      : "grid-cols-2";

  return (
    <div className="mb-5">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
        Reference images
      </p>
      <div className={cn("grid gap-2", layoutClass)}>
        {visible.map((src, i) => (
          <a
            key={i}
            href={src}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group relative overflow-hidden rounded-xl border border-line bg-ink-700 ring-1 ring-white/5 transition hover:border-brand/40 hover:ring-brand/20",
              i === 0 && visible.length > 2 && "row-span-2 min-h-32",
              visible.length === 2 && "min-h-24"
            )}
            title="Open reference image"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="h-full w-full object-cover" />
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
          </a>
        ))}
      </div>
      {extra > 0 && (
        <p className="mt-2 text-[11px] text-white/45">+{extra} more reference image{extra === 1 ? "" : "s"}</p>
      )}
    </div>
  );
}

export function DetailModal() {
  const activeId = useStore((s) => s.activeId);
  const items = useStore((s) => s.items);
  const rightTab = useStore((s) => s.rightTab);
  const search = useStore((s) => s.search);
  const filterKind = useStore((s) => s.filterKind);
  const setActiveId = useStore((s) => s.setActiveId);
  const cloneToComposer = useStore((s) => s.cloneToComposer);
  const addReferenceFromUrl = useStore((s) => s.addReferenceFromUrl);
  const setMode = useStore((s) => s.setMode);
  const removeItem = useStore((s) => s.removeItem);
  const toggleFavorite = useStore((s) => s.toggleFavorite);

  const item = items.find((i) => i.id === activeId) || null;
  const navigableItems = (() => {
    if (!item) return [];
    if (rightTab === "favorites") {
      const q = search.trim().toLowerCase();
      return items
        .filter((candidate) => candidate.isFavorite)
        .filter((candidate) =>
          filterKind === "all" ? true : candidate.kind === filterKind
        )
        .filter((candidate) =>
          q ? candidate.prompt.toLowerCase().includes(q) : true
        )
        .sort(
          (a, b) =>
            (b.favoritedAt ?? b.updatedAt) - (a.favoritedAt ?? a.updatedAt)
        )
        .filter(
          (candidate) => candidate.status === "succeeded" && Boolean(candidate.url || candidate.poster)
        );
    }
    return items.filter(
      (candidate) => candidate.status === "succeeded" && Boolean(candidate.url || candidate.poster)
    );
  })();

  // Closing the modal while a <video>'s native fullscreen is still active
  // (or mid-exit-transition) unmounts the fullscreen element out from under
  // the browser's own fullscreen-exit handling — in Chrome this can leave
  // the page's hit-testing wedged until a reload. Exit fullscreen first and
  // let the (now-unmounted-safe) close happen on the next call.
  const closeModal = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    setActiveId(null);
  };

  useEffect(() => {
    if (!item) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeModal();
        return;
      }
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const delta =
        event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : 0;
      if (delta === 0 || navigableItems.length < 2) return;

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
  }, [item, navigableItems, setActiveId]);

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/80 backdrop-blur-md"
          onClick={closeModal}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="relative flex h-full w-full flex-col lg:flex-row"
          >
            {/* media stage */}
            <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-4 sm:p-8">
              <button
                onClick={closeModal}
                className="absolute left-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white/90 backdrop-blur hover:bg-white/20"
              >
                <X className="h-5 w-5" />
              </button>

              <div className="h-full min-h-0 w-full max-w-5xl overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
                {item.kind === "image" && item.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.url}
                    alt={item.prompt}
                    className="h-full w-full object-contain"
                  />
                )}
                {item.kind === "video" && (
                  <video
                    src={item.url}
                    poster={item.poster}
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
                  ) : (
                    <Play className="h-4 w-4 text-brand" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{item.model}</p>
                  <p className="text-xs capitalize text-white/45">{item.kind} generation</p>
                </div>
                <button
                  onClick={() => toggleFavorite(item.id)}
                  className={cn(
                    "ml-auto grid h-8 w-8 place-items-center rounded-lg border transition",
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

              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
                Parameters
              </p>
              <div className="mb-6 grid grid-cols-2 gap-2">
                <Param label="Aspect" value={item.aspectRatio} />
                {item.resolution && <Param label="Resolution" value={item.resolution} />}
                {item.duration && <Param label="Duration" value={`${item.duration}s`} />}
                <Param label="Model" value={item.model} icon={<Box className="h-3.5 w-3.5" />} />
              </div>

              {item.referenceImages && item.referenceImages.length > 0 && (
                <ReferenceCollage images={item.referenceImages} />
              )}

              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">
                Prompt
              </p>
              <DetailPrompt key={item.id} text={item.prompt} />
              </div>

              {/* sticky bottom actions */}
              <div className="flex flex-col gap-2 p-5 pt-2 border-t border-white/5 bg-ink-850/95 backdrop-blur z-10 shadow-[0_-10px_20px_rgba(0,0,0,0.2)]">
                {item.kind === "image" && item.url && (
                  <button
                    onClick={() => {
                      addReferenceFromUrl(item.url!);
                      setMode("image");
                      setActiveId(null);
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/15 py-2.5 text-sm font-semibold text-brand hover:bg-brand/25"
                    title="Add this image as a reference — generate a clean hero, then place them in a crowd"
                  >
                    <ImagePlus className="h-4 w-4" /> Use as reference
                  </button>
                )}
                <button
                  onClick={() => {
                    cloneToComposer(item.id);
                    setActiveId(null);
                  }}
                  className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-accent py-2.5 text-sm font-semibold text-ink-900 shadow-glow hover:brightness-110"
                >
                  <Copy className="h-4 w-4" /> Clone &amp; try
                </button>
                <div className="flex gap-2">
                  {item.url && (
                    <a
                      href={item.url}
                      download
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-ink-700 py-2.5 text-sm text-white/80 hover:text-white"
                    >
                      <Download className="h-4 w-4" /> Download
                    </a>
                  )}
                  <button
                    onClick={() => {
                      removeItem(item.id);
                      setActiveId(null);
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
    </AnimatePresence>
  );
}

function Param({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
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
