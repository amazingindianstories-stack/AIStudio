"use client";

import { useCallback, useState } from "react";
import { ImageOff, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProgressiveImage({ src, alt = "", className, imageClassName, ...props }) {
  const [retryState, setRetryState] = useState({ source: src, count: 0 });
  const retry = retryState.source === src ? retryState.count : 0;
  const resolved = retry && src
    ? `${src}${src.includes("?") ? "&" : "?"}mediaRetry=${retry}`
    : src;
  const [load, setLoad] = useState({ source: resolved, status: "loading" });
  // A source change is loading without needing an effect that can race the
  // browser's load event. That race was the production blank-card bug: a
  // cached lazy image could load during commit, then the reset effect ran and
  // hid the already-decoded pixels forever.
  const state = load.source === resolved ? load.status : "loading";

  const settle = useCallback((status) => {
    setLoad((current) =>
      current.source === resolved && current.status === status
        ? current
        : { source: resolved, status }
    );
  }, [resolved]);

  const captureImage = useCallback((node) => {
    // `load` is not guaranteed to fire after React attaches its listener when
    // a lazy image is already in the memory/disk cache. `complete` is the
    // authoritative browser state in that case.
    const completed = completedImageStatus(node);
    if (completed) settle(completed);
  }, [settle]);

  return (
    <div className={cn("relative overflow-hidden bg-ink-900", className)}>
      {state === "loading" && <div aria-hidden="true" className="skeleton absolute inset-0" />}
      {state === "error" ? (
        <div role="group" aria-label="Media failed to load" className="absolute inset-0 grid place-items-center bg-ink-900 text-white/45">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setRetryState((current) => ({
                source: src,
                count: current.source === src ? current.count + 1 : 1,
              }));
            }}
            className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 text-xs hover:bg-white/5 hover:text-white/75"
          >
            <ImageOff className="h-5 w-5" />
            <span className="flex items-center gap-1"><RotateCw className="h-3 w-3" /> Retry</span>
          </button>
        </div>
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...props}
          key={resolved}
          ref={captureImage}
          src={resolved}
          alt={alt}
          onLoad={() => settle("loaded")}
          onError={() => settle("error")}
          className={cn(
            "h-full w-full opacity-0 transition-opacity duration-300",
            state === "loaded" && "opacity-100",
            imageClassName
          )}
        />
      ) : null}
    </div>
  );
}

/** Exported for deterministic regression tests without a browser DOM. */
export function completedImageStatus(image) {
  if (!image?.complete) return null;
  return image.naturalWidth > 0 ? "loaded" : "error";
}
