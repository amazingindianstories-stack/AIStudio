"use client";

import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The round rotation handle that sits above a selected object (or the box
 * around a multi-selection), on a short stem. It is placed inside the box it
 * belongs to, so on a rotated object it turns with the object.
 */
export function RotateHandle({ onPointerDown, label = "Rotate", className }) {
  return (
    <div className={cn("pointer-events-none absolute left-1/2 -top-[30px] z-20 flex h-[30px] -translate-x-1/2 flex-col items-center", className)}>
      <button
        type="button"
        aria-label={label}
        title={`${label} (Shift snaps to 15°)`}
        data-rotate-handle=""
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown(e);
        }}
        className="pointer-events-auto grid h-[16px] w-[16px] shrink-0 cursor-grab place-items-center rounded-full border border-ink-900 bg-white text-ink-900 shadow-sm ring-1 ring-ink-900 active:cursor-grabbing"
      >
        <RotateCw className="h-[10px] w-[10px]" strokeWidth={2.5} />
      </button>
      <span className="w-px flex-1 bg-brand" />
    </div>
  );
}
