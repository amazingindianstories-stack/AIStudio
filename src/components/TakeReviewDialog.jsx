import { useRef, useState } from "react";
import { handoffManifest } from "@/lib/handoff";
import { apiUrl } from "@/lib/api";
import { useDialogFocus } from "./useDialogFocus";

export function TakeReviewDialog({ items, onClose }) {
  const [ordered, setOrdered] = useState(items);
  const root = useRef(null);
  useDialogFocus(root, true);
  const move = (index, direction) =>
    setOrdered((current) => {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
  const download = () => {
    const manifest = handoffManifest(ordered, window.location.origin);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(manifest, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "veevee-ordered-handoff.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div
      className="fixed inset-0 z-[70] overflow-y-auto bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Compare takes and prepare handoff"
      ref={root}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            Compare takes &amp; ordered handoff
          </h2>
          <button className="rounded bg-white/10 px-4 py-2" onClick={onClose}>
            Close comparison
          </button>
        </div>
        <p className="my-3 text-sm text-white/70">
          Compare media and settings side by side. Reorder the selection for
          handoff. The JSON manifest includes prompts, references, lineage,
          review status and authorized media links; it does not contain media
          files.
        </p>
        <button
          className="mb-4 rounded bg-brand px-4 py-2 font-semibold text-ink-900"
          onClick={download}
        >
          Download ordered manifest
        </button>
        <div className="grid gap-4 md:grid-cols-2">
          {ordered.map((item, index) => (
            <article
              key={item.id}
              className="min-w-0 rounded-xl border border-white/20 bg-ink-800 p-3"
            >
              <div className="mb-2 flex flex-wrap gap-3">
                <h3 className="mr-auto font-semibold">
                  {index + 1}.{" "}
                  {item.productionMetadata?.shot || "Shot unspecified"} ·{" "}
                  {item.productionMetadata?.take || item.id.slice(0, 8)}
                </h3>
                <button disabled={!index} onClick={() => move(index, -1)}>
                  Move earlier
                </button>
                <button
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Move later
                </button>
              </div>
              {item.kind === "image" ? (
                <img
                  alt={`Take ${index + 1}`}
                  src={apiUrl(item.url)}
                  className="h-64 w-full bg-black object-contain"
                />
              ) : (
                <video
                  src={apiUrl(item.url)}
                  poster={item.poster ? apiUrl(item.poster) : undefined}
                  controls
                  playsInline
                  className="h-64 w-full bg-black object-contain"
                />
              )}
              <p className="mt-2 text-sm">
                {item.model} · {item.resolution} · {item.aspectRatio}
                {item.duration ? ` · ${item.duration}s` : ""} · Seed{" "}
                {item.seed ?? "not recorded"}
              </p>
              <p className="text-sm">
                Review:{" "}
                {(
                  item.productionMetadata?.reviewStatus || "candidate"
                ).replaceAll("_", " ")}{" "}
                · Scene {item.productionMetadata?.scene || "unspecified"}
              </p>
              {item.productionMetadata?.review && (
                <p className="text-sm text-white/80">
                  Reviewed by{" "}
                  {item.productionMetadata.review.reviewerName || "Team member"}{" "}
                  ·{" "}
                  {new Date(item.productionMetadata.review.at).toLocaleString()}
                </p>
              )}
              <details className="mt-2 text-sm text-white/80">
                <summary>Prompt, references &amp; notes</summary>
                <p className="whitespace-pre-wrap break-words">{item.prompt}</p>
                <p>{item.productionMetadata?.notes}</p>
                {[
                  ...(item.referenceImages || []),
                  ...(item.referenceVideos || []),
                ].map((ref, n) => (
                  <a
                    className="mr-3 underline"
                    key={n}
                    href={apiUrl(ref)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Reference {n + 1}
                  </a>
                ))}
              </details>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
