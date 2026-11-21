"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useDirectMediaUrl } from "@/lib/media-resolver";
import { inlineMediaUrl } from "@/lib/utils";

/**
 * Full-resolution lightbox for inspecting a board image at native quality.
 * Loads the untouched original master on demand (never a thumbnail) and lets
 * reviewers toggle fit-to-screen vs 1:1 native pixels or download the master.
 */
export function BoardImageLightbox({ node, onClose }) {
  const [loaded, setLoaded] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const direct = useDirectMediaUrl(node?.src || null, null);
  const downloadHref = inlineMediaUrl(node?.src) || node?.src;

  useEffect(() => {
    setLoaded(false);
    setActualSize(false);
  }, [node?.src]);

  useEffect(() => {
    if (!node) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [node, onClose]);

  if (!node || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={node.alt ? `Full resolution view: ${node.alt}` : "Full resolution image"}
      data-testid="board-image-lightbox"
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-ink-900/90 px-4 py-2.5 text-xs text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 truncate font-medium">
          {node.alt || "Image"}
          {node.naturalW && node.naturalH ? (
            <span className="ml-2 text-white/45">{node.naturalW} × {node.naturalH}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActualSize((v) => !v)}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-white/85 hover:bg-white/20 hover:text-white"
          >
            {actualSize ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
            {actualSize ? "Fit screen" : "100%"}
          </button>
          {downloadHref && (
            <a
              href={downloadHref}
              download={node.alt || ""}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-white/85 hover:bg-white/20 hover:text-white"
            >
              <Download className="h-3.5 w-3.5" />
              Original
            </a>
          )}
          <button
            type="button"
            aria-label="Close full resolution view"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg bg-white/10 text-white/85 hover:bg-white/20 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
        onClick={onClose}
      >
        {!loaded && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/60">
            <Loader2 className="h-7 w-7 animate-spin" />
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={direct.src}
          alt={node.alt || ""}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (!direct.onError()) setLoaded(true);
          }}
          onClick={(e) => e.stopPropagation()}
          className={actualSize ? "max-w-none select-none" : "max-h-full max-w-full object-contain select-none"}
          style={{ opacity: loaded ? 1 : 0 }}
        />
      </div>
    </div>,
    document.body
  );
}
