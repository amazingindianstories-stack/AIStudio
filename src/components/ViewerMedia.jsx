"use client";

import { useCallback, useState } from "react";
import { standInUrl, useViewerMediaUrl, VIEWER_THUMB_WIDTH } from "@/lib/viewer-media";
import { generationDownloadUrl } from "@/lib/utils";

// The chat thread shows 1200px stand-ins; matching them reuses the bytes the
// thread already loaded.
const THREAD_THUMB_WIDTH = 1200;

/**
 * The detail viewer's media stage.
 *
 * Images paint the already-loaded card thumbnail at once and fade the original
 * in on top when it has arrived, so stepping with the arrow keys never shows a
 * blank frame. Videos are the original file, never a preview transcode.
 */
export function ViewerMedia({ item, source, unplayableUrl, onUnplayable }) {
  const fromThread = source === "thread";
  const thumbRef = item.kind === "image" ? item.url : item.poster;
  const stand = standInUrl(thumbRef, fromThread ? THREAD_THUMB_WIDTH : VIEWER_THUMB_WIDTH);
  const master = useViewerMediaUrl(item.url, undefined);
  // The full-size poster is what an undecodable video keeps showing, so it
  // replaces the stand-in once it has resolved.
  const poster = useViewerMediaUrl(item.kind === "video" ? item.poster : null, undefined);
  const [loaded, setLoaded] = useState({ id: null, src: null });
  const fullLoaded = loaded.id === item.id && loaded.src === master.src;

  // `load` can fire before React attaches its listener when the original is
  // already in the browser cache, so a completed image is detected here too.
  const captureImage = useCallback((node) => {
    if (node && node.complete && node.naturalWidth > 0) {
      setLoaded((prev) => (prev.id === item.id && prev.src === master.src ? prev : { id: item.id, src: master.src }));
    }
  }, [item.id, master.src]);

  if (item.kind === "image" && item.url) {
    return (
      <div className="relative h-full w-full" data-viewer-item-id={item.id}>
        {stand && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={stand}
            alt=""
            aria-hidden="true"
            data-viewer-stand-in
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
        {master.src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${item.id}:${master.src}`}
            ref={captureImage}
            src={master.src}
            alt={item.prompt}
            fetchPriority="high"
            decoding="async"
            onLoad={() => setLoaded({ id: item.id, src: master.src })}
            onError={() => { master.onError(); }}
            data-viewer-image
            className={
              "absolute inset-0 h-full w-full object-contain transition-opacity duration-150 " +
              (fullLoaded ? "opacity-100" : "opacity-0")
            }
          />
        )}
      </div>
    );
  }
  if (item.kind === "video" && unplayableUrl === item.url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-white/80">
        <p>This browser cannot play this video. Download the original for full-quality playback.</p>
        <a href={generationDownloadUrl(item.id)} download={item.filename || true} className="rounded-lg bg-brand px-4 py-2 text-ink-900">Download original</a>
      </div>
    );
  }
  if (item.kind === "video") {
    return (
      <div className="relative h-full w-full" data-viewer-item-id={item.id}>
        {stand && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={stand}
            alt=""
            aria-hidden="true"
            data-viewer-stand-in
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
        <video
          key={item.id}
          data-detail-video
          src={master.src}
          poster={poster.src}
          controls
          autoPlay
          loop
          playsInline
          onError={() => { if (!master.onError()) onUnplayable(item.url); }}
          className="absolute inset-0 h-full w-full object-contain"
        />
      </div>
    );
  }
  if (item.kind === "depth" && item.url) {
    return (
      <video
        key={item.id}
        data-detail-video
        data-viewer-item-id={item.id}
        src={master.src}
        controls
        autoPlay
        loop
        playsInline
        onError={() => { master.onError(); }}
        className="h-full w-full object-contain"
      />
    );
  }
  return null;
}
