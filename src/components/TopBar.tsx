"use client";

import { useState } from "react";
import {
  PanelRightOpen,
  LogOut,
  Shield,
  ChevronDown,
  Settings,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { Dropdown, MenuItem } from "./Dropdown";
import { AccountSettings } from "./AccountSettings";
import { cn } from "@/lib/utils";

export function TopBar() {
  const [accountOpen, setAccountOpen] = useState(false);
  const mobileHistoryOpen = useStore((s) => s.mobileHistoryOpen);
  const setMobileHistoryOpen = useStore((s) => s.setMobileHistoryOpen);
  const user = useStore((s) => s.currentUser);
  const loadMe = useStore((s) => s.loadMe);
  const loadUsers = useStore((s) => s.loadUsers);
  const logout = useStore((s) => s.logout);

  const initial = (user?.name || user?.email || "?").charAt(0).toUpperCase();

  return (
    <>
      <header className="relative z-40 flex h-14 shrink-0 items-center justify-between border-b border-line bg-ink-900 px-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Vivi" className="h-8 w-8 rounded-lg shadow-sm" />
          <span className="text-[17px] font-semibold tracking-tight text-white">
            Vivi
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setMobileHistoryOpen(true)}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/5 hover:text-white lg:hidden"
            aria-expanded={mobileHistoryOpen}
            aria-controls="mobile-history-panel"
            aria-label="Open assets panel"
          >
            <PanelRightOpen className="h-[18px] w-[18px]" />
          </button>

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
    </>
  );
}
