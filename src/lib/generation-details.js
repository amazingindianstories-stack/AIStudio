/** Pure formatting for the details shown in a library card's context menu. */

function toMillis(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** When a generation was made and, once it has finished, how long it took.
 *  `totalMs` runs from creation (the request was accepted) to completion;
 *  `queuedMs` and `renderMs` split it at provider submission when known. */
export function generationTiming(item) {
  const created = toMillis(item?.createdAt);
  const submitted = toMillis(item?.submittedAt);
  const completed = toMillis(item?.completedAt);
  const terminal = item?.status === "succeeded" || item?.status === "failed" || item?.status === "cancelled";
  const span = (from, to) => (from != null && to != null && to >= from ? to - from : null);
  return {
    createdAt: created,
    totalMs: terminal ? span(created, completed) : null,
    queuedMs: span(created, submitted),
    renderMs: terminal ? span(submitted, completed) : null,
  };
}

/** Compact elapsed time: "42s", "3m 05s", "1h 02m". */
export function formatElapsed(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${String(restSeconds).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${String(restMinutes).padStart(2, "0")}m` : `${hours}h`;
}

/** "480p · 16:9 · 5s" for a video; depth rows name their encoder quality. */
export function generationOutputSummary(item, depthLabels = {}) {
  const quality = item?.kind === "depth" && item?.resolution
    ? depthLabels[item.resolution]?.label ?? item.resolution
    : item?.resolution;
  const duration = item?.kind !== "image" && item?.duration ? `${item.duration}s` : null;
  return [quality, item?.aspectRatio, duration].filter(Boolean).join(" · ");
}
