"use client";

import { Brain, Check, ChevronDown } from "lucide-react";
import { useStore } from "@/lib/store";
import { AGENT_MODELS, THINKING_LABELS, agentModel, thinkingLevelsFor } from "@/lib/agent-model";
import { Dropdown, MenuItem } from "./Dropdown";
import { cn } from "@/lib/utils";

/**
 * The Agents chat's LLM control: one compact pill that names the model and thinking level, opening a menu with the
 * model and the levels that model takes. The choice applies to the next run; a running agent keeps its own.
 */
export function AgentModelPicker({ running = false }) {
  const model = useStore((s) => s.agentModel);
  const thinking = useStore((s) => s.agentThinking);
  const setAgentModel = useStore((s) => s.setAgentModel);
  const setAgentThinking = useStore((s) => s.setAgentThinking);
  const current = agentModel(model) ?? AGENT_MODELS[0];
  const levels = thinkingLevelsFor(current.id);

  return (
    <Dropdown
      className="shrink-0"
      side="top"
      align="right"
      label={`Agent model: ${current.label}, ${THINKING_LABELS[thinking] ?? thinking} thinking`}
      panelClassName="w-[min(calc(100vw-1rem),280px)]"
      trigger={(open) => (
        <span
          data-testid="agent-model-trigger"
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] text-white/55 ring-1 ring-line transition-colors hover:text-white/85 hover:ring-lineStrong",
            open && "text-white/85 ring-brand/40"
          )}
        >
          <Brain aria-hidden="true" className="h-3 w-3 text-white/45" />
          <span className="font-medium">{current.short}</span>
          <span className="text-white/40">· {THINKING_LABELS[thinking] ?? thinking}</span>
          <ChevronDown aria-hidden="true" className={cn("h-3 w-3 text-white/40 transition-transform", open && "rotate-180")} />
        </span>
      )}
    >
      {(close) => (
        <>
          <div role="group" aria-label="Agent model" className="py-0.5">
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/35">Agent model</p>
            {AGENT_MODELS.map((entry) => {
              const on = entry.id === current.id;
              return (
                <MenuItem key={entry.id} role="menuitemradio" checked={on} active={on} onClick={() => setAgentModel(entry.id)}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{entry.label}</span>
                    <span className="text-[10px] leading-snug text-white/40">{entry.hint}</span>
                  </span>
                  {on && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />}
                </MenuItem>
              );
            })}
          </div>
          <div role="group" aria-label="Thinking level" className="border-t border-line px-2.5 pb-2 pt-1.5">
            <p className="pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/35">Thinking</p>
            <div className="grid grid-cols-3 gap-1">
              {levels.map((level) => {
                const on = level === thinking;
                return (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    data-testid={`agent-thinking-${level}`}
                    onClick={() => { setAgentThinking(level); close(); }}
                    className={cn(
                      "rounded-lg px-2 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/60",
                      on ? "bg-brand/20 text-brand ring-1 ring-brand/40" : "bg-ink-700 text-white/65 ring-1 ring-line hover:text-white"
                    )}
                  >
                    {THINKING_LABELS[level]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-white/35">
              {running ? "Applies from the next run; the running agent keeps its model." : "More thinking is slower and costs more."}
            </p>
          </div>
        </>
      )}
    </Dropdown>
  );
}
