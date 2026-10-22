"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Trash2,
  Paperclip,
  Copy,
  Check,
  Pencil,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  Clapperboard,
  AudioLines,
  Image as ImageIcon,
  Box,
} from "lucide-react";
import { inlineMediaUrl } from "@/lib/utils";
import { extensionForContentType } from "@/lib/client-reference-upload";
import { fetchRetryBusy } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { notify } from "@/lib/notify";
import { KIND_ICON, KIND_LABEL } from "./AssetLibrary";

export const MIN_LIGHTBOX_ZOOM = 0.5;
export const MAX_LIGHTBOX_ZOOM = 5;
export const DEFAULT_LIGHTBOX_ZOOM = 1;
export const LIGHTBOX_ZOOM_STEP = 0.25;

const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;
const WHEEL_ZOOM_PER_PX = 0.002;
const PINCH_ZOOM_PER_PX = 0.01;

export function clampLightboxZoom(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIGHTBOX_ZOOM;
  return Math.min(MAX_LIGHTBOX_ZOOM, Math.max(MIN_LIGHTBOX_ZOOM, num));
}

export function stepLightboxZoom(current, direction) {
  const delta = direction > 0 ? LIGHTBOX_ZOOM_STEP : -LIGHTBOX_ZOOM_STEP;
  return clampLightboxZoom(current + delta);
}

/** Zoom proportionally to the scrolled distance, so a trackpad's many small deltas and a
 * wheel's few large notches both cover the same range for the same physical gesture. */
export function computeWheelZoom(current, deltaY, isPinch = false, deltaMode = 0) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return current;
  const px = deltaY * (deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1);
  return clampLightboxZoom(current * Math.exp(-px * (isPinch ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX)));
}

