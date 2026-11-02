"use client";

import { useEffect, useState } from "react";
import { Undo2, X } from "lucide-react";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { goBack } from "./useBoardLinks";

/**
 * What the board says back: a polite live region screen readers hear
 * (keyboard selection, copy results), a short on-screen notice, and the
 * "Go back" prompt after jumping to a linked object.
 */
export function BoardStatus() {
  const announcement = useBoardUi((s) => s.announcement);
  const notice = useBoardUi((s) => s.notice);
  const goBackTo = useBoardUi((s) => s.goBack);
  const [visibleNotice, setVisibleNotice] = useState("");

  useEffect(() => {
    if (!notice.text) return undefined;
    setVisibleNotice(notice.text);
    const timer = window.setTimeout(() => setVisibleNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="board-announcer">
        {/* The sequence number keys the text, so a repeated message is spoken again. */}
        <span key={announcement.seq}>{announcement.text}</span>
      </div>
      {visibleNotice && (
        <div aria-hidden className="pointer-events-none absolute bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-ink-750/95 px-3 py-2 text-xs text-white/85 shadow-pop">
          {visibleNotice}
        </div>
      )}
      {goBackTo && (
        <div className="absolute left-1/2 top-16 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-ink-750/95 py-1 pl-1 pr-1 text-sm shadow-pop backdrop-blur-xl">
          <button
            type="button"
            onClick={goBack}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-white/85 outline-none hover:bg-white/[0.07] hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Go back
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => useBoardUi.getState().setGoBack(null)}
            className="grid h-7 w-7 place-items-center rounded-full text-white/50 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
