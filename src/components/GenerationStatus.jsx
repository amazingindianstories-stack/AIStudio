"use client";

import { cn } from "@/lib/utils";

/** Shared pending-generation treatment for chat results and library cards. */
export function GenerationStatus({ status = "running", compact = false, className }) {
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
    </div>
  );
}
