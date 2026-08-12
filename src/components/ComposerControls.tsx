"use client";

import { useEffect, useRef, useState } from "react";
import { Reorder } from "framer-motion";
import {
  Plus,
  Clapperboard,
  Settings2,
  ChevronDown,
  Check,
  X,
  Box,
  FolderClosed,
  Layers,
  Sparkles,
  Volume2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { Dropdown, MenuItem } from "./Dropdown";
import {
  MODELS,
  aspectRatiosForModel,
  durationsForModel,
  resolutionsForModel,
  supportsAudio,
  supportsVideoEditExtend,
  VIDEO_TASK_MODES,
} from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * Reference-image strip + settings toolbar, extracted verbatim (behavior
 * unchanged) from the pre-redesign PromptComposer.tsx so StudioChat can
 * mount them once instead of duplicating ~500 lines. What stayed behind in
 * StudioChat: the upload trigger/paste/drag-drop and the MentionTextarea
 * input itself — those are wired differently there (chat-first input row)
 * and aren't shared logic in the same sense these are.
 *
 * Split into two exports (rather than one bundled component) so StudioChat
 * can lay them out either side of the input row, matching the original
 * composer's order: references above the input, settings below it.
 *
 * No mode chip in the toolbar — the tab already fixes `s.mode`, so offering
 * a mode switch here would just contradict which tab you're looking at.
 */
export function ReferenceStrip({ onInsertTag }: { onInsertTag: (tag: string) => void }) {
  const s = useStore();

  // See the original comment in PromptComposer's history: Reorder.Group's
  // drag physics expect `values` to update synchronously within the same
  // render as the gesture — buffering locally keeps every tick synchronous;
  // only the settled result is committed to the store.
  const [dragRefs, setDragRefs] = useState(s.referenceImages);
  const dragRefsRef = useRef(dragRefs);
  useEffect(() => {
    dragRefsRef.current = s.referenceImages;
    setDragRefs(s.referenceImages);
  }, [s.referenceImages]);

  if (s.referenceVideos.length === 0 && dragRefs.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {s.referenceVideos.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {s.referenceVideos.map((ref, i) => (
            <span
              key={ref}
              className="flex items-center gap-1.5 rounded-lg bg-ink-750 py-1 pl-2 pr-1 text-xs text-white/75 ring-1 ring-line"
              title={`Reference clip ${i + 1} — type @vid${i + 1} to point at it`}
            >
              <Clapperboard className="h-3.5 w-3.5 text-brand" />
              @vid{i + 1}
              <button
                onClick={() => s.removeReferenceVideo(i)}
                className="grid h-4 w-4 place-items-center rounded text-white/40 hover:bg-white/10 hover:text-white"
                aria-label={`Remove reference clip ${i + 1}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {dragRefs.length > 0 && (
        <Reorder.Group
          as="div"
          axis="x"
          values={dragRefs}
          onReorder={(newOrder) => {
            dragRefsRef.current = newOrder;
            setDragRefs(newOrder);
          }}
          className="scroll-none flex gap-2 overflow-x-auto px-1 pb-1"
        >
          {dragRefs.map((src, i) => (
            <Reorder.Item
              key={src}
              value={src}
              as="div"
              style={{ touchAction: "none" }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              whileDrag={{ scale: 1.05, zIndex: 1 }}
              onDragEnd={() => s.reorderReferences(dragRefsRef.current)}
              title={`Insert @img${i + 1} — drag to reorder`}
              className="group relative h-16 w-16 shrink-0 cursor-grab overflow-hidden rounded-lg ring-1 ring-line transition hover:ring-brand/50 active:cursor-grabbing"
              onClick={() => onInsertTag(`@img${i + 1}`)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt=""
                draggable={false}
                style={{ WebkitUserDrag: "none" } as React.CSSProperties}
                className="h-full w-full object-cover"
              />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-semibold text-brand backdrop-blur-sm">
                @img{i + 1}
              </span>
              <span
                role="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  s.removeReference(i);
                }}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/90 opacity-0 transition group-hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      )}

      {s.mode === "video" && /higgsfield/i.test(s.model) && s.referenceImages.length > 1 && (
        <div className="flex items-start gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] leading-snug text-brand/90">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            All {s.referenceImages.length} references will be used — Seedance 2.0 composes them
            into one shot. Tag them in your prompt as <b>@img1, @img2…</b> for left/right
            placement and roles.
          </span>
        </div>
      )}
    </div>
  );
}

export function SettingsToolbar() {
  const s = useStore();
  const audioApplies = s.mode === "video" && supportsAudio(s.model);
  const editExtendApplies = s.mode === "video" && supportsVideoEditExtend(s.model);
  const videoTaskMode = editExtendApplies ? s.videoTaskMode : "generate";
  const modeModels = MODELS.filter((m) => m.kind === s.mode);

  return (
      <div className="composer-toolbar flex min-w-0 flex-wrap items-center gap-1.5 py-px">
        {/* model */}
        <Dropdown
          className="composer-model min-w-0 flex-1"
          label={`Model: ${s.model}`}
          side="top"
          trigger={(open) => (
            <Chip open={open}>
              <Box className="h-4 w-4 text-white/55" />
              <span className="max-w-[14rem] truncate font-medium">{s.model}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </Chip>
          )}
        >
          {(close) =>
            modeModels.map((m) => (
              <MenuItem
                key={m.id}
                active={m.name === s.model}
                onClick={() => {
                  s.setModel(m.name);
                  close();
                }}
              >
                <Box className="h-4 w-4 text-white/50" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{m.name}</span>
                  {m.hint && <span className="text-[10px] leading-snug text-white/40">{m.hint}</span>}
                </span>
                {m.badge && (
                  <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                    {m.badge}
                  </span>
                )}
                {m.name === s.model && <Check className="h-4 w-4 text-brand" />}
              </MenuItem>
            ))
          }
        </Dropdown>

        {/* settings (aspect / resolution / duration / batch / audio) */}
        <Dropdown
          className="composer-settings shrink-0"
          label="Generation settings"
          align="right"
          side="top"
          panelClassName="w-max min-w-[230px] max-w-[min(92vw,340px)] p-3 max-h-[60vh] overflow-y-auto scroll-thin"
          trigger={(open) => (
            <Chip open={open}>
              <Settings2 className="h-4 w-4 text-white/55" />
              {editExtendApplies && videoTaskMode !== "generate" && (
                <>
                  <span className="font-medium capitalize text-brand">{videoTaskMode}</span>
                  <span className="text-white/35">·</span>
                </>
              )}
              <span className="font-medium">{videoTaskMode === "generate" ? s.aspectRatio : "Adaptive"}</span>
              <span className="text-white/35">·</span>
              <span>{s.resolution}</span>
              {s.mode === "video" && (
                <>
                  <span className="text-white/35">·</span>
                  <span>{videoTaskMode === "edit" ? "Auto" : `${s.duration}s`}</span>
                </>
              )}
              {s.batchCount > 1 && (
                <>
                  <span className="text-white/35">·</span>
                  <span className="text-brand">{s.batchCount}×</span>
                </>
              )}
              {audioApplies && s.generateAudio && (
                <>
                  <span className="text-white/35">·</span>
                  <Volume2 className="h-3.5 w-3.5 text-brand" />
                </>
              )}
            </Chip>
          )}
        >
          {() => (
            <div className="space-y-3">
              {editExtendApplies && (
                <div>
                  <Segment
                    label="Video task"
                    options={VIDEO_TASK_MODES.map((m) => m[0].toUpperCase() + m.slice(1))}
                    value={videoTaskMode[0].toUpperCase() + videoTaskMode.slice(1)}
                    onChange={(v) => s.setVideoTaskMode(v.toLowerCase() as typeof videoTaskMode)}
                  />
                  {videoTaskMode !== "generate" && s.referenceVideos.length === 0 && (
                    <p className="mt-1 text-[11px] leading-snug text-amber-400/90">
                      Attach a reference clip above to {videoTaskMode} a video.
                    </p>
                  )}
                </div>
              )}
              {videoTaskMode === "generate" ? (
                <Segment
                  label="Aspect ratio"
                  options={aspectRatiosForModel(s.model, s.mode)}
                  value={s.aspectRatio}
                  onChange={s.setAspectRatio}
                />
              ) : (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Aspect ratio
                  </p>
                  <p className="text-xs text-white/50">Adaptive — matches the reference clip</p>
                </div>
              )}
              <Segment
                label="Resolution"
                options={resolutionsForModel(s.model, s.mode)}
                value={s.resolution}
                onChange={s.setResolution}
              />
              {s.mode === "video" && videoTaskMode === "edit" && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Duration
                  </p>
                  <p className="text-xs text-white/50">Auto — matches the reference clip</p>
                </div>
              )}
              {s.mode === "video" && videoTaskMode !== "edit" && (
                <Segment
                  label="Duration"
                  options={durationsForModel(s.model).map((d) => `${d}s`)}
                  value={`${s.duration}s`}
                  onChange={(v) => s.setDuration(parseInt(v))}
                />
              )}
              <Segment
                label="Batch (per generate)"
                options={["1×", "2×"]}
                value={`${s.batchCount}×`}
                onChange={(v) => s.setBatchCount(parseInt(v))}
              />
              {audioApplies && (
                <div>
                  <Segment
                    label="Audio"
                    options={["Off", "On"]}
                    value={s.generateAudio ? "On" : "Off"}
                    onChange={(v) => s.setGenerateAudio(v === "On")}
                  />
                  <p className="mt-1 text-[11px] leading-snug text-white/35">
                    Seedance scores the video with synchronised sound. Billed on top of the video.
                  </p>
                </div>
              )}
            </div>
          )}
        </Dropdown>

        {/* destination: which project / folder new generations land in */}
        <Dropdown
          className="composer-destination shrink-0"
          label="Generation destination"
          align="right"
          side="top"
          panelClassName="min-w-[210px]"
          trigger={(open) => {
            const proj = s.projects.find((p) => p.id === s.activeProjectId);
            const folder = proj?.folders.find((f) => f.id === s.activeFolderId);
            return (
              <Chip open={open}>
                <FolderClosed className="h-4 w-4 text-white/55" />
                <span className="max-w-[110px] truncate font-medium">{proj ? proj.name : "No project"}</span>
                <span className="text-white/35">/</span>
                <span className="max-w-[80px] truncate">{folder ? folder.name : "All"}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
              </Chip>
            );
          }}
        >
          {() => {
            const proj = s.projects.find((p) => p.id === s.activeProjectId);
            return (
              <div>
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">Project</p>
                {s.projects.map((p) => (
                  <MenuItem
                    key={p.id}
                    active={p.id === s.activeProjectId}
                    onClick={() => s.setActiveProject(p.id)}
                  >
                    <Layers className="h-4 w-4 text-white/45" />
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.id === s.activeProjectId && <Check className="h-4 w-4 text-brand" />}
                  </MenuItem>
                ))}
                <MenuItem
                  onClick={() => {
                    const name = window.prompt("New project name");
                    if (name?.trim()) s.createProject(name.trim());
                  }}
                >
                  <Plus className="h-4 w-4 text-white/60" />
                  <span className="flex-1">New project</span>
                </MenuItem>
                {proj && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">Folder</p>
                    <MenuItem active={s.activeFolderId === null} onClick={() => s.setActiveFolder(null)}>
                      <Layers className="h-4 w-4 text-white/45" />
                      <span className="flex-1">All assets</span>
                      {s.activeFolderId === null && <Check className="h-4 w-4 text-brand" />}
                    </MenuItem>
                    {proj.folders.map((f) => (
                      <MenuItem
                        key={f.id}
                        active={s.activeFolderId === f.id}
                        onClick={() => s.setActiveFolder(f.id)}
                      >
                        <FolderClosed className="h-4 w-4 text-white/45" />
                        <span className="flex-1 truncate">{f.name}</span>
                        {s.activeFolderId === f.id && <Check className="h-4 w-4 text-brand" />}
                      </MenuItem>
                    ))}
                  </>
                )}
              </div>
            );
          }}
        </Dropdown>
      </div>
  );
}

export function Chip({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "control-chip flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/80 transition-colors hover:border-lineStrong hover:text-white",
        open && "border-brand/40 text-white"
      )}
    >
      {children}
    </span>
  );
}

function Segment({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              value === opt
                ? "bg-brand/20 text-brand ring-1 ring-brand/40"
                : "bg-ink-700 text-white/65 ring-1 ring-line hover:text-white"
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
