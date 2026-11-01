"use client";

import { Sparkles } from "lucide-react";
import { MenuItem } from "@/components/Dropdown";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { useAiInputs, useAiPanelIntent } from "@/lib/board-ai-panel";
import { SELECTION_ACTIONS, actionApplies, selectionContext } from "@/lib/canvas/ai-selection";

const MENU_ACTIONS = ["fix", "shorten", "keywords", "summary"].map((id) => SELECTION_ACTIONS.find((action) => action.id === id));

/** AI rows for the selection context menu: they open the panel with an action filled in; nothing runs until Generate. */
export function AiMenuItems({ onDone }) {
  const on = useAiInputs();
  const readOnly = useCanvasStore(selectReadOnly);
  const present = useCanvasStore((s) => s.history.present);
  const selection = useCanvasStore((s) => s.selection);
  if (!on || readOnly) return null;
  const context = selectionContext(present.nodes, selection);
  const request = (preset) => {
    useAiPanelIntent.getState().request(preset);
    onDone();
  };
  const actions = MENU_ACTIONS.filter((action) => actionApplies(action, context, present.nodes));
  return (
    <>
      <div className="my-1 h-px bg-line" />
      <MenuItem onClick={() => request(null)}>
        <Sparkles className="h-4 w-4 text-brand" />
        <span className="flex-1">Create with AI</span>
      </MenuItem>
      {actions.map((action) => (
        <MenuItem key={action.id} onClick={() => request(action)}>
          <Sparkles className="h-4 w-4 text-white/50" />
          <span className="flex-1">{action.label}</span>
        </MenuItem>
      ))}
    </>
  );
}
