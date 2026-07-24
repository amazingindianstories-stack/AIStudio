"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Play,
  Loader2,
  AlertCircle,
  ChevronsDown,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Layers,
  Maximize2,
  Copy,
  Star,
  Download,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { aspectToPadding, cn, thumbUrl } from "@/lib/utils";
import type { GenerationItem } from "@/lib/types";

// Feed images render inside a max-w-3xl (768px) column; cap requests well
// under typical multi-megapixel originals while staying sharp at ~2x DPR.
const FEED_THUMB_WIDTH = 1200;

export function ConversationPanel() {
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);

  // Chat is scoped to the active project — each project has its own thread, so a
  // new project starts a fresh, empty chat. Chronological, newest at the bottom.
  const feed = items
    .filter((i) => i.projectId === activeProjectId)
    .reverse();

  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  useEffect(() => {
    scrollToBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    scrollToBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.length, activeProjectId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(dist > 240);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin flex-1 overflow-y-auto px-4 py-6 sm:px-8"
      >
        {!loading && feed.length === 0 ? (
          <Welcome />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-12">
            <AnimatePresence initial={false}>
              {feed.map((item, i) => (
                <FeedBlock key={item.id} item={item} index={i + 1} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showJump && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-ink-700/90 px-3.5 py-1.5 text-xs text-white/80 shadow-pop backdrop-blur-md hover:text-white"
          >
            Back to Bottom <ChevronsDown className="h-3.5 w-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Sent prompts render minimized (2 lines); hovering reveals an expand cue in
 *  the top-right corner. Short single-line prompts skip the machinery. */
function PromptText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(
    text.length > 180 || text.includes("\n")
  );
  const textRef = useRef<HTMLParagraphElement>(null);
  const contentId = useId();

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const next = element.scrollHeight > 49;
      setCollapsible(next);
      if (!next) setExpanded(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <motion.div layout className="group/prompt relative max-w-3xl">
      <motion.div
        id={contentId}
        initial={false}
        animate={{ height: collapsible && !expanded ? "3rem" : "auto" }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="overflow-hidden"
      >
        <p
          ref={textRef}
          className="whitespace-pre-wrap pr-8 text-[15px] leading-6 text-white/85"
        >
          {text}
        </p>
      </motion.div>
      {collapsible && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="absolute -top-1 right-0 flex items-center gap-1 rounded-md bg-ink-700/95 px-1.5 py-1 text-[10px] font-medium text-white/70 opacity-100 ring-1 ring-line backdrop-blur-sm transition-opacity hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 sm:opacity-0 sm:group-hover/prompt:opacity-100 sm:focus-visible:opacity-100"
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

function FeedBlock({ item, index }: { item: GenerationItem; index: number }) {
  const setActiveId = useStore((s) => s.setActiveId);
  const cloneToComposer = useStore((s) => s.cloneToComposer);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const label = item.kind === "image" ? "Image" : "Video";
  const pending = item.status === "running" || item.status === "queued";

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 240, damping: 26 }}
      className="flex flex-col gap-3"
    >
      <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-ink-700 px-2 py-1 text-xs font-medium text-white/70 ring-1 ring-line">
        {item.kind === "image" ? (
          <Sparkles className="h-3.5 w-3.5 text-brand" />
        ) : (
          <Play className="h-3.5 w-3.5 text-brand" />
        )}
        {label} {index}
      </span>

      <PromptText text={item.prompt} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/45">
        <Meta icon={<Layers className="h-3.5 w-3.5" />}>{item.model}</Meta>
        <Meta>Proportion {item.aspectRatio}</Meta>
        {item.resolution && <Meta>Resolution {item.resolution}</Meta>}
        {item.duration && <Meta>Duration {item.duration}s</Meta>}
      </div>

      <div
        onClick={() => item.status === "succeeded" && setActiveId(item.id)}
        className={cn(
          "group/media relative w-full overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-line shadow-xl transition-shadow duration-300 hover:ring-white/20 hover:shadow-[0_0_40px_rgba(255,255,255,0.05)] focus-within:ring-white/25",
          item.status === "succeeded" && "cursor-pointer"
        )}
      >
        <div style={{ paddingBottom: aspectToPadding(item.aspectRatio) }} className="relative w-full">
          {item.status === "succeeded" && item.kind === "image" && item.url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbUrl(item.url, FEED_THUMB_WIDTH)}
              alt={item.prompt}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {item.status === "succeeded" && item.kind === "video" && (
            <video
              src={item.url}
              poster={thumbUrl(item.poster, FEED_THUMB_WIDTH)}
              controls
              playsInline
              className="absolute inset-0 h-full w-full bg-black object-contain"
            />
          )}

          {pending && (
            <div className="skeleton absolute inset-0 flex flex-col items-center justify-center gap-2.5">
              <Loader2 className="h-7 w-7 animate-spin text-brand/80" />
              <span className="text-xs text-white/60">
                {item.kind === "video"
                  ? "Rendering your video… this can take a minute"
                  : "Painting your image…"}
              </span>
            </div>
          )}

          {item.status === "failed" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-950/30 p-6 text-center">
              <AlertCircle className="h-7 w-7 text-red-400" />
              <span className="text-sm text-red-200/80">{item.error}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  cloneToComposer(item.id);
                }}
                className="mt-1 flex items-center gap-1.5 rounded-lg bg-brand/20 px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand/30"
                title="Restore this prompt, settings and references into the composer"
              >
                <Copy className="h-3.5 w-3.5" /> Clone &amp; try
              </button>
            </div>
          )}

          {item.status === "succeeded" && (
            <div className="absolute right-2.5 top-2.5 z-20 flex gap-1.5 opacity-0 transition group-hover/media:opacity-100 group-focus-within/media:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(item.id);
                }}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-lg bg-black/55 text-white/85 backdrop-blur-sm transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35",
                  item.isFavorite && "text-amber-300 hover:text-amber-200"
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
              {item.url && (
                <a
                  href={item.url}
                  download
                  onClick={(e) => e.stopPropagation()}
                  className="grid h-8 w-8 place-items-center rounded-lg bg-black/55 text-white/85 backdrop-blur-sm transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
                  aria-label="Download"
                  title="Download"
                >
                  <Download className="h-4 w-4" />
                </a>
              )}
              <span className="pointer-events-none grid h-8 w-8 place-items-center rounded-lg bg-black/55 text-white/85 backdrop-blur-sm">
                <Maximize2 className="h-4 w-4" />
              </span>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function Meta({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      {children}
    </span>
  );
}

function Welcome() {
  const setPrompt = useStore((s) => s.setPrompt);
  const examples = [
    "Cinematic close-up of a woman at a vanity mirror, warm bulbs glowing, 35mm film",
    "A high-energy 3D cell-shaded downhill skating race in bright sunlight",
    "Neon-lit Tokyo alley in the rain, reflections, slow dolly forward",
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-6 text-center"
    >
      <img
        src="/logo.png"
        alt="Vivi"
        className="h-16 w-16 rounded-3xl ring-1 ring-white/10 shadow-sm"
      />
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold text-white">
          Create with <span className="brand-text">Vivi</span>
        </h1>
        <p className="text-sm text-white/55">
          Generate images with Nano Banana Pro and videos with Seedance.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {examples.map((ex) => (
          <button
            key={ex}
            onClick={() => setPrompt(ex)}
            className="rounded-xl border border-line bg-ink-800 px-4 py-2.5 text-left text-sm text-white/65 transition-colors hover:border-white/30 hover:text-white"
          >
            {ex}
          </button>
        ))}
      </div>
    </motion.div>
  );
}
