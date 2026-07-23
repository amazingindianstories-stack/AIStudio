"use client";

import { useEffect, useRef, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import type { ImageNode as ImageNodeData } from "@/lib/canvas/types";

const RETRY_DELAYS_MS = [750, 2_000, 5_000];
const LOAD_ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_CANVAS_IMAGES = 4;

let activeCanvasImageLoads = 0;
const waitingCanvasImageLoads: Array<() => void> = [];

function requestCanvasImageSlot(): {
  acquired: Promise<() => void>;
  cancel: () => void;
} {
  let queuedStart: (() => void) | null = null;
  let activeRelease: (() => void) | null = null;

  const acquired = new Promise<() => void>((resolve) => {
    queuedStart = () => {
      queuedStart = null;
      activeCanvasImageLoads += 1;
      let released = false;
      activeRelease = () => {
        if (released) return;
        released = true;
        activeRelease = null;
        activeCanvasImageLoads = Math.max(0, activeCanvasImageLoads - 1);
        waitingCanvasImageLoads.shift()?.();
      };
      resolve(activeRelease);
    };

    if (activeCanvasImageLoads < MAX_CONCURRENT_CANVAS_IMAGES) queuedStart();
    else waitingCanvasImageLoads.push(queuedStart);
  });

  return {
    acquired,
    cancel: () => {
      if (queuedStart) {
        const index = waitingCanvasImageLoads.indexOf(queuedStart);
        if (index >= 0) waitingCanvasImageLoads.splice(index, 1);
        queuedStart = null;
      }
      activeRelease?.();
    },
  };
}

function withRetryParam(src: string, retry: number): string {
  if (retry === 0) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}canvas_retry=${retry}`;
}

/**
 * `<img>` from an already-resolved `/api/media/...` URL. No client-side URL
 * building here — `src` is consumed directly (asset panel / upload already
 * resolved it). Video assets are placed as a static poster/thumbnail image
 * node (see spec Non-goals) so this component never needs a `<video>` tag.
 */
export function ImageNode({ node }: { node: ImageNodeData }) {
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [readyToLoad, setReadyToLoad] = useState(false);
  const retryTimer = useRef<number | null>(null);
  const attemptTimer = useRef<number | null>(null);
  const releaseSlot = useRef<(() => void) | null>(null);

  useEffect(() => {
    setRetry(0);
    setLoaded(false);
    setFailed(false);
    return () => {
      if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
      if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
    };
  }, [node.src]);

  const src = withRetryParam(node.src, retry);

  useEffect(() => {
    let cancelled = false;
    setReadyToLoad(false);
    const request = requestCanvasImageSlot();
    request.acquired.then((release) => {
      if (cancelled) {
        release();
        return;
      }
      releaseSlot.current = release;
      setReadyToLoad(true);
      attemptTimer.current = window.setTimeout(() => {
        releaseSlot.current?.();
        releaseSlot.current = null;
        setReadyToLoad(false);
        if (retry >= RETRY_DELAYS_MS.length) {
          setFailed(true);
        } else {
          retryTimer.current = window.setTimeout(
            () => setRetry((current) => current + 1),
            RETRY_DELAYS_MS[retry]
          );
        }
      }, LOAD_ATTEMPT_TIMEOUT_MS);
    });
    return () => {
      cancelled = true;
      request.cancel();
      if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
      attemptTimer.current = null;
      releaseSlot.current?.();
      releaseSlot.current = null;
    };
  }, [retry, src]);

  const finishLoadAttempt = () => {
    if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
    attemptTimer.current = null;
    releaseSlot.current?.();
    releaseSlot.current = null;
  };

  const handleError = () => {
    finishLoadAttempt();
    setLoaded(false);
    if (retry >= RETRY_DELAYS_MS.length) {
      setFailed(true);
      return;
    }
    retryTimer.current = window.setTimeout(() => {
      setFailed(false);
      setRetry((current) => current + 1);
    }, RETRY_DELAYS_MS[retry]);
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-md bg-ink-800 ring-1 ring-white/5">
      {!loaded && !failed && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/25">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {failed && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/25">
          <ImageOff className="h-5 w-5" />
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {readyToLoad && (
        <img
          key={src}
          src={src}
          alt={node.alt || ""}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          draggable={false}
          onLoad={() => {
            finishLoadAttempt();
            setLoaded(true);
            setFailed(false);
          }}
          onError={handleError}
          className="h-full w-full select-none object-cover transition-opacity duration-150"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>
  );
}
