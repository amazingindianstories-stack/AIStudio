"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Unlink2, RotateCw, Scaling } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { Dropdown } from "@/components/Dropdown";
import { nodeRotation } from "@/lib/canvas/geometry";
import { cleanSize, rotationTargets, sizeTargets } from "@/lib/canvas/transform";

/** The value every node shares, or null when they differ. */
function shared(nodes, read) {
  if (!nodes.length) return null;
  const first = read(nodes[0]);
  return nodes.every((n) => read(n) === first) ? first : null;
}

function formatAngle(deg) {
  return String(Math.round(deg * 100) / 100);
}

/**
 * Precise size and rotation for the selection, in the style inspector: W and
 * H in whole world pixels (a multi-selection sets every object to the value),
 * an aspect lock for images, and the rotation angle. Locked objects are shown
 * but not changed; frames do not rotate.
 */
export function TransformControls({ nodes }) {
  const setSize = useCanvasStore((s) => s.setSize);
  const setRotation = useCanvasStore((s) => s.setRotation);
  const setAspectLocked = useCanvasStore((s) => s.setAspectLocked);
  const present = useCanvasStore((s) => s.history.present);

  const ids = nodes.map((n) => n.id);
  const sizable = sizeTargets(present, ids);
  const rotatable = rotationTargets(present, ids);
  const w = shared(nodes, (n) => Math.round(n.w));
  const h = shared(nodes, (n) => Math.round(n.h));
  const rotation = shared(rotatable, nodeRotation);
  const images = nodes.length > 0 && nodes.every((n) => n.type === "image");
  const aspectLocked = images && sizable.length > 0 && sizable.every((n) => n.aspectLocked === true);

  const showAngle = rotatable.length > 0 && rotation !== 0;

  return (
    <Dropdown
      label="Size and rotation"
      panelClassName="w-[212px]"
      trigger={(open) => (
        <span
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] tabular-nums text-white/70 transition hover:bg-white/[0.08] hover:text-white",
            open && "bg-white/[0.08] text-white"
          )}
          title="Size and rotation"
        >
          {/* The size itself is shown on the canvas under the selection. */}
          <Scaling className="h-4 w-4" />
          {showAngle && (
            <span className="flex items-center gap-0.5 whitespace-nowrap text-white/50">
              <RotateCw className="h-3 w-3" />
              {rotation == null ? "-" : `${formatAngle(rotation)}°`}
            </span>
          )}
        </span>
      )}
    >
      {() => (
        <div className="flex flex-col gap-2 p-1">
          <div className="flex items-center gap-1.5">
            <NumberField
              label="Width"
              prefix="W"
              value={w}
              disabled={!sizable.length}
              onCommit={(v, targetIds) => setSize({ w: v }, targetIds)}
              ids={ids}
              parse={cleanSize}
            />
            {images && (
              <button
                type="button"
                aria-label={aspectLocked ? "Unlock aspect ratio" : "Lock aspect ratio"}
                aria-pressed={aspectLocked}
                title={aspectLocked ? "Aspect ratio locked" : "Aspect ratio unlocked"}
                disabled={!sizable.length}
                onClick={() => setAspectLocked(!aspectLocked, ids)}
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-md transition disabled:opacity-40",
                  aspectLocked ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
                )}
              >
                {aspectLocked ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}
              </button>
            )}
            <NumberField
              label="Height"
              prefix="H"
              value={h}
              disabled={!sizable.length}
              onCommit={(v, targetIds) => setSize({ h: v }, targetIds)}
              ids={ids}
              parse={cleanSize}
            />
          </div>
          {rotatable.length > 0 && (
            <div className="flex">
              <NumberField
                label="Rotation"
                prefix={<RotateCw className="h-3 w-3" />}
                suffix="°"
                value={rotation == null ? null : Number(formatAngle(rotation))}
                onCommit={(v, targetIds) => setRotation(v, targetIds)}
                ids={rotatable.map((n) => n.id)}
                parse={(raw) => {
                  const v = Number(raw);
                  return Number.isFinite(v) ? v : null;
                }}
                decimals
              />
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
}

/**
 * A number typed in place: it commits on Enter, on leaving the field, and if
 * the field goes away mid-edit (the panel closes); Escape puts the value
 * back. Arrow keys step by 1 (10 with Shift). The ids are those selected
 * when the edit started, so a click elsewhere cannot redirect it. Board
 * shortcuts ignore keys typed into inputs.
 */
function NumberField({ label, prefix, suffix, value, disabled, onCommit, ids, parse, decimals = false }) {
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const editRef = useRef(null);
  const commitRef = useRef(null);

  // Follow outside changes (undo, another editor) while not mid-edit.
  useEffect(() => {
    if (!editRef.current) setDraft(shown);
  }, [shown]);

  commitRef.current = () => {
    const edit = editRef.current;
    editRef.current = null;
    if (!edit) return;
    const v = parse(edit.text);
    // Show the stored value again; the effect above picks up the new one.
    setDraft(shown);
    if (v == null || edit.text.trim() === "") return;
    onCommit(v, edit.ids);
  };
  useEffect(() => () => commitRef.current?.(), []);

  const step = (e, dir) => {
    e.preventDefault();
    const base = parse(draft) ?? value ?? 0;
    const next = base + dir * (e.shiftKey ? 10 : 1);
    const text = String(decimals ? next : Math.round(next));
    setDraft(text);
    editRef.current = { text, ids: editRef.current?.ids ?? ids };
    commitRef.current();
  };

  return (
    <label
      className={cn(
        "flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-line bg-ink-800 px-1.5 text-white/45 focus-within:border-brand/40",
        disabled && "opacity-40"
      )}
    >
      <span className="shrink-0 text-[10px] font-medium">{prefix}</span>
      <input
        aria-label={label}
        type="text"
        inputMode={decimals ? "decimal" : "numeric"}
        disabled={disabled}
        value={draft}
        placeholder={value == null ? "Mixed" : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          editRef.current = { text: e.target.value, ids: editRef.current?.ids ?? ids };
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => commitRef.current()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitRef.current();
          } else if (e.key === "Escape") {
            editRef.current = null;
            setDraft(shown);
          } else if (e.key === "ArrowUp") {
            step(e, 1);
          } else if (e.key === "ArrowDown") {
            step(e, -1);
          }
        }}
        className="h-full w-full min-w-0 bg-transparent text-xs tabular-nums text-white outline-none placeholder:text-white/30"
      />
      {suffix && <span className="shrink-0 text-[11px]">{suffix}</span>}
    </label>
  );
}
