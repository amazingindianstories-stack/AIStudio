"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { X } from "lucide-react";
import { useStore, restoreComposerDraft } from "@/lib/store";
import { TopBar } from "@/components/TopBar";
import { NavRail } from "@/components/NavRail";
import { StudioChat } from "@/components/StudioChat";
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
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Restores mode/view/model/settings/active project — so a refresh lands
    // back on the same tab instead of resetting to the store's hardcoded
    // defaults. Deliberately does NOT restore rightPanelOpen (see the note
    // on that field in store.ts) — the assets drawer always starts closed.
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

  useEffect(() => {
    if (!rightPanelOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    drawerCloseRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRightPanelOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [rightPanelOpen, setRightPanelOpen]);

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink-900">
        <TopBar />

        <div className="flex min-h-0 flex-1">
          <NavRail />

          {view === "canvas" ? (
            <CanvasView />
          ) : (
            /* merged chat + composer, one window per tab */
            <main className="flex min-w-0 flex-1 flex-col">
              <StudioChat />
            </main>
          )}
        </div>

        {/* Assets library — a retractable drawer at every viewport size, not
            part of the main layout, and closed by default (never restored
            from a previous session — see restoreComposerDraft's note). */}
        <AnimatePresence>
          {view !== "canvas" && rightPanelOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setRightPanelOpen(false)}
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
              />
              <motion.aside
                id="assets-drawer"
                ref={drawerRef}
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 36 }}
                className="fixed inset-y-0 right-0 z-50 flex w-[90%] max-w-md flex-col bg-ink-850 shadow-pop sm:w-[26rem] lg:w-[clamp(25rem,42vw,48.75rem)]"
                role="dialog"
                aria-modal="true"
                aria-label="Assets panel"
              >
                <div className="flex h-12 shrink-0 items-center justify-end border-b border-line px-3">
                  <button
                    ref={drawerCloseRef}
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
