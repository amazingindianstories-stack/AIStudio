"use client";

import { ChevronUp, Frame, LayoutTemplate } from "lucide-react";
import { requestTemplates } from "@/lib/canvas/template-events";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { cn } from "@/lib/utils";

/** The frame tool's menu beside its toolbar button: the frame tool and the planning templates. */
export function FrameMenu({ onFrameTool }) {
  return (
    <Dropdown
      side="top"
      label="Frame options"
      trigger={(open) => (
        <span
          aria-label="Frame options"
          title="Frame options"
          className={cn(
            "-ml-1 grid h-9 w-4 place-items-center rounded-md text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8",
            open && "bg-white/[0.07] text-white"
          )}
        >
          <ChevronUp className="h-3 w-3" />
        </span>
      )}
    >
      {(close) => (
        <>
          <MenuItem onClick={() => { onFrameTool(); close(); }}>
            <Frame className="h-4 w-4 text-white/45" /> Frame / section
            <span className="ml-auto text-xs text-white/40">F</span>
          </MenuItem>
          <MenuItem onClick={() => { requestTemplates({ action: "open", tool: "frame" }); close(); }}>
            <LayoutTemplate className="h-4 w-4 text-white/45" /> Planning templates
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}
