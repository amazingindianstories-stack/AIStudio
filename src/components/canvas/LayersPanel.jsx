"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  SquareDashedMousePointer,
  Trash2,
  X,
} from "lucide-react";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { MAX_LAYERS, MAX_LAYER_NAME } from "@/lib/canvas/layers";
import { dropIndex, layerRows, objectCountLabel } from "@/lib/canvas/layer-panel";

const ICON_BUTTON =
  "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/50 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-40";

function RenameInput({ initial, onDone }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save) => {
    if (finished.current) return;
    finished.current = true;
    onDone(save ? value : null);
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={MAX_LAYER_NAME}
      aria-label="Layer name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onClick={(e) => e.stopPropagation()}
      className="h-7 min-w-0 flex-1 rounded-md border border-brand/60 bg-ink-900 px-2 text-sm text-white outline-none"
    />
  );
}

function LayerRow({ row, active, hidden, editable, canMoveUp, canMoveDown, hasSelection, dragging, onDrag, onDelete }) {
  const [renaming, setRenaming] = useState(false);
  const [dropAt, setDropAt] = useState(null);
  const store = () => useCanvasStore.getState();
  const selectable = !row.locked && !hidden;
  const draggable = editable && !row.isDefault && !renaming;

  const onDragOver = (e) => {
    if (!dragging || dragging === row.id) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setDropAt(row.isDefault || e.clientY > box.top + box.height / 2 ? "below" : "above");
  };
  const onDrop = (e) => {
    e.preventDefault();
    const where = dropAt;
    setDropAt(null);
    if (!dragging || dragging === row.id) return;
    const state = store();
    const index = dropIndex(state.history.present, dragging, row.id, where === "above");
    if (index >= 0) state.moveLayer(dragging, index);
    onDrag(null);
  };

  return (
    <li
      data-layer-row={row.isDefault ? "default" : row.id}
      data-active={active ? "true" : undefined}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", row.id);
        onDrag(row.id);
      }}
      onDragEnd={() => onDrag(null)}
      onDragOver={onDragOver}
      onDragLeave={() => setDropAt(null)}
      onDrop={onDrop}
      className={[
        "group relative flex items-center gap-1 rounded-lg px-1.5 py-1",
        active ? "bg-brand/15 ring-1 ring-inset ring-brand/40" : "hover:bg-white/[0.06]",
        dragging === row.id ? "opacity-50" : "",
      ].join(" ")}
    >
      {dropAt && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-1 h-0.5 rounded bg-brand ${dropAt === "above" ? "-top-px" : "-bottom-px"}`}
        />
      )}
      {row.isDefault ? (
        <span className="h-7 w-7 shrink-0" title="The default layer is always visible" />
      ) : (
        <button
          type="button"
          aria-label={`${hidden ? "Show" : "Hide"} ${row.name}`}
          aria-pressed={hidden}
          title={hidden ? "Show layer (only for you)" : "Hide layer (only for you)"}
          onClick={() => store().setLayerHidden(row.id, !hidden)}
          className={ICON_BUTTON}
        >
          {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      )}
      {renaming ? (
        <RenameInput
          initial={row.name}
          onDone={(name) => {
            setRenaming(false);
            if (name != null) store().renameLayer(row.id, name);
          }}
        />
      ) : (
        <button
          type="button"
          aria-pressed={active}
          aria-label={`${row.name}${active ? ", active layer" : ""}`}
          title={
            row.isDefault
              ? "New objects go here when it is active"
              : selectable
                ? "Make active: new objects go on this layer. Double-click to rename"
                : "Locked or hidden layers cannot be active"
          }
          onClick={() => {
            if (selectable && editable) store().setActiveLayer(row.id);
          }}
          onDoubleClick={() => {
            if (editable && !row.isDefault) setRenaming(true);
          }}
          className={`flex min-w-0 flex-1 flex-col items-start rounded-md px-1.5 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand ${editable ? "cursor-pointer" : "cursor-default"}`}
        >
          <span className={`w-full truncate text-sm ${hidden ? "text-white/40" : "text-white/85"}`}>{row.name}</span>
          <span className="text-[11px] text-white/40">{objectCountLabel(row.count)}</span>
        </button>
      )}
      {!row.isDefault && (editable || row.locked) && (
        <button
          type="button"
          aria-label={`${row.locked ? "Unlock" : "Lock"} ${row.name}`}
          aria-pressed={row.locked}
          title={editable ? (row.locked ? "Unlock layer for everyone" : "Lock layer for everyone") : "Layer locked"}
          disabled={!editable}
          onClick={() => {
            const state = store();
            state.setLayerLocked(row.id, !row.locked);
            if (!row.locked && state.activeLayerId === row.id) state.setActiveLayer(null);
          }}
          className={`${ICON_BUTTON} ${row.locked ? "text-amber-300/80" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"}`}
        >
          {row.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        </button>
      )}
      {editable && (
        <Dropdown
          align="right"
          label={`More for ${row.name}`}
          triggerClassName={ICON_BUTTON}
          trigger={() => <MoreHorizontal className="h-4 w-4" />}
        >
          {(close) => (
            <>
              <MenuItem
                disabled={!hasSelection}
                onClick={() => {
                  store().moveSelectionToLayer(row.id);
                  close();
                }}
              >
                <SquareDashedMousePointer className="h-4 w-4 text-white/50" />
                <span className="flex-1">Move selection here</span>
              </MenuItem>
              {!row.isDefault && (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      setRenaming(true);
                    }}
                  >
                    <Pencil className="h-4 w-4 text-white/50" />
                    <span className="flex-1">Rename</span>
                  </MenuItem>
                  <MenuItem
                    disabled={!canMoveUp}
                    onClick={() => {
                      store().moveLayer(row.id, row.index + 1);
                      close();
                    }}
                  >
                    <ArrowUp className="h-4 w-4 text-white/50" />
                    <span className="flex-1">Move up</span>
                  </MenuItem>
                  <MenuItem
                    disabled={!canMoveDown}
                    onClick={() => {
                      store().moveLayer(row.id, row.index - 1);
                      close();
                    }}
                  >
                    <ArrowDown className="h-4 w-4 text-white/50" />
                    <span className="flex-1">Move down</span>
                  </MenuItem>
                  <MenuItem
                    disabled={layerCount(store()) >= MAX_LAYERS}
                    onClick={() => {
                      store().duplicateLayer(row.id);
                      close();
                    }}
                  >
                    <Copy className="h-4 w-4 text-white/50" />
                    <span className="flex-1">Duplicate</span>
                  </MenuItem>
                  <div className="my-1 h-px bg-white/10" />
                  <MenuItem
                    disabled={row.locked}
                    onClick={() => {
                      close();
                      onDelete(row);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-red-300/80" />
                    <span className="flex-1 text-red-200">Delete layer</span>
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Dropdown>
      )}
    </li>
  );
}

function deleteDescription(row) {
  if (!row?.count) return "The layer is empty. You can undo this.";
  const deleted = row.count - row.lockedCount;
  const parts = [];
  if (deleted) parts.push(`This also deletes the ${objectCountLabel(deleted).toLowerCase()} on it.`);
  if (row.lockedCount) {
    const one = row.lockedCount === 1;
    parts.push(`${row.lockedCount} locked object${one ? "" : "s"} ${one ? "moves" : "move"} to the default layer.`);
  }
  parts.push("You can undo this.");
  return parts.join(" ");
}

function layerCount(state) {
  return state.history.present.settings?.layers?.length ?? 0;
}

/**
 * Miro's Layers panel: the layers above the default one, top first, and the
 * default layer at the bottom. Hiding is each person's own; everything else
 * changes the board for everyone, so read-only roles may only hide and show.
 */
export function LayersPanel({ onClose }) {
  const present = useCanvasStore((s) => s.history.present);
  const hiddenLayerIds = useCanvasStore((s) => s.hiddenLayerIds);
  const activeLayerId = useCanvasStore((s) => s.activeLayerId);
  const hasSelection = useCanvasStore((s) => s.selection.length > 0);
  const editable = useCanvasStore((s) => !selectReadOnly(s));
  const rows = useMemo(() => layerRows(present), [present]);
  const hidden = useMemo(() => new Set(hiddenLayerIds), [hiddenLayerIds]);
  const [dragging, setDragging] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const panelRef = useRef(null);
  const custom = rows.length - 1;

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !deleting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, deleting]);

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label="Layers"
      data-layers-panel=""
      className="absolute right-4 top-16 z-40 flex max-h-[min(560px,calc(100%-11rem))] w-72 max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750/95 shadow-pop outline-none backdrop-blur-xl"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-white/90">Layers</h2>
          <p className="text-xs text-white/45">Top of the list draws on top</p>
        </div>
        <div className="flex items-center gap-1">
          {editable && (
            <button
              type="button"
              aria-label="New layer"
              title={custom >= MAX_LAYERS ? `Up to ${MAX_LAYERS} layers` : "New layer"}
              disabled={custom >= MAX_LAYERS}
              onClick={() => useCanvasStore.getState().addLayer()}
              className={ICON_BUTTON}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
          <button type="button" aria-label="Close layers" onClick={onClose} className={ICON_BUTTON}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      <ul className="flex flex-col gap-0.5 overflow-y-auto p-2" aria-label="Board layers">
        {rows.map((row) => (
          <LayerRow
            key={row.id ?? "default"}
            row={row}
            active={(activeLayerId ?? null) === row.id}
            hidden={row.id != null && hidden.has(row.id)}
            editable={editable}
            canMoveUp={row.index >= 0 && row.index < custom - 1}
            canMoveDown={row.index > 0}
            hasSelection={hasSelection}
            dragging={dragging}
            onDrag={setDragging}
            onDelete={setDeleting}
          />
        ))}
      </ul>
      {!editable && <p className="border-t border-line px-4 py-2 text-xs text-white/45">Hiding a layer only changes your view.</p>}
      <ConfirmActionDialog
        open={deleting != null}
        title={`Delete ${deleting?.name ?? "layer"}?`}
        description={deleteDescription(deleting)}
        confirmLabel="Delete layer"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          useCanvasStore.getState().deleteLayer(deleting.id);
          setDeleting(null);
        }}
      />
    </section>
  );
}
