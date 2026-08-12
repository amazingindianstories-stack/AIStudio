"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { ConversationPanel } from "./ConversationPanel";

/**
 * Wraps the pre-redesign per-project generation feed (ConversationPanel,
 * unmodified) in a modal reached from TopBar's "History" entry — the
 * "old current chat, stored away from this new UI" ask. Nothing about
 * ConversationPanel itself changes; only where it's mounted does.
 */
export function LegacyHistoryModal({ onClose }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement ;
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll(
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
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-stretch justify-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Generation history"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 34 }}
        className="flex h-full w-full flex-col overflow-hidden bg-ink-900 shadow-pop sm:h-[85vh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-line"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <span className="text-sm font-medium text-white/80">History</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close history"
            className="grid h-8 w-8 place-items-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ConversationPanel />
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
