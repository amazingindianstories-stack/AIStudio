"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Trash2,
  Sparkles,
  Copy,
  Check,
  Pencil,
  Eye,
  ExternalLink,
} from "lucide-react";
import { inlineMediaUrl } from "@/lib/utils";

export function PortraitLightbox({
  asset,
  assets = [],
  groupName = "General Character",
  onClose,
  onSelectAsset,
  onAttach,
  onDelete,
  onRename,
}) {
  const [copiedId, setCopiedId] = useState(false);
  const [addedPrompt, setAddedPrompt] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(asset?.name || "");

  const currentIndex = assets.findIndex((a) => (a.id || a.byteplusAssetId) === (asset?.id || asset?.byteplusAssetId));
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < assets.length - 1;

  const goToPrev = useCallback(() => {
    if (hasPrev && onSelectAsset) {
      onSelectAsset(assets[currentIndex - 1]);
    }
  }, [hasPrev, onSelectAsset, assets, currentIndex]);

  const goToNext = useCallback(() => {
    if (hasNext && onSelectAsset) {
      onSelectAsset(assets[currentIndex + 1]);
    }
  }, [hasNext, onSelectAsset, assets, currentIndex]);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e) => {
      if (editingName) return;
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
  }, [asset]);

  if (!asset) return null;

  const handleCopyId = () => {
    const idToCopy = asset.byteplusAssetId || asset.id;
    if (!idToCopy) return;
    navigator.clipboard.writeText(idToCopy).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    });
  };

  const handleAttach = () => {
    onAttach(asset, asset.name || groupName || "Character");
    setAddedPrompt(true);
    setTimeout(() => setAddedPrompt(false), 2500);
  };

  const handleSaveName = async () => {
    if (nameInput.trim() && nameInput.trim() !== asset.name) {
      await onRename(asset.id || asset.byteplusAssetId, nameInput.trim());
    }
    setEditingName(false);
  };

  const handleDownload = async () => {
    if (!asset.imageUrl) return;
    try {
      const targetUrl = inlineMediaUrl(asset.imageUrl);
      const res = await fetch(targetUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(asset.name || "virtual-portrait").replace(/\s+/g, "-")}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: direct window open if cross-origin fetch is blocked
      window.open(asset.imageUrl, "_blank");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Portrait Full View"
      className="fixed inset-0 z-[120] flex flex-col items-center justify-between bg-black/92 p-3 sm:p-5 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top Header Controls Bar */}
      <header className="relative z-10 flex w-full max-w-5xl items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink-900/90 px-4 py-2.5 shadow-lg backdrop-blur-lg">
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
                  className="grid h-7 w-7 place-items-center rounded bg-brand text-ink-950 hover:bg-brand-light"
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
                  {asset.name || "Virtual Portrait"}
                </h3>
                <button
                  onClick={() => setEditingName(true)}
                  title="Rename portrait"
                  className="grid h-5 w-5 place-items-center rounded text-white/40 hover:text-white"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <span className="hidden rounded bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70 sm:inline-block">
                  {groupName}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-[11px] text-white/50">
              <span>Virtual Portrait</span>
              {asset.byteplusAssetId && (
                <>
                  <span>•</span>
                  <button
                    onClick={handleCopyId}
                    title="Copy BytePlus ModelArk Asset ID"
                    className="flex items-center gap-1 font-mono text-[10px] text-white/60 hover:text-brand"
                  >
                    <span>{asset.byteplusAssetId}</span>
                    {copiedId ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Use in Prompt */}
          <button
            type="button"
            onClick={handleAttach}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm transition ${
              addedPrompt
                ? "bg-emerald-500 text-ink-950"
                : "bg-brand text-ink-950 hover:bg-brand-light"
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

          {/* Download */}
          <button
            type="button"
            onClick={handleDownload}
            title="Download high-resolution image"
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-ink-800 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            <Download className="h-4 w-4" />
          </button>

          {/* Open full raw in new tab */}
          {asset.imageUrl && (
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

          <div className="mx-1 h-5 w-px bg-white/15" />

          {/* Close */}
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

        {/* Central High-Resolution Image */}
        <motion.div
          key={asset.id || asset.byteplusAssetId || asset.imageUrl}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="relative flex max-h-[76dvh] max-w-full items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-ink-950 shadow-2xl ring-1 ring-white/10"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.imageUrl}
            alt={asset.name || "Virtual Portrait"}
            className="max-h-[76dvh] max-w-[85vw] object-contain select-none"
          />

          {/* Status Badge Over Image */}
          <div className="absolute left-3 top-3 flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold backdrop-blur-md shadow-md ${
                asset.status === "Processing"
                  ? "bg-amber-500/25 text-amber-300 ring-1 ring-amber-500/40"
                  : asset.status === "Failed"
                  ? "bg-red-500/25 text-red-300 ring-1 ring-red-500/40"
                  : "bg-ink-950/85 text-emerald-400 ring-1 ring-emerald-500/40"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  asset.status === "Processing"
                    ? "bg-amber-400 animate-ping"
                    : asset.status === "Failed"
                    ? "bg-red-400"
                    : "bg-emerald-400"
                }`}
              />
              {asset.status === "Processing"
                ? "Syncing with BytePlus"
                : asset.status === "Failed"
                ? "Sync Failed"
                : "Active • ModelArk Ready"}
            </span>
          </div>
        </motion.div>

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
      <footer className="relative z-10 flex w-full max-w-5xl items-center justify-between px-4 py-2 text-xs text-white/50">
        <div className="flex items-center gap-2">
          {assets.length > 1 && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-medium text-white/80">
              {currentIndex + 1} of {assets.length}
            </span>
          )}
          <span className="hidden sm:inline">Use left and right arrow keys to navigate portraits</span>
        </div>

        <div className="flex items-center gap-3">
          <span>Role: <strong className="text-white/80">{asset.role || "reference"}</strong></span>
          {asset.createdAt && (
            <span className="hidden sm:inline">
              Added {new Date(asset.createdAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