export function AssetLightbox({
  embedded = false,
  asset,
  assets = [],
  onClose,
  onSelectAsset,
  onAttach,
  onInsertTag,
  onEdit,
  onDelete,
  returnFocusEl = null,
  dialogLabel = "Material Sheet Full View",
}) {
  const [copiedSlug, setCopiedSlug] = useState(false);
  const [attached, setAttached] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_LIGHTBOX_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panGestureRef = useRef(null);
  const containerRef = useRef(null);
  const dialogRef = useRef(null);

  const isZoomed = zoom > DEFAULT_LIGHTBOX_ZOOM;
  const mediaType = asset?.mediaType || "image";
  const zoomable = mediaType === "image";

  const applyZoom = useCallback((nextZoomOrUpdater) => {
    setZoom((prev) => {
      const raw = typeof nextZoomOrUpdater === "function" ? nextZoomOrUpdater(prev) : nextZoomOrUpdater;
      const clamped = clampLightboxZoom(raw);
      if (clamped <= DEFAULT_LIGHTBOX_ZOOM) {
        setPan({ x: 0, y: 0 });
      }
      return clamped;
    });
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(DEFAULT_LIGHTBOX_ZOOM);
    setPan({ x: 0, y: 0 });
  }, []);

  const currentIndex = assets.findIndex((a) => a.id === asset?.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < assets.length - 1;

  const goToPrev = useCallback(() => {
    if (hasPrev && onSelectAsset) {
      resetZoom();
      onSelectAsset(assets[currentIndex - 1]);
    }
  }, [hasPrev, onSelectAsset, assets, currentIndex, resetZoom]);

  const goToNext = useCallback(() => {
    if (hasNext && onSelectAsset) {
      resetZoom();
      onSelectAsset(assets[currentIndex + 1]);
    }
  }, [hasNext, onSelectAsset, assets, currentIndex, resetZoom]);

  const handlersRef = useRef({ onClose, goToPrev, goToNext, applyZoom, resetZoom, returnFocusEl, zoomable });
  handlersRef.current = { onClose, goToPrev, goToNext, applyZoom, resetZoom, returnFocusEl, zoomable };

  // The inspector owns its focus while open; portal confirmations own theirs.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previousFocus = handlersRef.current.returnFocusEl || document.activeElement;
    const childModalOpen = () => Array.from(document.querySelectorAll('[role="alertdialog"][aria-modal="true"]'))
      .some((element) => !element.hidden && element.getClientRects().length > 0);
    const controls = () => Array.from(dialog.querySelectorAll('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
      .filter((element) => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0);
    const focusFirst = () => (controls()[0] || dialog).focus();
    const frame = requestAnimationFrame(focusFirst);
    const onKeyDown = (event) => {
      if (event.defaultPrevented || childModalOpen()) return;
      const h = handlersRef.current;
      const inMediaControls = Boolean(event.target?.closest?.("video, audio"));
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); h.onClose?.(); }
      else if (h.zoomable && (event.key === "+" || event.key === "=")) { event.preventDefault(); h.applyZoom((z) => stepLightboxZoom(z, 1)); }
      else if (h.zoomable && (event.key === "-" || event.key === "_")) { event.preventDefault(); h.applyZoom((z) => stepLightboxZoom(z, -1)); }
      else if (h.zoomable && event.key === "0") { event.preventDefault(); h.resetZoom(); }
      else if (event.key === "ArrowLeft" && !inMediaControls) { event.preventDefault(); h.goToPrev(); }
      else if (event.key === "ArrowRight" && !inMediaControls) { event.preventDefault(); h.goToNext(); }
      else if (event.key === "Tab") {
        const focusable = controls(), first = focusable[0], last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onFocusIn = (event) => { if (!childModalOpen() && !dialog.contains(event.target)) focusFirst(); };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const returnEl = handlersRef.current.returnFocusEl;
      const target = returnEl?.isConnected ? returnEl : previousFocus;
      if (target?.isConnected) target.focus?.();
    };
  }, []);

  // Reset zoom and feedback when active asset changes
  useEffect(() => {
    resetZoom();
    setAttached(false);
    setCopiedSlug(false);
  }, [asset?.id, resetZoom]);

  // Prevent browser page-zoom when pinching on the stage
  useEffect(() => {
    const stage = containerRef.current;
    if (!stage || !zoomable) return undefined;
    const handleNativeWheel = (e) => {
      e.preventDefault();
      applyZoom((z) => computeWheelZoom(z, e.deltaY, e.ctrlKey || e.metaKey, e.deltaMode));
    };
    stage.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleNativeWheel);
  }, [asset?.id, applyZoom, zoomable]);

  if (!asset) return null;

  const imageUrl = asset.images?.[0] || asset.image || "";
  const Icon = mediaType === "video"
    ? Clapperboard
    : mediaType === "audio"
    ? AudioLines
    : KIND_ICON?.[asset.kind] || (asset.isComposerReference ? ImageIcon : Box);
  const kindLabel = KIND_LABEL?.[asset.kind] || asset.kind || "Material";
  const tagText = asset.tag || (asset.slug ? `@${asset.slug}` : "");

  const handleCopySlug = () => {
    if (!tagText) return;
    navigator.clipboard?.writeText(tagText).then(() => {
      setCopiedSlug(true);
      setTimeout(() => setCopiedSlug(false), 2000);
    });
  };

  const handleAttach = () => {
    if (onAttach) {
      onAttach(asset);
      setAttached(true);
      setTimeout(() => setAttached(false), 2500);
    }
  };

  const handleDownload = async () => {
    if (!imageUrl) return;
    try {
      const targetUrl = inlineMediaUrl(imageUrl);
      const res = await fetchRetryBusy(targetUrl);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        notify(apiErrorMessage(body, res.status));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const extension = extensionForContentType(blob.type) || (mediaType === "image" ? "png" : "");
      a.download = `${(asset.slug || asset.name || "material-sheet").replace(/\s+/g, "-")}${extension ? `.${extension}` : ""}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      window.open(imageUrl, "_blank");
    }
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      className={embedded ? "absolute inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col items-center justify-between overflow-hidden border-l border-line bg-ink-950 p-3" : "fixed inset-0 z-[120] flex flex-col items-center justify-between bg-black/95 p-3 sm:p-5 backdrop-blur-md"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {!asset.isComposerReference && (
        <p className="mb-1 shrink-0 self-start text-[11px] text-white/50">{asset.uploader?.name || "Unknown uploader"}</p>
      )}
      {/* Top Header Controls Bar */}
      <header className="relative z-10 flex w-full max-w-6xl shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink-900/90 px-4 py-2.5 shadow-2xl backdrop-blur-lg">
        {/* Left: Metadata info & badges */}
        <div className={embedded ? "flex w-full min-w-0 items-center gap-3" : "flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1"}>
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
            <Icon className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 title={asset.name} className="min-w-0 truncate text-sm font-semibold text-white">
                {asset.name}
              </h3>
              <span className="hidden rounded bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70 sm:inline-block">
                {kindLabel}
              </span>
            </div>

            {tagText && (
              <div className="flex items-center gap-2 text-[11px] text-white/50">
                <button
                  type="button"
                  onClick={handleCopySlug}
                  title={`Copy ${tagText}`}
                  className="flex min-w-0 max-w-full items-center gap-1 font-mono text-xs font-semibold text-mention transition hover:text-white"
                >
                  <span className="truncate">{tagText}</span>
                  {copiedSlug ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3 shrink-0 text-white/40" />
                  )}
                </button>
                {copiedSlug && (
                  <span className="text-[10px] text-emerald-400 font-medium">Copied!</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Action Buttons */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2">
          {/* Insert @tag when opened from Composer */}
          {onInsertTag && tagText && (
            <button
              type="button"
              onClick={() => {
                onInsertTag(tagText);
                onClose();
              }}
              className="flex max-w-full items-center gap-1.5 truncate rounded-lg bg-mention/20 px-3 py-1.5 text-xs font-semibold text-mention ring-1 ring-mention/40 transition hover:bg-mention/30"
            >
              Insert {tagText}
            </button>
          )}

          {/* Attach / Use in Prompt */}
          {onAttach && (
            <button
              type="button"
              onClick={handleAttach}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm transition ${
                attached
                  ? "bg-emerald-500 text-zinc-950 font-bold"
                  : "bg-white text-zinc-950 hover:bg-zinc-200"
              }`}
            >
              {attached ? (
                <>
                  <Check className="h-3.5 w-3.5" /> Attached to Prompt!
                </>
              ) : (
                <>
                  <Paperclip className="h-3.5 w-3.5" /> Attach to Composer
                </>
              )}
            </button>
          )}

          {/* Dynamic Zoom Controls */}
          {zoomable && <div className="flex items-center rounded-lg border border-white/15 bg-ink-800 p-0.5">
            <button
              type="button"
              aria-label="Zoom out"
              data-testid="lightbox-zoom-out"
              disabled={zoom <= MIN_LIGHTBOX_ZOOM}
              onClick={() => applyZoom((z) => stepLightboxZoom(z, -1))}
              title="Zoom out (-)"
              className="grid h-7 w-7 place-items-center rounded text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Reset zoom"
              data-testid="lightbox-zoom-reset"
              onClick={resetZoom}
              title="Reset zoom (0)"
              className="min-w-[46px] px-1.5 text-center font-mono text-[11px] font-medium text-white/85 transition hover:text-white"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              data-testid="lightbox-zoom-in"
              disabled={zoom >= MAX_LIGHTBOX_ZOOM}
              onClick={() => applyZoom((z) => stepLightboxZoom(z, 1))}
              title="Zoom in (+)"
              className="grid h-7 w-7 place-items-center rounded text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>}

          {/* Download Button */}
          {imageUrl && (
            <button
              type="button"
              onClick={handleDownload}
              title="Download full media"
              className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <Download className="h-4 w-4" />
            </button>
          )}

          {/* Open raw URL in new tab */}
          {imageUrl && (
            <a
              href={imageUrl}
              target="_blank"
              rel="noreferrer"
              title="Open full raw URL in new tab"
              className="hidden sm:grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          {/* Edit Button */}
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(asset)}
              title="Edit material details"
              className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Delete Button */}
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(asset)}
              title="Delete material"
              className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/60 transition hover:border-red-500/50 hover:bg-red-500/20 hover:text-red-300"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          <div className="mx-1 h-5 w-px bg-white/15" />

          {/* Close Button */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Lightbox"
            className="grid h-8 w-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Center Media Viewport */}
      <div className="relative flex flex-1 w-full max-w-6xl items-center justify-center py-2 sm:py-4 min-h-0 overflow-hidden">
        {/* Previous Button */}
        {hasPrev && (
          <button
            type="button"
            onClick={goToPrev}
            aria-label="Previous material"
            className="absolute left-2 sm:left-4 z-20 grid h-10 w-10 sm:h-12 sm:w-12 place-items-center rounded-full bg-ink-900/80 text-white/80 shadow-xl backdrop-blur-md transition hover:scale-110 hover:bg-ink-850 hover:text-white ring-1 ring-white/15"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        {/* Central Stage with Dynamic Zoom & Pan Support */}
        <div
          ref={containerRef}
          data-testid="lightbox-stage"
          data-zoom={zoom}
          data-pan-x={Math.round(pan.x)}
          data-pan-y={Math.round(pan.y)}
          className={`relative flex h-full max-h-[78dvh] w-full select-none items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-ink-950 p-2 shadow-2xl ring-1 ring-white/10 ${
            !zoomable ? "" : isZoomed ? (isPanning ? "touch-none cursor-grabbing" : "touch-none cursor-grab") : "touch-none cursor-zoom-in"
          }`}
          onDoubleClick={(e) => {
            if (!zoomable) return;
            e.preventDefault();
            if (isZoomed) resetZoom();
            else applyZoom(2);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || zoom <= DEFAULT_LIGHTBOX_ZOOM) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            panGestureRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: pan.x,
              baseY: pan.y,
            };
            setIsPanning(true);
          }}
          onPointerMove={(e) => {
            const g = panGestureRef.current;
            if (!g) return;
            const dx = e.clientX - g.startX;
            const dy = e.clientY - g.startY;
            setPan({ x: g.baseX + dx, y: g.baseY + dy });
          }}
          onPointerUp={() => {
            panGestureRef.current = null;
            setIsPanning(false);
          }}
          onPointerCancel={() => {
            panGestureRef.current = null;
            setIsPanning(false);
          }}
        >
          <div
            data-testid="lightbox-transform"
            style={{
              transform: `translate3d(${Math.round(pan.x)}px, ${Math.round(pan.y)}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
              transition: isPanning ? "none" : "transform 120ms ease-out",
            }}
            className="flex max-h-full max-w-full items-center justify-center"
          >
            {mediaType === "video" ? (
              <video
                src={imageUrl}
                controls
                playsInline
                className={embedded ? "max-h-full max-w-full object-contain" : "max-h-[74dvh] max-w-[86vw] object-contain"}
              />
            ) : mediaType === "audio" ? (
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-ink-900 px-8 py-6 text-center">
                <AudioLines className="h-10 w-10 text-mention" />
                <p className="text-sm font-medium text-white">{asset.name}</p>
                {imageUrl && <audio src={imageUrl} controls className="w-72 max-w-full" />}
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={asset.name || "Material Sheet"}
                draggable={false}
                className={`select-none ${
                  embedded ? "max-h-full max-w-full object-contain" : "max-h-[76dvh] max-w-[88vw] object-contain"
                }`}
              />
            )}
          </div>
        </div>

        {/* Next Button */}
        {hasNext && (
          <button
            type="button"
            onClick={goToNext}
            aria-label="Next material"
            className="absolute right-2 sm:right-4 z-20 grid h-10 w-10 sm:h-12 sm:w-12 place-items-center rounded-full bg-ink-900/80 text-white/80 shadow-xl backdrop-blur-md transition hover:scale-110 hover:bg-ink-850 hover:text-white ring-1 ring-white/15"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Bottom Counter & Guidance Footer */}
      <footer className="relative z-10 flex w-full max-w-6xl shrink-0 flex-wrap items-center justify-between gap-2 px-1 py-2 text-xs text-white/50">
        <div className="flex items-center gap-2">
          {assets.length > 1 && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-medium text-white/80">
              {currentIndex + 1} of {assets.length}
            </span>
          )}
          {!embedded && <span className="hidden sm:inline">{zoomable ? "Scroll/Pinch/Double-click/+/-/0 Zoom · Drag to Pan · Esc Close" : "Esc Close"}</span>}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {asset.createdAt != null && <span className="shrink-0 whitespace-nowrap">Added {new Date(asset.createdAt).toLocaleDateString()}</span>}
          {asset.description && <span className="max-w-[240px] truncate text-white/70" title={asset.description}>{asset.description}</span>}
        </div>
      </footer>
    </div>
  );
}
