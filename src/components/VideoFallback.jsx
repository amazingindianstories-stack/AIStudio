import React from "react";
import { Video } from "lucide-react";

/**
 * Shown where a native MOV master cannot be decoded by this browser. The
 * original bytes stay the download; this only replaces a dead black player.
 * `compact` is the tile variant: icon, duration and a short line, no button.
 */
export function VideoFallback({ href, filename, compact = false, duration, className = "" }) {
  if (compact) {
    return (
      <div
        data-video-fallback="compact"
        className={"flex flex-col items-center justify-center gap-1.5 bg-ink-800 p-4 text-center " + className}
      >
        <Video className="h-6 w-6 text-white/60" aria-hidden="true" />
        {duration ? <span className="text-[11px] tabular-nums text-white/60">{duration}</span> : null}
        <span className="text-[11px] text-muted">Preview unavailable. Open to download the original.</span>
      </div>
    );
  }
  return (
    <div
      data-video-fallback="full"
      className={"flex flex-col items-center justify-center gap-4 p-6 text-center text-white/80 " + className}
    >
      <p>This browser cannot play this video. Download the original for full-quality playback.</p>
      <a href={href} download={filename || true} className="rounded-lg bg-brand px-4 py-2 text-ink-900">
        Download original
      </a>
    </div>
  );
}
