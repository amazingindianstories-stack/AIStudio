"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface DropdownProps {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  side?: "top" | "bottom";
  className?: string;
  panelClassName?: string;
}

export function Dropdown({
  trigger,
  children,
  align = "left",
  side = "bottom",
  className,
  panelClassName,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="block">
        {trigger(open)}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: side === "bottom" ? -6 : 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: side === "bottom" ? -6 : 6, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 480, damping: 32 }}
            className={cn(
              "absolute z-50 min-w-[170px] overflow-hidden rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl",
              side === "bottom" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]",
              align === "right" ? "right-0" : "left-0",
              panelClassName
            )}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({
  active,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
        disabled
          ? "cursor-not-allowed text-white/25"
          : active
          ? "bg-brand/15 text-white"
          : "text-white/75 hover:bg-white/6 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}
