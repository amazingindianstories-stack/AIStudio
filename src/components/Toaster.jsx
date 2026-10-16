"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dismissNotice, useNotices } from "@/lib/notify";

export function Toaster() {
  const notices = useNotices((state) => state.notices);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[230] flex flex-col items-center gap-2 px-4">
      {notices.map((notice) => (
        <div
          key={notice.id}
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-pop backdrop-blur-md",
            notice.tone === "error" ? "border-red-400/30 bg-ink-750/95 text-red-100" : "border-line bg-ink-750/95 text-white/90"
          )}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" onClick={() => dismissNotice(notice.id)} aria-label="Dismiss" className="-mr-1 grid h-6 w-6 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
