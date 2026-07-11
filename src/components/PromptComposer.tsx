"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { motion } from "framer-motion";
import {
  Plus,
  Image as ImageIcon,
  Clapperboard,
  MessageSquare,
  UserRound,
  AudioLines,
  Settings2,
  ArrowUp,
  ChevronDown,
  Check,
  Loader2,
  Upload,
  BookOpen,
  Images,
  X,
  Box,
  FolderClosed,
  Layers,
  Sparkles,
} from "lucide-react";
import { useStore, restoreComposerDraft } from "@/lib/store";
import { Dropdown, MenuItem } from "./Dropdown";
import { MentionTextarea, type MentionHandle } from "./MentionTextarea";
import {
  DEFAULTS,
  MODELS,
  MODES,
  aspectRatiosForModel,
  durationsForModel,
  resolutionsForModel,
} from "@/lib/config";
import { cn } from "@/lib/utils";
import type { GenerationKind } from "@/lib/types";

const MODE_ICONS: Record<string, any> = {
  Image: ImageIcon,
  Clapperboard,
  MessageSquare,
  UserRound,
  AudioLines,
};

// Client reference longest-side cap. Identity tiles are cropped from these
// refs server-side, so higher fidelity here carries real facial detail — see
// the payload-budget ladder in addImageFiles for how this trades off against
// Vercel's 4.5MB body limit.
const REF_MAX_DIM = Number(process.env.NEXT_PUBLIC_REF_MAX_DIM) || 2048;

// Vercel body limit 4.5MB; base64 inflates ~1.33×, so the raw-bytes budget
// across all refs in a batch is ~3.38MB. Target 3.0MB to leave headroom for
// the prompt JSON.
const REF_BATCH_BUDGET_BYTES = 3.0 * 1024 * 1024;

/** Raw byte size of a data URL's base64 payload, ((len*3)/4). */
function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return (b64.length * 3) / 4;
}

