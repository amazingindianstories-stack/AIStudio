"use client";

import { useEffect } from "react";
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
} from "lucide-react";
import { useStore } from "@/lib/store";
import { aspectToPadding, cn } from "@/lib/utils";

export function DetailModal() {
  const activeId = useStore((s) => s.activeId);
  const items = useStore((s) => s.items);
  const setActiveId = useStore((s) => s.setActiveId);
  const cloneToComposer = useStore((s) => s.cloneToComposer);
  const addReferenceFromUrl = useStore((s) => s.addReferenceFromUrl);
  const setMode = useStore((s) => s.setMode);
  const removeItem = useStore((s) => s.removeItem);
  const toggleFavorite = useStore((s) => s.toggleFavorite);

  const item = items.find((i) => i.id === activeId) || null;

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setActiveId(null);
    if (item) document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [item, setActiveId]);

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/80 backdrop-blur-md"
          onClick={() => setActiveId(null)}
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
            <div className="relative flex flex-1 items-center justify-center p-4 sm:p-8">
              <button
                onClick={() => setActiveId(null)}
                className="absolute left-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white/90 backdrop-blur hover:bg-white/20"
              >
                <X className="h-5 w-5" />
              </button>

              <div className="max-h-full w-full max-w-4xl">
                <div
                  className="relative mx-auto w-full overflow-hidden rounded-2xl bg-black ring-1 ring-white/10"
                  style={{ maxWidth: "min(100%, 80vh * 16/9)" }}
                >
                  <div style={{ paddingBottom: aspectToPadding(item.aspectRatio) }} className="relative w-full">
                    {item.kind === "image" && item.url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.url}
                        alt={item.prompt}
                        className="absolute inset-0 h-full w-full object-contain"
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
                        className="absolute inset-0 h-full w-full object-contain"
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* info panel */}
            <aside className="scroll-thin flex w-full shrink-0 flex-col overflow-y-auto border-t border-line bg-ink-850 p-5 lg:w-[360px] lg:border-l lg:border-t-0">
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

              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">
                Prompt
              </p>
              <p className="mb-5 whitespace-pre-wrap text-sm leading-relaxed text-white/80">
                {item.prompt}
              </p>

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
                <>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
                    Reference images
                  </p>
                  <div className="mb-6 flex flex-wrap gap-2">
                    {item.referenceImages.map((src, i) => (
                      <a
                        key={i}
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        className="h-16 w-16 overflow-hidden rounded-lg ring-1 ring-line transition hover:ring-brand/50"
                        title="Open reference image"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt="" className="h-full w-full object-cover" />
                      </a>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-auto flex flex-col gap-2">
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
