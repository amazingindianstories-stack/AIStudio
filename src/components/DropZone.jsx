"use client";

import { AlertCircle, Loader2, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

const NOUN = { image: "an image", video: "a video", audio: "audio" };

/**
 * Shared dashed drop target for the upscale, depth and audio pickers. It owns
 * the geometry, copy pattern and drag states; each site keeps its own
 * validation and passes the messages. Extra props (drag handlers) land on the
 * root element.
 */
export default function DropZone({
  kind = "image",
  hint,
  invalidHint,
  dragging = false,
  dragValid = true,
  dragMessage,
  uploading = false,
  progress = 0,
  disabled = false,
  onActivate,
  label,
  children,
  className,
  ...rest
}) {
  const invalid = dragging && !dragValid;
  const inactive = disabled || uploading;
  const activate = () => {
    if (!inactive) onActivate?.();
  };

  let primary;
  if (uploading) primary = `Uploading ${kind}… ${progress}%`;
  else if (dragging) primary = dragMessage || (dragValid ? `Drop ${kind} here` : `This ${kind} cannot be used here`);
  else if (label) primary = label;
  else
    primary = (
      <>
        {`Drop ${NOUN[kind] || kind} here or `}
        <span className="text-brand underline underline-offset-2">browse</span>
      </>
    );

  return (
    <div
      role="button"
      tabIndex={inactive ? -1 : 0}
      aria-disabled={inactive}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        activate();
      }}
      {...rest}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-6 text-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        dragging
          ? dragValid
            ? "border-brand bg-brand/10 text-brand ring-1 ring-brand/40"
            : "border-red-500/80 bg-red-500/10 text-red-400 ring-1 ring-red-500/40 cursor-not-allowed"
          : "border-line bg-ink-900/60 text-white/60 hover:border-brand/60 hover:bg-ink-900/80 hover:text-white",
        inactive && !dragging && "cursor-not-allowed opacity-60",
        className
      )}
    >
      {invalid ? (
        <div className="grid h-10 w-10 place-items-center rounded-full bg-red-500/15 ring-1 ring-red-500/40">
          <AlertCircle className="h-5 w-5 text-red-400" />
        </div>
      ) : (
        <div className="grid h-10 w-10 place-items-center rounded-full bg-white/5 ring-1 ring-line group-hover:bg-brand/20 group-hover:ring-brand/40">
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-brand" />
          ) : (
            <UploadCloud className="h-5 w-5 text-brand" />
          )}
        </div>
      )}
      <div className="min-w-0 max-w-full">
        <p className={cn("truncate text-xs font-semibold", invalid ? "text-red-300" : "text-white")}>{primary}</p>
        {(invalid ? invalidHint || hint : hint) && (
          <p className={cn("mt-1 text-[11px]", invalid ? "text-red-400/80" : "text-white/40")}>
            {invalid ? invalidHint || hint : hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
