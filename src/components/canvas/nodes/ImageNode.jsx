"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, Loader2, Check, RotateCcw, X } from "lucide-react";

import { thumbUrl } from "@/lib/utils";
import { nodeRotation, rotatePoint } from "@/lib/canvas/geometry";
import { imageLoadVisibility, selectImageTier } from "@/lib/canvas/image-lod";
import { requestCanvasImageSlot } from "@/lib/canvas/image-loader";
import { cachedDirectUrl, forgetDirectUrl, isResolvable, requestDirectUrl } from "@/lib/media-resolver";

const RETRY_DELAYS_MS = [750, 2_000, 5_000];
const THUMB_TIMEOUT_MS = 15_000;
const FULL_TIMEOUT_MS = 30_000;
const TIER_DEBOUNCE_MS = 160;

function withRetryParam(src, retry) {
  if (retry === 0) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}canvas_retry=${retry}`;
}

function fallbackUrlFor(src, tier) {
  if (!src) return src;
  return tier ? (thumbUrl(src, tier) ?? src) : src;
}

/**
 * Zoom-aware, viewport-prioritized canvas image node.
 *
 * Loads small WebP derivatives (256/512/1280) sized to rendered screen pixels,
 * batches direct storage URL resolution, decodes asynchronously off-thread,
 * keeps the previous resolution visible while upgrading (no flicker), releases
 * bitmaps outside the load margin, and swaps to the native full-resolution
 * master when zoomed in closely.
 */
export const ImageNode = memo(function ImageNode({
  node,
  cropMode = false,
  cropDraft,
  onCropChange,
  onApplyCrop,
  onCancelCrop,
  onResetCrop,
  viewport,
  viewportSize,
}) {
  const [retry, setRetry] = useState(0);
  const [displayed, setDisplayed] = useState(null); // { nodeSrc, url, tier }
  const [pending, setPending] = useState(null); // { nodeSrc, url, tier, isDirect }
  const [failed, setFailed] = useState(false);

  const retryTimer = useRef(null);
  const attemptTimer = useRef(null);
  const releaseSlot = useRef(null);
  const slotHandle = useRef(null);
  const cropDrag = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const crop = cropMode ? (cropDraft ?? { x: 0.5, y: 0.5, zoom: 1 }) : (node.crop ?? { x: 0.5, y: 0.5, zoom: 1 });
  const naturalW = node.naturalW || node.w;
  const naturalH = node.naturalH || node.h;
  const scale = Math.max(node.w / naturalW, node.h / naturalH) * crop.zoom;
  const renderedW = naturalW * scale;
  const renderedH = naturalH * scale;

  const rawVisibility = imageLoadVisibility(node, viewport, viewportSize);
  const shouldLoad = cropMode || rawVisibility.shouldLoad;
  const inViewport = cropMode || rawVisibility.inViewport;
  const distanceSq = cropMode ? 0 : rawVisibility.distanceSq;

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const currentTier = displayed && displayed.nodeSrc === node.src ? displayed.tier : undefined;
  const rawDesiredTier = selectImageTier({
    renderedW,
    zoom: viewport?.zoom ?? 1,
    dpr,
    naturalW: node.naturalW || 0,
    cropMode,
    currentTier,
  });

  // Debounce tier changes while zooming rapidly, but apply initial tier immediately.
  const [debouncedTier, setDebouncedTier] = useState(rawDesiredTier);
  const hasLoadedOnce = displayed?.nodeSrc === node.src;
  useEffect(() => {
    if (!hasLoadedOnce) {
      setDebouncedTier(rawDesiredTier);
      return undefined;
    }
    if (debouncedTier === rawDesiredTier) return undefined;
    const timer = window.setTimeout(() => setDebouncedTier(rawDesiredTier), TIER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [rawDesiredTier, hasLoadedOnce, debouncedTier]);

  const targetTier = hasLoadedOnce ? debouncedTier : rawDesiredTier;

  // Keep queued priority fresh during pans without restarting the load effect.
  const priorityRef = useRef({ inViewport, distanceSq });
  priorityRef.current = { inViewport, distanceSq };
  useEffect(() => {
    slotHandle.current?.updatePriority({ inViewport, distanceSq });
  }, [inViewport, distanceSq]);

  // Reset per-source state when node.src changes.
  useEffect(() => {
    setRetry(0);
    setDisplayed(null);
    setPending(null);
    setFailed(false);
    return () => {
      if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
      if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
    };
  }, [node.src]);

  // Release decoded bitmap when node scrolls outside the load margin.
  useEffect(() => {
    if (!shouldLoad) {
      setDisplayed(null);
      setPending(null);
      setFailed(false);
      setRetry(0);
    }
  }, [shouldLoad]);

  const clearAttempt = useCallback(() => {
    if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
    attemptTimer.current = null;
    releaseSlot.current?.();
    releaseSlot.current = null;
    slotHandle.current = null;
  }, []);

  const alreadyAtTarget = displayed?.nodeSrc === node.src && displayed.tier === targetTier;

  useEffect(() => {
    if (!shouldLoad || !node.src || alreadyAtTarget) {
      setPending(null);
      return undefined;
    }

    let cancelled = false;
    const isUpgrade = displayed?.nodeSrc === node.src;
    const request = requestCanvasImageSlot({
      tier: targetTier,
      inViewport: priorityRef.current.inViewport,
      isUpgrade,
      distanceSq: priorityRef.current.distanceSq,
    });
    slotHandle.current = request;

    const armTimeout = () => {
      if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
      attemptTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        releaseSlot.current?.();
        releaseSlot.current = null;
        slotHandle.current = null;
        setPending(null);
        if (retry >= RETRY_DELAYS_MS.length) {
          if (!isUpgrade) setFailed(true);
        } else {
          retryTimer.current = window.setTimeout(
            () => setRetry((current) => current + 1),
            RETRY_DELAYS_MS[retry]
          );
        }
      }, targetTier === null ? FULL_TIMEOUT_MS : THUMB_TIMEOUT_MS);
    };

    // Batch direct-URL resolution immediately (up to 100 per POST /api/media-resolve)
    // in parallel with waiting for the image download/decode slot.
    let directPromise = Promise.resolve(null);
    if (retry === 0 && isResolvable(node.src)) {
      const cached = cachedDirectUrl(node.src, targetTier);
      directPromise = cached ? Promise.resolve(cached.url) : requestDirectUrl(node.src, targetTier);
    }

    request.acquired.then(async (release) => {
      if (cancelled) {
        release();
        return;
      }
      releaseSlot.current = release;
      armTimeout();

      const direct = await directPromise;
      if (cancelled) return;

      const url = direct || withRetryParam(fallbackUrlFor(node.src, targetTier), retry);
      setPending({ nodeSrc: node.src, url, tier: targetTier, isDirect: Boolean(direct) });
    });

    return () => {
      cancelled = true;
      request.cancel();
      if (slotHandle.current === request) slotHandle.current = null;
      if (attemptTimer.current != null) window.clearTimeout(attemptTimer.current);
      attemptTimer.current = null;
      releaseSlot.current?.();
      releaseSlot.current = null;
    };
  }, [shouldLoad, node.src, targetTier, retry, alreadyAtTarget, displayed?.nodeSrc]);

  const promotePending = useCallback(
    (entry, imgElement) => {
      const commit = () => {
        if (!mountedRef.current) return;
        clearAttempt();
        setDisplayed((cur) =>
          cur && cur.nodeSrc === entry.nodeSrc && cur.url === entry.url && cur.tier === entry.tier
            ? cur
            : { nodeSrc: entry.nodeSrc, url: entry.url, tier: entry.tier }
        );
        setPending((cur) => (cur && cur.url === entry.url ? null : cur));
        setFailed(false);
      };
      if (imgElement && typeof imgElement.decode === "function") {
        imgElement.decode().then(commit, commit);
      } else {
        commit();
      }
    },
    [clearAttempt]
  );

  const handlePendingError = useCallback(
    (entry) => {
      // Recover transparently if a direct signed storage URL fails or expires.
      if (entry.isDirect) {
        forgetDirectUrl(entry.nodeSrc, entry.tier);
        const fallback = fallbackUrlFor(entry.nodeSrc, entry.tier);
        setPending({ nodeSrc: entry.nodeSrc, url: fallback, tier: entry.tier, isDirect: false });
        return;
      }
      clearAttempt();
      setPending(null);
      if (retry >= RETRY_DELAYS_MS.length) {
        if (displayed?.nodeSrc !== node.src) setFailed(true);
        return;
      }
      retryTimer.current = window.setTimeout(() => {
        setFailed(false);
        setRetry((current) => current + 1);
      }, RETRY_DELAYS_MS[retry]);
    },
    [clearAttempt, retry, displayed?.nodeSrc, node.src]
  );

  const activeDisplayed = displayed && displayed.nodeSrc === node.src ? displayed : null;
  const activePending =
    pending && pending.nodeSrc === node.src && pending.url !== activeDisplayed?.url ? pending : null;

  const imageStyle = {
    width: renderedW,
    height: renderedH,
    left: -crop.x * Math.max(0, renderedW - node.w),
    top: -crop.y * Math.max(0, renderedH - node.h),
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
        // On a rotated image the drag is read along the image's own axes.
        const moved = rotatePoint(
          { x: event.clientX - cropDrag.current.x, y: event.clientY - cropDrag.current.y },
          { x: 0, y: 0 },
          -nodeRotation(node)
        );
        onCropChange?.({
          x: cropDrag.current.crop.x - moved.x / overflowX,
          y: cropDrag.current.crop.y - moved.y / overflowY,
        });
      } : undefined}
      onPointerUp={cropMode ? (event) => { event.stopPropagation(); cropDrag.current = null; } : undefined}
      onWheel={cropMode ? (event) => {
        event.preventDefault(); event.stopPropagation();
        onCropChange?.({ zoom: crop.zoom * Math.exp(-event.deltaY * 0.002) });
      } : undefined}
    >
      {shouldLoad && !activeDisplayed && !failed && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/25">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {failed && !activeDisplayed && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/25">
          <ImageOff className="h-5 w-5" />
        </div>
      )}
      {activeDisplayed && (
        <img
          key={activeDisplayed.url}
          src={activeDisplayed.url}
          alt={node.alt || ""}
          decoding="async"
          draggable={false}
          data-image-tier={activeDisplayed.tier === null ? "full" : String(activeDisplayed.tier)}
          className="absolute max-w-none select-none"
          style={{ ...imageStyle, opacity: 1 }}
        />
      )}
      {activePending && (
        <img
          key={activePending.url}
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0) {
              promotePending(activePending, el);
            }
          }}
          src={activePending.url}
          alt={activeDisplayed ? "" : node.alt || ""}
          aria-hidden={activeDisplayed ? true : undefined}
          loading="eager"
          decoding="async"
          fetchPriority={inViewport && !activeDisplayed ? "high" : "low"}
          draggable={false}
          onLoad={(e) => promotePending(activePending, e.currentTarget)}
          onError={() => handlePendingError(activePending)}
          className="pointer-events-none absolute max-w-none select-none transition-opacity duration-150"
          style={{ ...imageStyle, opacity: 0 }}
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
});
