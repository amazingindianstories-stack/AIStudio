"use client";

import { useEffect, useRef, useState } from "react";
import { ImageOff, Loader2, Check, RotateCcw, X } from "lucide-react";

import { thumbUrl } from "@/lib/utils";

const RETRY_DELAYS_MS = [750, 2_000, 5_000];
const LOAD_ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_CANVAS_IMAGES = 4;
// Boards can hold many nodes at arbitrary zoom; request a fixed cap well
// below full-res instead of building per-node/per-zoom sizes (not worth the
// cache-key churn — see the media route's `?w=` resize support).
const NODE_THUMB_WIDTH = 1024;

let activeCanvasImageLoads = 0;
const waitingCanvasImageLoads = [];

function requestCanvasImageSlot()

 {
  let queuedStart = null;
  let activeRelease = null;

  const acquired = new Promise((resolve) => {
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

function withRetryParam(src, retry) {
  if (retry === 0) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}canvas_retry=${retry}`;
}

/**
 * `<img>` from an already-resolved `/api/media/...` URL, resized to
 * `NODE_THUMB_WIDTH` via the media route's `?w=` param. Video assets are
 * placed as a static poster/thumbnail image node (see spec Non-goals) so
 * this component never needs a `<video>` tag.
 */
export function ImageNode({ node, cropMode = false, cropDraft, onCropChange, onApplyCrop, onCancelCrop, onResetCrop }) {
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [readyToLoad, setReadyToLoad] = useState(false);
  const retryTimer = useRef(null);
  const attemptTimer = useRef(null);
  const releaseSlot = useRef(null);
  const cropDrag = useRef(null);

  useEffect(() => {
    setRetry(0);
    setLoaded(false);
    setFailed(false);
    return () => {
      if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
      if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
    };
  }, [node.src]);

  const src = withRetryParam(thumbUrl(node.src, NODE_THUMB_WIDTH) ?? node.src, retry);

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

  const crop = cropMode ? (cropDraft ?? { x: 0.5, y: 0.5, zoom: 1 }) : (node.crop ?? { x: 0.5, y: 0.5, zoom: 1 });
  const naturalW = node.naturalW || node.w;
  const naturalH = node.naturalH || node.h;
  const scale = Math.max(node.w / naturalW, node.h / naturalH) * crop.zoom;
  const renderedW = naturalW * scale;
  const renderedH = naturalH * scale;
  const imageStyle = {
    width: renderedW,
    height: renderedH,
    left: -crop.x * Math.max(0, renderedW - node.w),
    top: -crop.y * Math.max(0, renderedH - node.h),
    opacity: loaded ? 1 : 0,
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-md bg-ink-800 ring-1 ring-white/5"
      onPointerDown={cropMode ? (event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        cropDrag.current = { x: event.clientX, y: event.clientY, crop };
      } : undefined}
      onPointerMove={cropMode ? (event) => {
        if (!cropDrag.current) return;
        const overflowX = Math.max(1, renderedW - node.w);
        const overflowY = Math.max(1, renderedH - node.h);
        onCropChange?.({
          x: cropDrag.current.crop.x - (event.clientX - cropDrag.current.x) / overflowX,
          y: cropDrag.current.crop.y - (event.clientY - cropDrag.current.y) / overflowY,
        });
      } : undefined}
      onPointerUp={cropMode ? (event) => { event.stopPropagation(); cropDrag.current = null; } : undefined}
      onWheel={cropMode ? (event) => {
        event.preventDefault(); event.stopPropagation();
        onCropChange?.({ zoom: crop.zoom * Math.exp(-event.deltaY * 0.002) });
      } : undefined}
    >
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
          className="absolute max-w-none select-none transition-opacity duration-150"
          style={imageStyle}
        />
      )}
      {cropMode && (
        <div className="absolute inset-x-2 bottom-2 z-20 flex items-center justify-center gap-1" data-crop-controls>
          <button type="button" aria-label="Reset crop" title="Reset crop" onPointerDown={(e) => e.stopPropagation()} onClick={onResetCrop} className="rounded-md bg-black/75 p-1.5 text-white hover:bg-black"><RotateCcw className="h-3.5 w-3.5" /></button>
          <input aria-label="Crop zoom" type="range" min="1" max="8" step="0.05" value={crop.zoom} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onCropChange?.({ zoom: Number(e.target.value) })} className="w-24 accent-white" />
          <button type="button" aria-label="Cancel crop" title="Cancel" onPointerDown={(e) => e.stopPropagation()} onClick={onCancelCrop} className="rounded-md bg-black/75 p-1.5 text-white hover:bg-black"><X className="h-3.5 w-3.5" /></button>
          <button type="button" aria-label="Apply crop" title="Apply" onPointerDown={(e) => e.stopPropagation()} onClick={onApplyCrop} className="rounded-md bg-brand p-1.5 text-ink-950"><Check className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );
}
