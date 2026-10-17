"use client";

import { cn } from "@/lib/utils";

/** Statuses whose progressMessage says why a queued video has not started yet. */
const WAITING_STATUSES = new Set(["PORTRAIT_WAITING", "SLOT_WAITING"]);

/** The reason a pending video is waiting (portrait preparation or a provider slot), else null. */
export function waitingNote(item) {
  if (item?.kind !== "video" || item.pollWarning || !WAITING_STATUSES.has(item.providerStatus)) return null;
  return item.progressMessage || null;
}

/** Shared pending-generation treatment for chat results and library cards. */
export function GenerationStatus({ status = "running", compact = false, note = null, className }) {
  const label = status === "queued" ? "Queued" : "Creating";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center bg-ink-800 text-center",
        compact ? "gap-2.5 px-3 py-4" : "h-full w-full gap-3 p-4",
        className
      )}
      role="status"
      aria-label={label}
    >
      <span className="flex items-center gap-1.5" aria-hidden="true">
        <span className="h-2.5 w-2.5 animate-dotPulse rounded-full bg-white motion-reduce:animate-none" />
        <span className="h-2.5 w-2.5 animate-dotPulse rounded-full bg-white [animation-delay:140ms] motion-reduce:animate-none" />
        <span className="h-2.5 w-2.5 animate-dotPulse rounded-full bg-white [animation-delay:280ms] motion-reduce:animate-none" />
        <span className="h-2.5 w-2.5 animate-dotPulse rounded-full bg-white [animation-delay:420ms] motion-reduce:animate-none" />
      </span>
      <span className="text-[11px] font-medium tracking-wide text-white/50">
        {label}
      </span>
      {note && <span data-generation-wait className="max-w-[28ch] text-[11px] leading-snug text-sky-200/80">{note}</span>}
    </div>
  );
}
