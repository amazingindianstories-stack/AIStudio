"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Contrast, ImageOff, Type } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas-store";
import { accessibilityIssues, describeObject } from "@/lib/canvas/a11y-check";
import { BoardPanel } from "./BoardPanel";
import { jumpToObject } from "./BoardOutline";

const ICONS = { alt: ImageOff, title: Type, contrast: Contrast };

/** Sets `field` of node `id` to `value` as one undo step. */
function fixField(id, field, value) {
  const store = useCanvasStore.getState();
  const node = store.history.present.nodes.find((n) => n.id === id);
  if (!node || !value.trim() || node[field] === value) return;
  store.replaceNodes(new Map([[id, { ...node, [field]: value.trim() }]]));
}

/**
 * The accessibility check: low-contrast text, images without a description
 * and frames without a title, each with a jump to it. Editors can write the
 * missing description or title right here.
 */
export function AccessibilityPanel({ canEdit, onClose }) {
  const present = useCanvasStore((s) => s.history.present);
  const issues = useMemo(() => accessibilityIssues(present), [present]);
  const nodesById = useMemo(() => new Map(present.nodes.map((n) => [n.id, n])), [present]);

  return (
    <BoardPanel
      label="Accessibility check"
      title="Accessibility check"
      subtitle={issues.length ? `${issues.length} ${issues.length === 1 ? "issue" : "issues"} to fix` : "No issues found"}
      onClose={onClose}
    >
      {!issues.length ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <CheckCircle2 className="h-6 w-6 text-emerald-400/90" aria-hidden />
          <p className="text-sm text-white/70">Text contrast, image descriptions and frame titles all pass.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Accessibility issues">
          {issues.map((issue) => {
            const node = nodesById.get(issue.id);
            const Icon = ICONS[issue.kind];
            return (
              <li key={`${issue.id}:${issue.kind}`} className="rounded-xl px-2 py-2 hover:bg-white/[0.04]">
                <button
                  type="button"
                  onClick={() => jumpToObject(issue.id)}
                  className="flex w-full items-start gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300/90" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm text-white/85">{issue.message}</span>
                    {node && <span className="block truncate text-xs text-white/45">{describeObject(node, present)}</span>}
                  </span>
                </button>
                {canEdit && (issue.kind === "alt" || issue.kind === "title") && (
                  <InlineFix
                    key={issue.id}
                    label={issue.kind === "alt" ? "Image description" : "Frame title"}
                    placeholder={issue.kind === "alt" ? "Describe the image" : "Name this frame"}
                    onSave={(value) => fixField(issue.id, issue.kind === "alt" ? "alt" : "name", value)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </BoardPanel>
  );
}

function InlineFix({ label, placeholder, onSave }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="mt-1.5 flex items-center gap-1.5 pl-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={label}
        placeholder={placeholder}
        maxLength={500}
        className="min-w-0 flex-1 rounded-lg bg-ink-800 px-2.5 py-1.5 text-sm text-white placeholder:text-white/35 outline-none ring-1 ring-line focus:ring-brand/70"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="rounded-lg bg-brand/20 px-2.5 py-1.5 text-xs font-semibold text-brand outline-none hover:bg-brand/30 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
      >
        Save
      </button>
    </form>
  );
}
