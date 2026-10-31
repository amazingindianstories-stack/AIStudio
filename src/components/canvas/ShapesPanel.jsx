"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FolderPlus,
  MoveRight,
  Palette,
  Search,
  Settings2,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useCanvasStore } from "@/lib/canvas-store";
import {
  BASIC_SHAPES,
  ensureShapePacksLoaded,
  registerCustomShapes,
} from "@/lib/canvas/shapes";
import { DIAGRAM_THEMES } from "@/lib/canvas/diagram-themes";
import { ShapeGlyph } from "./ShapeGlyph";

export function ShapesPanel({
  tool,
  setTool,
  setLastShape,
  onToggleLock,
  close,
}) {
  const [packMod, setPackMod] = useState(null);
  const [enabledPacks, setEnabledPacks] = useState([]);
  const [query, setQuery] = useState("");
  const [managingPacks, setManagingPacks] = useState(false);
  const [customPacks, setCustomPacks] = useState([]);
  const [showCustomCreator, setShowCustomCreator] = useState(false);
  const [newPackName, setNewPackName] = useState("");
  const [newPackShared, setNewPackShared] = useState(false);
  const [customError, setCustomError] = useState(null);

  const diagramThemeId = useCanvasStore((s) => s.diagramThemeId);
  const setDiagramTheme = useCanvasStore((s) => s.setDiagramTheme);
  const applyThemeToSelection = useCanvasStore((s) => s.applyThemeToSelection);
  const hasSelection = useCanvasStore(
    (s) => s.selection.length > 0 || s.selectedConnectorIds.length > 0
  );

  useEffect(() => {
    let active = true;
    ensureShapePacksLoaded().then((mod) => {
      if (!active) return;
      setPackMod(mod);
      setEnabledPacks(mod.loadEnabledPackIds());
    });
    apiFetch("/api/canvas-shape-packs", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data?.packs) return;
        setCustomPacks(data.packs);
        registerCustomShapes(data.packs);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const pickTool = (toolId, e) => {
    setLastShape?.(toolId);
    setTool(toolId);
    if (e?.detail === 2) onToggleLock?.();
    close({ restoreFocus: false });
  };

  const togglePack = (packId) => {
    if (!packMod) return;
    const next = enabledPacks.includes(packId)
      ? enabledPacks.filter((id) => id !== packId)
      : [...enabledPacks, packId];
    setEnabledPacks(next);
    packMod.saveEnabledPackIds(next);
  };

  const handleCreateCustomPack = async (e) => {
    e.preventDefault();
    setCustomError(null);
    const trimmed = newPackName.trim();
    if (!trimmed) {
      setCustomError("Pack name is required.");
      return;
    }
    try {
      const res = await apiFetch("/api/canvas-shape-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, shared: newPackShared, showNames: true, shapes: [] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setCustomError(body.error || "Could not create shape pack.");
        return;
      }
      const next = [body.pack, ...customPacks];
      setCustomPacks(next);
      registerCustomShapes(next);
      setNewPackName("");
      setShowCustomCreator(false);
    } catch {
      setCustomError("Could not create shape pack.");
    }
  };

  const updateCustomPack = async (packId, patch) => {
    setCustomError(null);
    try {
      const res = await apiFetch(`/api/canvas-shape-packs/${packId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) {
        setCustomError(body.error || "Could not update shape pack.");
        return;
      }
      const next = customPacks.map((p) => (p.id === packId ? body.pack : p));
      setCustomPacks(next);
      registerCustomShapes(next);
    } catch {
      setCustomError("Could not update shape pack.");
    }
  };

  const deleteCustomPack = async (packId) => {
    setCustomError(null);
    try {
      const res = await apiFetch(`/api/canvas-shape-packs/${packId}`, { method: "DELETE" });
      if (!res.ok) return;
      setCustomPacks(customPacks.filter((p) => p.id !== packId));
    } catch {}
  };

  const handleUploadSvgFiles = async (pack, fileList) => {
    if (!fileList || !fileList.length) return;
    setCustomError(null);
    const added = [];
    for (const file of Array.from(fileList)) {
      if (file.size > 50 * 1024) {
        setCustomError(`"${file.name}" exceeds the 50 KB SVG limit.`);
        return;
      }
      const text = await file.text();
      const baseName = file.name.replace(/\.svg$/i, "").trim() || "Custom Shape";
      added.push({ name: baseName, svg: text });
    }
    await updateCustomPack(pack.id, { addShapes: added });
  };

  const reorderCustomShape = async (pack, idx, dir) => {
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= pack.shapes.length) return;
    const nextShapes = [...pack.shapes];
    const tmp = nextShapes[idx];
    nextShapes[idx] = nextShapes[targetIdx];
    nextShapes[targetIdx] = tmp;
    await updateCustomPack(pack.id, { shapes: nextShapes });
  };

  const q = query.trim().toLowerCase();
  const filteredBasic = q
    ? BASIC_SHAPES.filter((s) => s.label.toLowerCase().includes(q) || s.tool.toLowerCase().includes(q))
    : BASIC_SHAPES;

  const visiblePacks = packMod
    ? packMod.filterShapePacks(packMod.SHAPE_PACKS, enabledPacks, query)
    : [];

  return (
    <div className="flex max-h-[72vh] w-[320px] flex-col gap-2 overflow-y-auto p-1.5 text-xs text-white">
      {/* Search & All Shapes Pack Manager Header */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
          <input
            type="search"
            aria-label="Search shapes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all shapes..."
            className="h-7 w-full rounded-md border border-line bg-ink-900 pl-7 pr-2 text-xs text-white placeholder:text-white/35 outline-none focus:border-brand"
          />
        </div>
        <button
          type="button"
          aria-label="Manage shape packs"
          aria-pressed={managingPacks}
          onClick={() => setManagingPacks((v) => !v)}
          title="Enable or disable diagramming shape packs"
          className={cn(
            "flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] font-medium transition",
            managingPacks
              ? "bg-brand text-white"
              : "bg-ink-900 text-white/70 hover:bg-white/[0.07] hover:text-white"
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          <span>All shapes</span>
        </button>
      </div>

      {/* Diagram Themes Picker (Line 174) */}
      <div role="group" aria-label="Diagram themes" className="rounded-lg border border-line bg-ink-900/60 p-1.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-white/45">
            <Palette className="h-3 w-3" />
            <span>Diagram theme</span>
          </span>
          {hasSelection && (
            <button
              type="button"
              aria-label="Apply theme to selection"
              onClick={() => applyThemeToSelection(diagramThemeId)}
              className="rounded bg-brand/20 px-1.5 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/30"
            >
              Apply to selection
            </button>
          )}
        </div>
        <div className="grid grid-cols-6 gap-1">
          {DIAGRAM_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              aria-label={`Diagram theme ${theme.label}`}
              aria-pressed={diagramThemeId === theme.id}
              title={theme.label}
              onClick={() => {
                setDiagramTheme(theme.id);
                if (hasSelection) applyThemeToSelection(theme.id);
              }}
              className={cn(
                "flex h-6 items-center justify-center rounded border transition",
                diagramThemeId === theme.id
                  ? "border-white ring-1 ring-brand"
                  : "border-white/15 opacity-75 hover:opacity-100"
              )}
              style={{ backgroundColor: theme.fill }}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: theme.stroke }}
              />
            </button>
          ))}
        </div>
      </div>

      {/* Shape Pack Enable/Disable Manager (Line 167) */}
      {managingPacks && packMod && (
        <div
          role="region"
          aria-label="Shape pack manager"
          className="flex flex-col gap-1 rounded-lg border border-line bg-ink-900 p-2"
        >
          <p className="text-[11px] font-semibold text-white/80">Enabled shape packs</p>
          {packMod.SHAPE_PACKS.map((pack) => {
            const checked = enabledPacks.includes(pack.id);
            return (
              <label
                key={pack.id}
                className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-white/[0.04]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePack(pack.id)}
                  className="mt-0.5 accent-indigo-500"
                />
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-white/90">{pack.label}</span>
                  <span className="text-[10px] text-white/45">{pack.description}</span>
                </div>
              </label>
            );
          })}
        </div>
      )}

      {/* Basic Shapes (Always present; exact aria-labels preserved for existing tests) */}
      {filteredBasic.length > 0 && (
        <div>
          <p className="px-1 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
            Basic shapes
          </p>
          <div role="group" aria-label="Basic shapes" className="grid grid-cols-6 gap-1">
            {filteredBasic.map((s) => (
              <button
                key={s.tool}
                type="button"
                role="menuitem"
                aria-label={s.label}
                title={s.tool === "rect" ? `${s.label} (R)` : s.label}
                onClick={(e) => pickTool(s.tool, e)}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
                  tool === s.tool
                    ? "bg-ink-600 ring-1 ring-line text-white"
                    : "text-white/60 hover:bg-white/[0.07] hover:text-white"
                )}
              >
                <ShapeGlyph tool={s.tool} className="h-[18px] w-[18px]" />
              </button>
            ))}
            {!q && (
              <button
                type="button"
                role="menuitem"
                aria-label="Line / arrow"
                title="Line / arrow (connector)"
                onClick={() => {
                  setTool("connector");
                  close({ restoreFocus: false });
                }}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
                  tool === "connector"
                    ? "bg-ink-600 ring-1 ring-line text-white"
                    : "text-white/60 hover:bg-white/[0.07] hover:text-white"
                )}
              >
                <MoveRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Enabled Diagramming & Technical Shape Packs (Lines 166, 168, 169, 170, 171, 172, 173, 177) */}
      {visiblePacks.map((pack) => (
        <div key={pack.id}>
          <p className="px-1 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
            {pack.label}
          </p>
          <div role="group" aria-label={pack.label} className="grid grid-cols-6 gap-1">
            {pack.shapes.map((s) => (
              <button
                key={s.tool}
                type="button"
                role="menuitem"
                aria-label={s.label}
                title={s.label}
                onClick={(e) => pickTool(s.tool, e)}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
                  tool === s.tool
                    ? "bg-ink-600 ring-1 ring-line text-white"
                    : "text-white/60 hover:bg-white/[0.07] hover:text-white"
                )}
              >
                <ShapeGlyph tool={s.tool} className="h-[18px] w-[18px]" />
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Custom Shape Packs (Line 175) */}
      <div className="border-t border-line pt-2" role="region" aria-label="Custom shape packs">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-white/40">
            Custom shape packs
          </span>
          <button
            type="button"
            aria-label="New custom shape pack"
            onClick={() => setShowCustomCreator((v) => !v)}
            className="flex items-center gap-1 rounded bg-white/[0.07] px-2 py-0.5 text-[10px] font-medium text-white/80 hover:bg-white/[0.12] hover:text-white"
          >
            <FolderPlus className="h-3 w-3" />
            <span>New pack</span>
          </button>
        </div>

        {customError && (
          <p role="alert" className="mb-1.5 rounded bg-rose-500/20 px-2 py-1 text-[11px] text-rose-200">
            {customError}
          </p>
        )}

        {showCustomCreator && (
          <form onSubmit={handleCreateCustomPack} className="mb-2 flex flex-col gap-1.5 rounded border border-line bg-ink-900 p-2">
            <input
              type="text"
              aria-label="Custom shape pack name"
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              placeholder="Pack name (e.g. Vendor Icons)"
              className="h-7 rounded border border-line bg-ink-800 px-2 text-xs text-white outline-none focus:border-brand"
            />
            <label className="flex items-center gap-1.5 text-[11px] text-white/75">
              <input
                type="checkbox"
                checked={newPackShared}
                onChange={(e) => setNewPackShared(e.target.checked)}
                className="accent-indigo-500"
              />
              <span>Share with organisation</span>
            </label>
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setShowCustomCreator(false)}
                className="rounded px-2 py-1 text-[11px] text-white/60 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-brand px-2.5 py-1 text-[11px] font-medium text-white"
              >
                Create pack
              </button>
            </div>
          </form>
        )}

        {customPacks.map((pack) => {
          const packShapes = q
            ? (pack.shapes || []).filter((s) => s.name?.toLowerCase().includes(q))
            : pack.shapes || [];
          return (
            <div key={pack.id} className="mb-2 rounded-lg border border-line bg-ink-900/50 p-1.5">
              <div className="mb-1 flex items-center justify-between gap-1">
                {pack.isOwner ? (
                  <input
                    type="text"
                    aria-label={`Rename pack ${pack.name}`}
                    defaultValue={pack.name}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val && val !== pack.name) updateCustomPack(pack.id, { name: val });
                    }}
                    className="w-28 bg-transparent text-[11px] font-semibold text-white outline-none focus:underline"
                  />
                ) : (
                  <span className="truncate text-[11px] font-semibold text-white/90">{pack.name}</span>
                )}
                {pack.isOwner && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Toggle show names for ${pack.name}`}
                      onClick={() => updateCustomPack(pack.id, { showNames: !pack.showNames })}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px]",
                        pack.showNames ? "bg-indigo-500/30 text-indigo-200" : "bg-white/5 text-white/45"
                      )}
                      title="Show or hide shape names"
                    >
                      Aa
                    </button>
                    <button
                      type="button"
                      aria-label={`Toggle organisation sharing for ${pack.name}`}
                      onClick={() => updateCustomPack(pack.id, { shared: !pack.shared })}
                      className={cn(
                        "rounded p-1",
                        pack.shared ? "bg-emerald-500/25 text-emerald-300" : "bg-white/5 text-white/45"
                      )}
                      title={pack.shared ? "Shared with organisation" : "Private pack"}
                    >
                      <Share2 className="h-3 w-3" />
                    </button>
                    <label
                      className="cursor-pointer rounded bg-white/10 p-1 text-white/80 hover:bg-white/20"
                      title="Upload SVG shape (max 50 KB)"
                    >
                      <Upload className="h-3 w-3" />
                      <input
                        type="file"
                        accept=".svg,image/svg+xml"
                        multiple
                        aria-label={`Upload SVG to ${pack.name}`}
                        className="hidden"
                        onChange={(e) => handleUploadSvgFiles(pack, e.target.files)}
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`Delete pack ${pack.name}`}
                      onClick={() => deleteCustomPack(pack.id)}
                      className="rounded p-1 text-white/40 hover:bg-rose-500/20 hover:text-rose-300"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>

              <div role="group" aria-label={pack.name} className="grid grid-cols-4 gap-1">
                {packShapes.map((s, idx) => {
                  const customTool = `custom-shape:${pack.id}:${s.id}`;
                  return (
                    <div key={s.id} className="group relative flex flex-col items-center">
                      <button
                        type="button"
                        role="menuitem"
                        aria-label={s.name}
                        title={s.name}
                        onClick={(e) => pickTool(customTool, e)}
                        className={cn(
                          "flex h-10 w-full flex-col items-center justify-center rounded-md p-1 transition",
                          tool === customTool
                            ? "bg-ink-600 ring-1 ring-line text-white"
                            : "text-white/70 hover:bg-white/[0.07] hover:text-white"
                        )}
                      >
                        <ShapeGlyph
                          tool={customTool}
                          customSvg={s.svg}
                          customViewBox={s.viewBox}
                          className="h-4 w-4"
                        />
                        {pack.showNames && (
                          <span className="mt-0.5 max-w-full truncate text-[9px] leading-tight">
                            {s.name}
                          </span>
                        )}
                      </button>
                      {pack.isOwner && packShapes.length > 1 && (
                        <div className="absolute -top-1 right-0 hidden gap-0.5 rounded bg-ink-900/90 p-0.5 group-hover:flex">
                          {idx > 0 && (
                            <button
                              type="button"
                              aria-label={`Move ${s.name} earlier`}
                              onClick={() => reorderCustomShape(pack, idx, -1)}
                              className="p-0.5 text-white/60 hover:text-white"
                            >
                              <ArrowUp className="h-2.5 w-2.5" />
                            </button>
                          )}
                          {idx < packShapes.length - 1 && (
                            <button
                              type="button"
                              aria-label={`Move ${s.name} later`}
                              onClick={() => reorderCustomShape(pack, idx, 1)}
                              className="p-0.5 text-white/60 hover:text-white"
                            >
                              <ArrowDown className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
