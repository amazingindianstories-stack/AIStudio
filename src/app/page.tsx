"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { ConversationPanel } from "@/components/ConversationPanel";
import { PromptComposer } from "@/components/PromptComposer";
import { HistoryPanel } from "@/components/HistoryPanel";
import { DetailModal } from "@/components/DetailModal";

export default function Page() {
  const loadHistory = useStore((s) => s.loadHistory);
  const loadProjects = useStore((s) => s.loadProjects);
  const loadMe = useStore((s) => s.loadMe);
  const loadUsers = useStore((s) => s.loadUsers);
  const mobileHistoryOpen = useStore((s) => s.mobileHistoryOpen);
  const setMobileHistoryOpen = useStore((s) => s.setMobileHistoryOpen);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    loadMe();
    loadUsers();
    loadHistory();
    loadProjects();
  }, [loadMe, loadUsers, loadHistory, loadProjects]);

  useEffect(() => {
    if (!mobileHistoryOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    mobileCloseRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileHistoryOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        mobileDrawerRef.current?.querySelectorAll<HTMLElement>(
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
  }, [mobileHistoryOpen, setMobileHistoryOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeDrawer = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileHistoryOpen(false);
    };
    desktop.addEventListener("change", closeDrawer);
    return () => desktop.removeEventListener("change", closeDrawer);
  }, [setMobileHistoryOpen]);

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink-900">
        <TopBar />

        <div className="flex min-h-0 flex-1">
          <Sidebar />

          {/* left: conversation + composer */}
          <main className="flex min-w-0 flex-1 flex-col">
            <ConversationPanel />
            <div className="shrink-0 px-3 pb-3 pt-1 sm:px-8 sm:pb-5">
              <div className="mx-auto w-full">
                <PromptComposer />
              </div>
            </div>
          </main>

          {/* right: history (desktop) */}
          <section
            className={cn(
              "hidden shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:flex",
              rightPanelOpen ? "w-[clamp(25rem,42vw,48.75rem)]" : "w-10"
            )}
          >
            <div className="flex w-10 shrink-0 items-center justify-center border-l border-line bg-ink-900">
              <button
                type="button"
                onClick={() => setRightPanelOpen((open) => !open)}
                className="grid h-9 w-9 place-items-center rounded-lg text-white/55 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                aria-expanded={rightPanelOpen}
                aria-controls="desktop-history-panel"
                aria-label={rightPanelOpen ? "Hide assets panel" : "Show assets panel"}
                title={rightPanelOpen ? "Hide assets panel" : "Show assets panel"}
              >
                {rightPanelOpen ? (
                  <ChevronRight className="h-5 w-5" />
                ) : (
                  <ChevronLeft className="h-5 w-5" />
                )}
              </button>
            </div>
            <div
              id="desktop-history-panel"
              className={cn(
                "min-w-0 flex-1 overflow-hidden border-l border-line transition-opacity duration-200 motion-reduce:transition-none",
                rightPanelOpen ? "opacity-100" : "pointer-events-none opacity-0"
              )}
              aria-hidden={!rightPanelOpen}
              inert={!rightPanelOpen}
            >
              <div className="h-full w-[clamp(25rem,42vw,48.75rem)]">
                <HistoryPanel />
              </div>
            </div>
          </section>
        </div>

        {/* mobile history drawer */}
        <AnimatePresence>
          {mobileHistoryOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setMobileHistoryOpen(false)}
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden"
              />
              <motion.aside
                id="mobile-history-panel"
                ref={mobileDrawerRef}
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 36 }}
                className="fixed inset-y-0 right-0 z-50 flex w-[90%] max-w-md flex-col bg-ink-850 shadow-pop lg:hidden"
                role="dialog"
                aria-modal="true"
                aria-label="Assets panel"
              >
                <div className="flex h-12 shrink-0 items-center justify-end border-b border-line px-3">
                  <button
                    ref={mobileCloseRef}
                    onClick={() => setMobileHistoryOpen(false)}
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