export function PromptComposer() {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const mentionRef = useRef<MentionHandle>(null);
  const toolbarMeasureRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preferredWidth, setPreferredWidth] = useState(768);

  // Bring back the locally cached draft (prompt + reference images) after a
  // refresh. Runs after mount so SSR markup stays consistent.
  useEffect(() => {
    restoreComposerDraft();
  }, []);

  useEffect(() => {
    const toolbar = toolbarMeasureRef.current;
    if (!toolbar) return;

    const syncWidth = () => {
      const controls = Array.from(
        toolbar.querySelectorAll<HTMLElement>(".control-chip")
      );
      const controlsWidth = controls.reduce((width, control) => {
        const style = window.getComputedStyle(control);
        const children = Array.from(control.children).filter(
          (child) => window.getComputedStyle(child).display !== "none"
        ) as HTMLElement[];
        const contentWidth = children.reduce((sum, child) => {
          const renderedWidth = child.getBoundingClientRect().width;
          const cappedLabel = child.matches(
            ".composer-model-label, .composer-project-label, .composer-folder-label"
          );
          return sum + (cappedLabel ? renderedWidth : Math.max(child.scrollWidth, renderedWidth));
        }, 0);
        const gap = Number.parseFloat(style.columnGap) || 0;
        const padding =
          (Number.parseFloat(style.paddingLeft) || 0) +
          (Number.parseFloat(style.paddingRight) || 0);
        return width + contentWidth + gap * Math.max(0, children.length - 1) + padding;
      }, 0);
      const toolbarWidth = Math.ceil(
        controlsWidth + Math.max(0, controls.length - 1) * 6
      );
      setPreferredWidth(Math.min(1120, Math.max(768, toolbarWidth + 72)));
    };
    syncWidth();

    const resizeObserver = new ResizeObserver(syncWidth);
    resizeObserver.observe(toolbar);
    const mutationObserver = new MutationObserver(syncWidth);
    mutationObserver.observe(toolbar, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  const modeModels = MODELS.filter((m) => m.kind === s.mode);
  const activeMode = MODES.find((m) => m.id === s.mode);

  // Downscale image to fit within Vercel's 4.5MB payload limit, at a caller-
  // chosen dimension/quality step (see addImageFiles' budget ladder).
  const downscaleImage = async (
    file: File,
    maxDim: number,
    quality: number
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject("No canvas context");
        ctx.drawImage(img, 0, 0, width, height);
        // Export as JPEG to ensure small size (avoids massive PNGs)
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject("Failed to load image");
      img.src = url;
    });
  };

  // Read image File objects (from upload, paste, or drop) into references.
  //
  // Payload-budget ladder: encode the WHOLE batch at each step, summing raw
  // bytes, and only step down (lower quality, then lower dimension) if the
  // batch would still risk Vercel's 4.5MB body limit. Keeps typical 1–3 ref
  // uploads at full REF_MAX_DIM fidelity — the density identity tiles are
  // cropped from — while the last step (1024px/q0.8, today's behavior) is a
  // guaranteed-to-fit floor.
  const addImageFiles = async (files: File[]) => {
    const valid = files.filter((f) => f.type.startsWith("image/"));
    if (!valid.length) return;

    const steps: Array<{ dim: number; quality: number }> = [
      { dim: REF_MAX_DIM, quality: 0.85 },
      { dim: REF_MAX_DIM, quality: 0.7 },
      { dim: 1536, quality: 0.8 },
      { dim: 1024, quality: 0.8 },
    ];

    let dataUrls: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const { dim, quality } = steps[i];
      const encoded = await Promise.all(
        valid.map(async (f) => {
          try {
            return await downscaleImage(f, dim, quality);
          } catch (e) {
            console.error("Failed to downscale image", e);
            return null;
          }
        })
      );
      dataUrls = encoded.filter((u): u is string => u !== null);
      if (!dataUrls.length) return;
      const totalBytes = dataUrls.reduce((n, u) => n + dataUrlBytes(u), 0);
      if (totalBytes <= REF_BATCH_BUDGET_BYTES || i === steps.length - 1) break;
    }

    for (const dataUrl of dataUrls) s.addReference(dataUrl);
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  // Paste images from the clipboard (Cmd/Ctrl+V) — only intercept when the
  // clipboard actually carries images, so normal text paste is unaffected.
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  // Drag & drop image files from the OS file manager. Ignore internal drags
  // (e.g. moving cards between folders) which carry no files.
  const isFileDrag = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
  };

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (!isFileDrag(e)) return;
    e.preventDefault();
    addImageFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <motion.div
      layout="size"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      style={{ width: `min(100%, ${preferredWidth}px)` }}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="composer-shell relative mx-auto max-w-full rounded-2xl border border-line bg-ink-800/90 p-2.5 shadow-panel backdrop-blur-xl"
    >
      {/* drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-brand/60 bg-ink-900/85 backdrop-blur-sm">
          <Upload className="h-6 w-6 text-brand" />
          <p className="text-sm font-medium text-white/90">
            Drop images to add as references
          </p>
        </div>
      )}
      {/* reference thumbnails — click to insert its @imgN tag into the prompt */}
      {s.referenceImages.length > 0 && (
        <div className="scroll-none mb-2 flex gap-2 overflow-x-auto px-1 pb-1">
          {s.referenceImages.map((src, i) => (
            <motion.button
              key={i}
              type="button"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => mentionRef.current?.insertTag(`@img${i + 1}`)}
              title={`Insert @img${i + 1}`}
              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg ring-1 ring-line transition hover:ring-brand/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="h-full w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-semibold text-brand backdrop-blur-sm">
                @img{i + 1}
              </span>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  s.removeReference(i);
                }}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/90 opacity-0 transition group-hover:opacity-100"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </motion.button>
          ))}
        </div>
      )}

      {/* Higgsfield Seedance (via MCP) natively accepts multiple reference
          images, so several characters/locations can drive one shot. */}
      {s.mode === "video" &&
        /higgsfield/i.test(s.model) &&
        s.referenceImages.length > 1 && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] leading-snug text-brand/90">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              All {s.referenceImages.length} references will be used — Seedance 2.0
              composes them into one shot. Tag them in your prompt as{" "}
              <b>@img1, @img2…</b> for left/right placement and roles.
            </span>
          </div>
        )}

      {/* input row */}
      <div className="flex items-start gap-2">
        {/* upload */}
        <Dropdown
          side="top"
          trigger={(open) => (
            <span
              className={cn(
                "grid h-[58px] w-[58px] shrink-0 place-items-center rounded-xl border border-dashed border-white/15 text-white/55 transition-colors hover:border-brand/40 hover:text-brand",
                open && "border-brand/50 text-brand"
              )}
            >
              <span className="flex flex-col items-center gap-0.5">
                <Plus className="h-4 w-4" />
                <span className="text-[10px]">material</span>
              </span>
            </span>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  fileRef.current?.click();
                  close();
                }}
              >
                <Upload className="h-4 w-4 text-white/60" /> Local upload
              </MenuItem>
              <MenuItem disabled>
                <BookOpen className="h-4 w-4" /> Material library
              </MenuItem>
              <MenuItem disabled>
                <Images className="h-4 w-4" /> Portrait Gallery
              </MenuItem>
            </>
          )}
        </Dropdown>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onFiles}
        />

        <MentionTextarea
          ref={mentionRef}
          value={s.prompt}
          onChange={s.setPrompt}
          onSubmit={s.generate}
          references={s.referenceImages}
          placeholder={
            s.mode === "image"
              ? "Describe the image… type @ to reference uploaded images (@img1, @img2)."
              : "Describe the video… type @ to reference uploaded images (@img1, @img2)."
          }
        />
      </div>

      {/* toolbar */}
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <div
          ref={toolbarMeasureRef}
          className="composer-toolbar flex min-w-0 flex-1 items-center gap-1.5 py-px"
        >
        {/* mode */}
        <Dropdown
          className="composer-mode shrink-0"
          label={`Generation mode: ${activeMode?.label ?? s.mode}`}
          side="top"
          trigger={(open) => (
            <Chip open={open}>
              {activeMode && MODE_ICONS[activeMode.icon] ? (
                (() => {
                  const I = MODE_ICONS[activeMode.icon];
                  return <I className="h-4 w-4 text-brand" />;
                })()
              ) : null}
              <span className="composer-mode-label font-medium">{activeMode?.label}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </Chip>
          )}
        >
          {(close) =>
            MODES.map((m) => {
              const I = MODE_ICONS[m.icon];
              return (
                <MenuItem
                  key={m.id}
                  active={m.id === s.mode}
                  disabled={!m.enabled}
                  onClick={() => {
                    if (m.id === "image" || m.id === "video") s.setMode(m.id);
                    close();
                  }}
                >
                  {I && <I className="h-4 w-4" />}
                  <span className="flex-1">{m.label}</span>
                  {m.id === s.mode && <Check className="h-4 w-4 text-brand" />}
                  {!m.enabled && <span className="text-[10px] text-white/30">soon</span>}
                </MenuItem>
              );
            })
          }
        </Dropdown>

        {/* model */}
        <Dropdown
          className="composer-model min-w-0 flex-1"
          label={`Model: ${s.model}`}
          side="top"
          trigger={(open) => (
            <Chip open={open}>
              <Box className="h-4 w-4 text-white/55" />
              <span className="composer-model-label max-w-[14rem] truncate font-medium">
                {s.model}
              </span>
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
                  {m.hint && (
                    <span className="text-[10px] leading-snug text-white/40">
                      {m.hint}
                    </span>
                  )}
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

        {/* settings (aspect / resolution / duration / batch) */}
        <Dropdown
          className="composer-settings shrink-0"
          label="Generation settings"
          align="right"
          side="top"
          panelClassName="w-max min-w-[230px] max-w-[min(92vw,340px)] p-3 max-h-[60vh] overflow-y-auto scroll-thin"
          trigger={(open) => (
            <Chip open={open}>
              <Settings2 className="h-4 w-4 text-white/55" />
              <span className="composer-setting-value font-medium">{s.aspectRatio}</span>
              <span className="composer-setting-separator text-white/35">·</span>
              <span className="composer-secondary-setting">{s.resolution}</span>
              {s.mode === "video" && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">{s.duration}s</span>
                </>
              )}
              {s.batchCount > 1 && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting text-brand">
                    {s.batchCount}×
                  </span>
                </>
              )}
            </Chip>
          )}
        >
          {() => (
            <div className="space-y-3">
              <Segment
                label="Aspect ratio"
                options={aspectRatiosForModel(s.model, s.mode)}
                value={s.aspectRatio}
                onChange={s.setAspectRatio}
              />
              <Segment
                label="Resolution"
                options={resolutionsForModel(s.model, s.mode)}
                value={s.resolution}
                onChange={s.setResolution}
              />
              {s.mode === "video" && (
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
                <span className="composer-project-label max-w-[110px] truncate font-medium">
                  {proj ? proj.name : "No project"}
                </span>
                <span className="composer-folder-separator text-white/35">/</span>
                <span className="composer-folder-label max-w-[80px] truncate">
                  {folder ? folder.name : "All"}
                </span>
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
                />
              </Chip>
            );
          }}
        >
          {() => {
            const proj = s.projects.find((p) => p.id === s.activeProjectId);
            return (
              <div>
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                  Project
                </p>
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
                    <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                      Folder
                    </p>
                    <MenuItem
                      active={s.activeFolderId === null}
                      onClick={() => s.setActiveFolder(null)}
                    >
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

        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={() => s.generate()}
          disabled={!s.prompt.trim() || s.generating}
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-all duration-200",
            s.prompt.trim() && !s.generating
              ? "bg-gradient-to-br from-brand to-accent text-ink-900 shadow-glow hover:brightness-110"
              : "cursor-not-allowed bg-ink-650 text-white/30"
          )}
          aria-label="Generate"
        >
          {s.generating ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ArrowUp className="h-5 w-5" strokeWidth={2.4} />
          )}
        </motion.button>
      </div>
    </motion.div>
  );
}

function Chip({ open, children }: { open: boolean; children: React.ReactNode }) {
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
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
        {label}
      </p>
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
