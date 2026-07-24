"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface BlurImageProps {
  src: string | undefined; // resolved thumbnail (stored or on-the-fly)
  blurDataUrl?: string; // tiny LQIP; absent → no blur layer, plain img
  alt: string;
  className?: string; // applied to the <img> (e.g. hover scale on cards)
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
}

/**
 * Shared blur-up `<img>` for MediaCard and ConversationPanel (design.md: a
 * shared component prevents the two card surfaces from drifting on the
 * blur/fade contract). Renders (up to) two `absolute inset-0` layers meant to
 * sit inside the caller's existing `relative` aspect-ratio wrapper — no
 * layout shift, the wrapper already reserves the box.
 *
 * Visual/motion parameters (blur radius, scale, fade duration/easing, error
 * treatment) are pinned by .council/thumbnail-pipeline/ui-spec.md.
 */
export function BlurImage({
  src,
  blurDataUrl,
  alt,
  className,
  loading = "lazy",
  decoding = "async",
}: BlurImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  // ui-spec §2.1: a cache-hit image can finish loading before the React
  // onLoad handler attaches — a naive `loaded` boolean would leave it stuck
  // transparent forever. Check the img's `complete` flag synchronously before
  // paint (useLayoutEffect, not useEffect) so a cached hit never visibly
  // fades — it's simply already opaque in the first painted frame. Also
  // resets on `src` change (mirrors ImageNode's reset-on-src pattern).
  useLayoutEffect(() => {
    setLoaded(!!imgRef.current?.complete);
    setErrored(false);
  }, [src]);

  // ui-spec §2.3 (CONFIRMED): with no blurDataUrl there is nothing to blur-up
  // from — render the <img> exactly as today, no opacity gating, no fade.
  // Only the error affordance (§3) is added. "Exactly as today" includes the
  // pre-existing transition-transform duration-500 (MediaCard's hover-zoom
  // relies on it) — omitting it here made hover snap instead of ease on any
  // not-yet-backfilled/thumbnail-failed row (code-review finding).
  if (!blurDataUrl) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading={loading}
          decoding={decoding}
          onError={() => setErrored(true)}
          className={cn("transition-transform duration-500", errored && "invisible", className)}
        />
        {errored && (
          <ImageOff
            aria-hidden
            className="pointer-events-none absolute inset-0 m-auto h-5 w-5 text-white/25"
          />
        )}
      </>
    );
  }

  return (
    <>
      {/* Blur placeholder — instant paint, no network request, never fades
          out (it's fully occluded once the sharp image is opaque). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `url(${blurDataUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(16px)",
          transform: "scale(1.1)",
        }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        key={src}
        src={src}
        alt={alt}
        loading={loading}
        decoding={decoding}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        className={cn("motion-reduce:!transition-none", className)}
        style={{
          opacity: errored ? 0 : loaded ? 1 : 0,
          transition:
            "opacity 300ms cubic-bezier(0,0,0.2,1), transform 500ms cubic-bezier(0.4,0,0.2,1)",
        }}
      />
      {errored && (
        <ImageOff
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto h-5 w-5 text-white/25"
        />
      )}
    </>
  );
}
