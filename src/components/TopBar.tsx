"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Image as ImageIcon,
  Clapperboard,
  Shapes,
  LayoutGrid,
  History,
  LogOut,
  Shield,
  ChevronDown,
  Settings,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { Dropdown, MenuItem } from "./Dropdown";
import { AccountSettings } from "./AccountSettings";
import { LegacyHistoryModal } from "./LegacyHistoryModal";
import { cn } from "@/lib/utils";

const DESTINATIONS = [
  { id: "image", icon: ImageIcon, label: "Image" },
  { id: "video", icon: Clapperboard, label: "Video" },
  { id: "board", icon: Shapes, label: "Board" },
] as const;

/**
 * Horizontal nav lives in the top bar now (was a left-edge rail,
 * NavRail.tsx, before this pass) — same three destinations plus Library and
 * History, just laid out across the header instead of down the side, so the
 * left edge is free for chat width instead of a permanent rail.
 */
export function TopBar() {
  const [accountOpen, setAccountOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  const user = useStore((s) => s.currentUser);
  const loadMe = useStore((s) => s.loadMe);
  const loadUsers = useStore((s) => s.loadUsers);
  const logout = useStore((s) => s.logout);

  const initial = (user?.name || user?.email || "?").charAt(0).toUpperCase();
  const activeDestination = view === "canvas" ? "board" : mode;

  const goTo = (id: (typeof DESTINATIONS)[number]["id"]) => {
    if (id === "board") {
      setView("canvas");
    } else {
      setView("studio");
      setMode(id);
    }
  };

  return (
    <>
      <header className="relative z-40 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-ink-900 px-3 sm:px-5">
        <div className="flex shrink-0 items-center gap-2.5">
          <img src="/logo.png" alt="Veevee.ai" className="h-8 w-8 rounded-lg shadow-sm" />
          <span className="hidden text-[17px] font-semibold tracking-tight text-white sm:inline">
            Veevee.ai
          </span>
        </div>

        <span className="hidden h-6 w-px shrink-0 bg-line sm:block" aria-hidden />

        <nav aria-label="Sections" className="flex min-w-0 items-center gap-1">
          {DESTINATIONS.map((d) => {
            const active = d.id === activeDestination;
            return (
              <button
                key={d.id}
                onClick={() => goTo(d.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "text-white" : "text-white/50 hover:bg-white/5 hover:text-white/90"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="topbar-active"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className="absolute inset-0 rounded-lg bg-white/10"
                  />
                )}
                <d.icon className="relative z-10 h-4 w-4" strokeWidth={1.9} />
                <span className="relative z-10 hidden sm:inline">{d.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Phone-width only — tablet/desktop gets an edge tab right where
              the docked panel opens from (page.tsx), which makes more sense
              spatially than a button up here disconnected from it. Phones
              use the overlay drawer instead (no docked panel to sit next
              to), so this stays the only way to open it there. */}
          <button
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
            aria-expanded={rightPanelOpen}
            aria-controls="assets-drawer"
            aria-label={rightPanelOpen ? "Close assets panel" : "Open assets panel"}
            title="Library"
            className={cn(
              "grid h-8 w-8 place-items-center rounded-lg transition-colors sm:hidden",
              rightPanelOpen ? "bg-white/10 text-white" : "text-white/55 hover:bg-white/5 hover:text-white"
            )}
          >
            <LayoutGrid className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            aria-label="History"
            title="History"
            className="grid h-8 w-8 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/5 hover:text-white"
          >
            <History className="h-[18px] w-[18px]" />
          </button>

          <span className="mx-1 h-6 w-px bg-line" aria-hidden />

          {user && (
            <Dropdown
            align="right"
            trigger={(open) => (
              <span
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-full border border-line bg-ink-700 py-1 pl-1 pr-2 text-sm text-white/85 transition hover:border-lineStrong",
                  open && "border-white/30"
                )}
              >
                <span
                  className="relative grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-ink-900"
                  style={{ background: user.color || "#34d399" }}
                >
                  {initial}
                  {user.avatarUrl && (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                </span>
                <span className="hidden max-w-[140px] truncate sm:inline">
                  {user.name || user.email}
                </span>
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
                />
              </span>
            )}
          >
            {(close) => (
              <>
                <div className="px-2.5 py-2">
                  <p className="truncate text-sm font-medium text-white">
                    {user.name}
                  </p>
                  <p className="truncate text-xs text-white/45">{user.email}</p>
                  {user.role === "admin" && (
                    <span className="mt-1 inline-block rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      ADMIN
                    </span>
                  )}
                </div>
                <div className="my-1 h-px bg-line" />
                <MenuItem
                  onClick={() => {
                    close();
                    setAccountOpen(true);
                  }}
                >
                  <Settings className="h-4 w-4 text-white/60" /> Account settings
                </MenuItem>
                {user.role === "admin" && (
                  <MenuItem
                    onClick={() => {
                      window.location.href = "/admin";
                      close();
                    }}
                  >
                    <Shield className="h-4 w-4 text-white/60" /> Admin dashboard
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    logout();
                    close();
                  }}
                >
                  <LogOut className="h-4 w-4 text-white/60" /> Log out
                </MenuItem>
              </>
            )}
            </Dropdown>
          )}
        </div>
      </header>

      {user && (
        <AccountSettings
          open={accountOpen}
          user={user}
          onClose={() => setAccountOpen(false)}
          onUserUpdated={async () => {
            await Promise.all([loadMe(), loadUsers()]);
          }}
        />
      )}

      {historyOpen && <LegacyHistoryModal onClose={() => setHistoryOpen(false)} />}
    </>
  );
}
