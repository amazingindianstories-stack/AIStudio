"use client";

import { useEffect } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { X } from "lucide-react";
import { useStore, restoreComposerDraft } from "@/lib/store";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/TopBar";
import { StudioView } from "@/components/StudioView";
import { HistoryPanel } from "@/components/HistoryPanel";
import { DetailModal } from "@/components/DetailModal";
import { CanvasView } from "@/components/canvas/CanvasView";

export default function Page() {
  const loadHistory = useStore((s) => s.loadHistory);
  const loadProjects = useStore((s) => s.loadProjects);
  const loadMe = useStore((s) => s.loadMe);
  const loadUsers = useStore((s) => s.loadUsers);
  const startLiveUpdates = useStore((s) => s.startLiveUpdates);
  const stopLiveUpdates = useStore((s) => s.stopLiveUpdates);
  const view = useStore((s) => s.view);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);

  useEffect(() => {
    // Restores mode/view/model/settings/active project — so a refresh lands
    // back on the same tab instead of resetting to the store's hardcoded
    // defaults. Deliberately does NOT restore rightPanelOpen (see the note
    // on that field in store.ts) — the assets panel always starts closed.
    restoreComposerDraft();
    loadMe();
    loadUsers();
    loadHistory();
    loadProjects();
    // Shared live feed: picks up completions from any tab, device or teammate,
    // so finishing a generation no longer needs a manual refresh.
    startLiveUpdates();
    return () => stopLiveUpdates();
  }, [loadMe, loadUsers, loadHistory, loadProjects, startLiveUpdates, stopLiveUpdates]);

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink-900">
        <TopBar />

        <div className="flex min-h-0 flex-1">
          {view === "canvas" ? <CanvasView /> : <StudioView />}

          {/* Assets library, tablet/desktop: docked, so it resizes the chat
              instead of covering it — you can keep working with it open.
              Closed by default and never restored from a previous session
              (see restoreComposerDraft's note on rightPanelOpen). */}
          {view !== "canvas" && (
            <section
              id="assets-drawer"
              className={cn(
                "hidden shrink-0 overflow-hidden border-l border-line transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:flex",
                rightPanelOpen ? "w-[clamp(22rem,32vw,40rem)]" : "w-0 border-l-0"
              )}
            >
              <div
                className={cn(
                  "h-full w-[clamp(22rem,32vw,40rem)] shrink-0 transition-opacity duration-200 motion-reduce:transition-none",
                  rightPanelOpen ? "opacity-100" : "pointer-events-none opacity-0"
                )}
                aria-hidden={!rightPanelOpen}
                inert={!rightPanelOpen}
              >
                <HistoryPanel />
              </div>
            </section>
          )}
        </div>

        {/* Assets library, phone width: a docked panel has nowhere to go at
            this size, so this stays an overlay drawer here only. */}
        <AnimatePresence>
          {view !== "canvas" && rightPanelOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setRightPanelOpen(false)}
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm sm:hidden"
              />
              <motion.aside
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 36 }}
                className="fixed inset-y-0 right-0 z-50 flex w-[90%] max-w-md flex-col bg-ink-850 shadow-pop sm:hidden"
                role="dialog"
                aria-modal="true"
                aria-label="Assets panel"
              >
                <div className="flex h-12 shrink-0 items-center justify-end border-b border-line px-3">
                  <button
                    onClick={() => setRightPanelOpen(false)}
                    className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-white/80 hover:bg-white/20"
                    aria-label="Close assets panel"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <HistoryPanel />
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <DetailModal />
      </div>
    </MotionConfig>
  );
}
