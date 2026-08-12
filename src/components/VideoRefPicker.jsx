"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Clapperboard, Loader2, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { useHistoryQuery } from "@/lib/use-history-query";
import { MAX_REFERENCE_VIDEOS } from "@/lib/config";
import { cn, thumbUrl } from "@/lib/utils";

/**
 * Pick clips from the library to use as video references.
 *
 * Attaching a clip was originally only possible from the detail modal, which
 * meant the feature was effectively undiscoverable: the composer showed a
 * `@vid1` chip implying you could type the tag, but nothing in the composer
 * could produce one. This is the entry point that was missing.
 *
 * Reads its own scoped query rather than the shared feed, so opening it does
 * not disturb whatever the assets panel is showing.
 */
export function VideoRefPicker({ onClose }) {
  const referenceVideos = useStore((s) => s.referenceVideos);
  const addReferenceVideo = useStore((s) => s.addReferenceVideo);
  const removeReferenceVideo = useStore((s) => s.removeReferenceVideo);

  const { items, loading } = useHistoryQuery({ kind: "video" });
  const usable = items.filter((i) => i.status === "succeeded" && i.url);
  const full = referenceVideos.length >= MAX_REFERENCE_VIDEOS;

  const toggle = (url) => {
    const at = referenceVideos.indexOf(url);
    if (at >= 0) removeReferenceVideo(at);
    else if (!full) addReferenceVideo(url);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-pop"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Clapperboard className="h-4 w-4 text-brand" />
            <p className="flex-1 text-sm font-semibold text-white/90">
              Attach reference clips
            </p>
            <span className="text-xs text-white/40">
              {referenceVideos.length}/{MAX_REFERENCE_VIDEOS} selected
            </span>
            <button
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-lg text-white/55 hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="border-b border-line px-4 py-2 text-[12px] leading-snug text-white/45">
            Seedance 2.0 takes up to {MAX_REFERENCE_VIDEOS} clips of 2–15s. Once
            attached, refer to them in the prompt as{" "}
            <span className="text-brand">@vid1</span>,{" "}
            <span className="text-brand">@vid2</span> — the same way{" "}
            <span className="text-white/70">@img1</span> works for images.
          </p>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-40 items-center justify-center gap-2 text-sm text-white/45">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading clips…
              </div>
            ) : usable.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-white/45">
                <Clapperboard className="h-6 w-6" />
                <p className="text-sm">No finished videos in the library yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {usable.map((item) => {
                  const at = referenceVideos.indexOf(item.url);
                  const selected = at >= 0;
                  return (
                    <button
                      key={item.id}
                      onClick={() => toggle(item.url)}
                      disabled={!selected && full}
                      title={item.prompt}
                      className={cn(
                        "group relative aspect-video overflow-hidden rounded-xl bg-ink-750 ring-1 transition",
                        selected
                          ? "ring-2 ring-brand"
                          : "ring-line hover:ring-lineStrong",
                        !selected && full && "cursor-not-allowed opacity-35"
                      )}
                    >
                      {item.poster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumbUrl(item.poster, 480)}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-white/30">
                          <Clapperboard className="h-5 w-5" />
                        </span>
                      )}
                      {selected && (
                        <span className="absolute left-2 top-2 grid h-6 min-w-6 place-items-center rounded-md bg-brand px-1.5 text-[11px] font-bold text-ink-900">
                          @vid{at + 1}
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left text-[10px] text-white/75">
                        {item.duration ? `${item.duration}s · ` : ""}
                        {item.prompt}
                      </span>
                      {selected && (
                        <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md bg-brand text-ink-900">
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-line px-4 py-3">
            <button
              onClick={onClose}
              className="w-full rounded-xl bg-brand/20 py-2 text-sm font-semibold text-brand transition hover:bg-brand/30"
            >
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
