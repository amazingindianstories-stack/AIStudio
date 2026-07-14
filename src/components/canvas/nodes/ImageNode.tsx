"use client";

import type { ImageNode as ImageNodeData } from "@/lib/canvas/types";

/**
 * `<img>` from an already-resolved `/api/media/...` URL. No client-side URL
 * building here — `src` is consumed directly (asset panel / upload already
 * resolved it). Video assets are placed as a static poster/thumbnail image
 * node (see spec Non-goals) so this component never needs a `<video>` tag.
 */
export function ImageNode({ node }: { node: ImageNodeData }) {
  return (
    <div className="h-full w-full overflow-hidden rounded-md bg-ink-800 ring-1 ring-white/5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={node.src}
        alt={node.alt || ""}
        draggable={false}
        className="h-full w-full select-none object-cover"
      />
    </div>
  );
}
