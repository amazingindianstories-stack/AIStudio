"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useStore } from "@/lib/store";
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

  useEffect(() => {
    loadMe();
    loadUsers();
    loadHistory();
    loadProjects();
  }, [loadMe, loadUsers, loadHistory, loadProjects]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink-900">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        {/* left: conversation + composer */}
        <main className="flex min-w-0 flex-1 flex-col border-r border-line">
          <ConversationPanel />
          <div className="shrink-0 px-3 pb-3 pt-1 sm:px-8 sm:pb-5">
            <div className="mx-auto max-w-3xl">
              <PromptComposer />
            </div>
          </div>
        </main>

        {/* right: history (desktop) */}
        <section className="hidden w-[44%] min-w-[400px] max-w-[780px] lg:flex">
          <div className="w-full">
            <HistoryPanel />
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
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 36 }}
              className="fixed inset-y-0 right-0 z-50 flex w-[90%] max-w-md flex-col bg-ink-850 shadow-pop lg:hidden"
            >
              <button
                onClick={() => setMobileHistoryOpen(false)}
                className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-white/80 hover:bg-white/20"
              >
                <X className="h-5 w-5" />
              </button>
              <HistoryPanel />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <DetailModal />
    </div>
  );
}
