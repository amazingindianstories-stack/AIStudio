"use client";

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared pending-generation treatment for chat results and library cards. */
export function GenerationStatus({ status = "running", compact = false, className }) {
  const label = status === "queued" ? "Queued" : "Creating";

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center overflow-hidden bg-ink-800/95 text-center",
        compact ? "gap-2 px-3 py-4" : "h-full w-full gap-3 p-4",
        className
      )}
      role="status"
      aria-label={label}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(126,249,208,0.14),transparent_42%)]" />
      <div className={cn("relative grid place-items-center", compact ? "h-9 w-9" : "h-12 w-12")}>
        <span className="absolute inset-0 rounded-full border border-brand/35 animate-ping motion-reduce:animate-none" />
        <span className="absolute inset-[5px] rounded-full border border-accent/30 animate-pulse motion-reduce:animate-none" />
        <span className="absolute inset-[10px] rounded-full bg-gradient-to-br from-brand/25 to-accent/20 blur-[1px]" />
        <Sparkles className={cn("relative text-brand drop-shadow-[0_0_8px_rgba(126,249,208,0.65)]", compact ? "h-4 w-4" : "h-5 w-5")} />
      </div>
      <span className="relative text-[11px] font-semibold uppercase tracking-[0.22em] text-white/65">
        {label}
      </span>
    </div>
  );
}
