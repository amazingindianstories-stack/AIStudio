"use client";

import { useEffect, useState, useCallback } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Trash2,
  Sparkles,
  Check,
  Pencil,
  Eye,
  ExternalLink,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { downloadPortrait, portraitAttachable, portraitStateLabel } from "@/lib/portraits";

export function PortraitLightbox({
  asset,
  embedded = false,
  assets = [],
  onClose,
  onSelectAsset,
  onAttach,
  onDelete,
  onRename,
}) {
  const [addedPrompt, setAddedPrompt] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(asset?.name || "");
  const [isZoomed, setIsZoomed] = useState(false);

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

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e) => {
      if (editingName || e.target?.matches?.("input, textarea, select")) return;
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
  }, [editingName, onClose, goToPrev, goToNext]);

  // Keep name input in sync with asset
  useEffect(() => {
    setNameInput(asset?.name || "");
    setEditingName(false);
    setAddedPrompt(false);
    setIsZoomed(false);
  }, [asset]);

  if (!asset) return null;
  const stateLabel = portraitStateLabel(asset);

  // Beside the name when embedded; at the end of the action row when full screen.
  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close Lightbox"
      className="grid h-8 w-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white"
    >
      <X className="h-4 w-4" />
    </button>
  );

  const handleAttach = () => {
    onAttach(asset);
    setAddedPrompt(true);
    setTimeout(() => setAddedPrompt(false), 2500);
  };

  const handleSaveName = async () => {
    if (nameInput.trim() && nameInput.trim() !== asset.name) {
      const result = await onRename(asset.id, nameInput.trim());
      if (result?.ok === false) return;
    }
    setEditingName(false);
  };

  return (
    <div
      role={embedded ? "complementary" : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label="Portrait Full View"
      className={embedded ? "absolute inset-0 z-10 flex w-full shrink-0 flex-col overflow-y-auto border-l border-line bg-ink-900 p-3 sm:static sm:w-[280px]" : "fixed inset-0 z-[120] flex flex-col items-center justify-between bg-black/92 p-3 sm:p-5 backdrop-blur-md"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top Header Controls Bar */}
      <header className={embedded
        ? "relative z-10 grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-3 rounded-xl border border-white/10 bg-ink-900/90 p-3 shadow-lg"
        : "relative z-10 flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink-900/90 px-4 py-2.5 shadow-lg backdrop-blur-lg"}>
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
            <Eye className="h-4 w-4" />
          </div>

          <div className="min-w-0">
            {editingName ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={nameInput}
                  autoFocus
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  className="h-7 w-48 rounded border border-brand bg-ink-950 px-2 text-xs text-white focus:outline-none"
                />
                <button
                  onClick={handleSaveName}
                  className="grid h-7 w-7 place-items-center rounded bg-white text-zinc-950 hover:bg-zinc-200"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setEditingName(false)}
                  className="grid h-7 w-7 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-white">
                  {asset.name || "Portrait"}
                </h3>
                <button
                  onClick={() => setEditingName(true)}
                  title="Rename portrait"
                  className="grid h-5 w-5 place-items-center rounded text-white/40 hover:text-white"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
            <div className="text-[11px] text-white/50">
              <span>Portrait</span>
            </div>
          </div>
        </div>

        {embedded && closeButton}

        {/* Action Buttons */}
        <div className={embedded ? "col-span-2 grid grid-cols-3 gap-1.5 [&>button:not(:first-child)]:w-full" : "flex flex-wrap items-center gap-1.5 sm:gap-2"}>
          {/* Use in Prompt */}
          <button
            type="button"
            disabled={!portraitAttachable(asset)}
            onClick={handleAttach}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
              embedded ? "col-span-3 justify-center" : ""
            } ${
              addedPrompt
                ? "bg-emerald-500 text-zinc-950 font-bold"
                : "bg-white text-zinc-950 hover:bg-zinc-200"
            }`}
          >
            {addedPrompt ? (
              <>
                <Check className="h-3.5 w-3.5" /> Added to Prompt!
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" /> Use in Prompt
              </>
            )}
          </button>

          {/* Zoom Toggle */}
          <button
            type="button"
            onClick={() => setIsZoomed((v) => !v)}
            title={isZoomed ? "Fit to screen" : "Zoom in 2x"}
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            {isZoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </button>

          {/* Download */}
          <button
            type="button"
            onClick={() => void downloadPortrait(asset)}
            title="Download high-resolution image"
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            <Download className="h-4 w-4" />
          </button>

          {/* Open full raw in new tab */}
          {!embedded && asset.imageUrl && (
            <a
              href={asset.imageUrl}
              target="_blank"
              rel="noreferrer"
              title="Open full raw URL in new tab"
              className="hidden sm:grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          {/* Delete */}
          <button
            type="button"
            onClick={() => onDelete(asset)}
            title="Delete this portrait"
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/60 transition hover:border-red-500/50 hover:bg-red-500/20 hover:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          {!embedded && (
            <>
              <div className="mx-1 h-5 w-px bg-white/15" />
              {closeButton}
            </>
          )}
        </div>
      </header>

      {/* Main Center Image Display with Navigation Arrows */}
      <div className="relative flex flex-1 w-full max-w-5xl items-center justify-center py-2 sm:py-4">
        {/* Previous Button */}
        {hasPrev && (
          <button
            type="button"
            onClick={goToPrev}
            aria-label="Previous portrait"
            className="absolute left-2 sm:left-4 z-20 grid h-10 w-10 sm:h-12 sm:w-12 place-items-center rounded-full bg-ink-900/80 text-white/80 shadow-xl backdrop-blur-md transition hover:scale-110 hover:bg-ink-850 hover:text-white ring-1 ring-white/15"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        {/* Central High-Resolution Image with Zoom Support */}
        <div
          className={`relative flex h-full max-h-[78dvh] w-full items-center justify-center overflow-auto rounded-2xl border border-white/10 bg-ink-950 p-2 shadow-2xl ring-1 ring-white/10 scroll-thin ${
            isZoomed ? "cursor-zoom-out" : "cursor-zoom-in"
          }`}
          onClick={() => setIsZoomed((v) => !v)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.imageUrl}
            alt={asset.name || "Portrait"}
            className={`select-none transition-all duration-200 ${
              isZoomed
                ? "max-w-none origin-center transform p-8 scale-150"
                : "max-h-[76dvh] max-w-[85vw] object-contain"
            }`}
          />

          {/* Status Badge Over Image */}
          {!isZoomed && stateLabel && (
            <div className="absolute left-3 top-3 flex items-center gap-2 pointer-events-none">
              <span
                title={asset.message || undefined}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold backdrop-blur-md shadow-md ${
                  asset.state === "unusable" ? "bg-red-500/25 text-red-300 ring-1 ring-red-500/40" : "bg-ink-950/85 text-amber-200 ring-1 ring-amber-500/40"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${asset.state === "unusable" ? "bg-red-400" : "bg-amber-300"}`} />
                {stateLabel}
              </span>
            </div>
          )}
        </div>

        {/* Next Button */}
        {hasNext && (
          <button
            type="button"
            onClick={goToNext}
            aria-label="Next portrait"
            className="absolute right-2 sm:right-4 z-20 grid h-10 w-10 sm:h-12 sm:w-12 place-items-center rounded-full bg-ink-900/80 text-white/80 shadow-xl backdrop-blur-md transition hover:scale-110 hover:bg-ink-850 hover:text-white ring-1 ring-white/15"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Bottom Counter & Help Footer */}
      <footer className={embedded ? "relative z-10 flex w-full flex-col items-start gap-2 py-2 text-xs text-white/50" : "relative z-10 flex w-full max-w-5xl items-center justify-between px-4 py-2 text-xs text-white/50"}>
        <div className="flex items-center gap-2">
          {assets.length > 1 && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-medium text-white/80">
              {currentIndex + 1} of {assets.length}
            </span>
          )}
          {!embedded && <span className="hidden sm:inline">Use ← → arrows to navigate • Esc to close • Click image to toggle zoom</span>}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="max-w-full truncate" title={asset.createdBy?.name || "Added automatically"}>{asset.createdBy?.name || "Added automatically"}</span>
          {asset.createdAt && (
            <span className={embedded ? "w-full" : "hidden sm:inline"}>
              Added {new Date(asset.createdAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
