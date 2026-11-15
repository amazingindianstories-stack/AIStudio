"use client";

import { generationPieces, layeredResultLabel } from "@/lib/layered-generations";
import { useDirectMediaUrl } from "@/lib/media-resolver";
import { cn } from "@/lib/utils";

function PieceThumbnail({ piece, decorative = false }) {
  const media = useDirectMediaUrl(piece.url, 320);
  return (
    <div className="layer-checkerboard relative h-full w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.src} alt={decorative ? "" : piece.label} loading="lazy" decoding="async"
        onError={() => media.onError()} className="h-full w-full object-contain" />
    </div>
  );
}

/** Cards identify the separate outputs instead of suggesting a blank composite. */
export function LayeredCardPreview({ item }) {
  const pieces = generationPieces(item).filter((piece) => piece.key !== "source");
  return (
    <div data-layered-preview className="absolute inset-0 flex flex-col bg-ink-900">
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-px">
        {pieces.slice(0, 4).map((piece) => <PieceThumbnail key={piece.key} piece={piece} />)}
      </div>
      <p className="shrink-0 bg-ink-900 px-2 py-1 text-center text-[10px] font-medium text-white/85">
        {layeredResultLabel(pieces)}
      </p>
    </div>
  );
}

export function LayerPicker({ pieces, selectedKey, onSelect }) {
  const selected = pieces.find((piece) => piece.key === selectedKey);
  return (
    <section data-testid="layer-list" className="mb-5" aria-label="Layered result">
      <p className="mb-2 text-xs font-medium text-white/80">{layeredResultLabel(pieces)}</p>
      <p className="mb-3 text-xs text-white/45">Choose a piece to view, download or use as reference. Source is the original input.</p>
      <div className="grid grid-cols-3 gap-2">
        {pieces.map((piece) => (
          <button key={piece.key} type="button" aria-pressed={selectedKey === piece.key}
            onClick={() => onSelect(piece.key)}
            title={[piece.label, piece.width && piece.height && `${piece.width}×${piece.height}`, piece.textRecognition?.text].filter(Boolean).join(" · ")}
            className={cn("overflow-hidden rounded-lg border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
              selectedKey === piece.key ? "border-brand text-brand" : "border-line text-white/65 hover:border-white/40")}>
            <div className="h-20"><PieceThumbnail piece={piece} decorative /></div>
            <span className="block px-2 py-1.5 text-xs">{piece.label}</span>
          </button>
        ))}
      </div>
      {selected?.width && selected?.height && (
        <p className="mt-2 text-xs text-white/45">{selected.width}×{selected.height}</p>
      )}
      {selected?.textRecognition?.text && (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-white/70">{selected.textRecognition.text}</p>
      )}
    </section>
  );
}
