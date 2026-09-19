"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
  Box,
} from "lucide-react";
import { inlineMediaUrl } from "@/lib/utils";
import { KIND_ICON, KIND_LABEL } from "./AssetLibrary";

export function AssetLightbox({
  asset,
  assets = [],
  onClose,
  onSelectAsset,
  onAttach,
  onEdit,
  onDelete,
}) {
  const [copiedSlug, setCopiedSlug] = useState(false);
  const [attached, setAttached] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const containerRef = useRef(null);

  const currentIndex = assets.findIndex((a) => a.id === asset?.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < assets.length - 1;

  const goToPrev = useCallback(() => {
    if (hasPrev && onSelectAsset) {
      setIsZoomed(false);
      onSelectAsset(assets[currentIndex - 1]);
    }
  }, [hasPrev, onSelectAsset, assets, currentIndex]);

  const goToNext = useCallback(() => {
    if (hasNext && onSelectAsset) {
      setIsZoomed(false);
      onSelectAsset(assets[currentIndex + 1]);
    }
  }, [hasNext, onSelectAsset, assets, currentIndex]);

  // Keyboard navigation & escape key
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, goToPrev, goToNext]);

  // Reset zoom and feedback when active asset changes
  useEffect(() => {
    setIsZoomed(false);
    setAttached(false);
    setCopiedSlug(false);
  }, [asset?.id]);

  if (!asset) return null;

  const imageUrl = asset.images?.[0] || asset.image || "";
  const Icon = KIND_ICON[asset.kind] || Box;
  const kindLabel = KIND_LABEL[asset.kind] || asset.kind || "Material";

  const handleCopySlug = () => {
    if (!asset.slug) return;
    navigator.clipboard.writeText(`@${asset.slug}`).then(() => {
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
      const res = await fetch(targetUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(asset.slug || asset.name || "material-sheet").replace(/\s+/g, "-")}.png`;
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
      role="dialog"
      aria-modal="true"
      aria-label="Material Sheet Full View"
      className="fixed inset-0 z-[120] flex flex-col items-center justify-between bg-black/95 p-3 sm:p-5 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top Header Controls Bar */}
      <header className="relative z-10 flex w-full max-w-6xl items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink-900/90 px-4 py-2.5 shadow-2xl backdrop-blur-lg">
        {/* Left: Metadata info & badges */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
            <Icon className="h-4 w-4" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-white">
                {asset.name}
              </h3>
              <span className="hidden rounded bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70 sm:inline-block">
                {kindLabel}
              </span>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-white/50">
              <button
                type="button"
                onClick={handleCopySlug}
                title="Click to copy @mention tag"
                className="flex items-center gap-1 font-mono text-xs font-semibold text-white/80 transition hover:text-white"
              >
                <span>{`@${asset.slug}`}</span>
                {copiedSlug ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3 text-white/40" />
                )}
              </button>
              {copiedSlug && (
                <span className="text-[10px] text-emerald-400 font-medium">Copied!</span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Action Buttons */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Attach / Use in Prompt */}
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

          {/* Zoom Toggle Button */}
          <button
            type="button"
            onClick={() => setIsZoomed((v) => !v)}
            title={isZoomed ? "Fit to screen" : "Zoom in 2x"}
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            {isZoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </button>

          {/* Download Button */}
          <button
            type="button"
            onClick={handleDownload}
            title="Download full material sheet"
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            <Download className="h-4 w-4" />
          </button>

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

      {/* Main Center Image Viewport */}
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

        {/* Central Turnaround Sheet with Zoom Support */}
        <div
          ref={containerRef}
          className={`relative flex h-full max-h-[78dvh] w-full items-center justify-center overflow-auto rounded-2xl border border-white/10 bg-ink-950 p-2 shadow-2xl ring-1 ring-white/10 scroll-thin ${
            isZoomed ? "cursor-zoom-out" : "cursor-zoom-in"
          }`}
          onClick={() => setIsZoomed((v) => !v)}
        >
          <AnimatePresence mode="wait">
            <motion.img
              key={asset.id + (isZoomed ? "-zoomed" : "-fit")}
              src={imageUrl}
              alt={asset.name || "Material Sheet"}
              initial={{ opacity: 0, scale: isZoomed ? 1.5 : 0.97 }}
              animate={{ opacity: 1, scale: isZoomed ? 2 : 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className={`select-none transition-all duration-200 ${
                isZoomed
                  ? "max-w-none origin-center transform p-8"
                  : "max-h-[76dvh] max-w-[88vw] object-contain"
              }`}
            />
          </AnimatePresence>
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
      <footer className="relative z-10 flex w-full max-w-6xl items-center justify-between px-4 py-2 text-xs text-white/50">
        <div className="flex items-center gap-2">
          {assets.length > 1 && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-medium text-white/80">
              {currentIndex + 1} of {assets.length}
            </span>
          )}
          <span className="hidden sm:inline">
            Use ← → arrows to navigate • Esc to close • Click image to toggle 2x zoom
          </span>
        </div>

        <div className="flex items-center gap-3 max-w-md truncate">
          {asset.description ? (
            <span className="truncate text-white/70" title={asset.description}>
              Visual Guidance: <strong className="text-white/90 font-normal">{asset.description}</strong>
            </span>
          ) : asset.createdAt ? (
            <span className="hidden sm:inline">
              Added {new Date(asset.createdAt).toLocaleDateString()}
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
