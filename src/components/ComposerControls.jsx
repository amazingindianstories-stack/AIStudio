"use client";
import { capability } from "@/lib/model-registry";

import {
  Plus,
  Settings2,
  ChevronDown,
  Check,
  Box,
  FolderClosed,
  Layers,
  Inbox,
  Volume2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { UNSORTED } from "@/lib/feed-scope";
import { Dropdown, MenuItem } from "./Dropdown";
import {
  aspectRatiosForModel,
  durationsForModel,
  durationRangeForModel,
  resolutionsForModel,
  supportsAudio,
  supportsDraftMode,
  supportsBitrateMode,
  imageQualitiesForModel,
  imageBackgroundsForModel,
  isExperimentalImageSize,
  resolutionLabel,
  IMAGE_QUALITY_LABELS,
  IMAGE_BACKGROUND_LABELS,
  supportsFirstLastFrame,
  supportsVideoEditExtend,
  VIDEO_TASK_MODES,
  pickerModels,
} from "@/lib/config";
import { cn } from "@/lib/utils";
import { askText } from "@/lib/ask-text";

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
export function SettingsToolbar({ destination = true }) {
  const s = useStore();
  const inputDrivenVideo = s.mode === "video" && capability(s.model, "inputDrivenVideo");
  const audioApplies = s.mode === "video" && supportsAudio(s.model) && !inputDrivenVideo;
  const draftApplies = s.mode === "video" && supportsDraftMode(s.model);
  const bitrateApplies = s.mode === "video" && supportsBitrateMode(s.model);
  const editExtendApplies = s.mode === "video" && supportsVideoEditExtend(s.model);
  const firstLastFrameApplies = s.mode === "video" && supportsFirstLastFrame(s.model);
  // A stale draft or an older server row can omit this field. Keep the
  // toolbar render-safe because the edit/extend label is computed before any
  // enqueue validation runs.
  const videoTaskMode = editExtendApplies && typeof s.videoTaskMode === "string" && s.videoTaskMode
    ? s.videoTaskMode
    : "generate";
  // Seedance 2.0/2.5 take any integer duration within a bounded range rather
  // than a fixed enum (see durationRangeForModel) — non-null here switches
  // the Duration control below from Segment buttons to a slider.
  const durationRange = s.mode === "video" ? durationRangeForModel(s.model) : null;
  const resolutionOptions = draftApplies && s.draftMode
    ? ["480p"]
    : resolutionsForModel(s.model, s.mode, s.referenceImages.length > 0);
  const modeModels = pickerModels(s.availableModelIds, s.mode);

  return (
      <div className="composer-toolbar flex min-w-0 flex-wrap items-center gap-1.5 py-px">
        {/* model */}
        <ModelPicker className="composer-model min-w-0 flex-1" models={modeModels} value={s.model} onChange={s.setModel} />

        {/* settings (aspect / resolution / duration / batch / audio) */}
        <Dropdown
          key={`generation-settings-${s.mode}`}
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
                  <span className="composer-setting-value font-medium capitalize text-brand">{videoTaskMode}</span>
                  <span className="composer-setting-separator text-white/35">·</span>
                </>
              )}
              <span className="composer-setting-value font-medium">
                {videoTaskMode === "generate" && !s.firstFrameMode && !s.firstFrame && !s.continuationFrame
                  ? s.aspectRatio
                  : "Adaptive"}
              </span>
              <span className="composer-setting-separator text-white/35">·</span>
              <span className="composer-secondary-setting">{s.resolution}</span>
              {s.mode === "video" && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">{inputDrivenVideo ? "Audio length" : videoTaskMode === "edit" ? "Auto" : `${s.duration}s`}</span>
                </>
              )}
              {firstLastFrameApplies && (s.firstFrameMode || s.firstFrame || s.continuationFrame) && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting font-medium text-brand">1st Frame</span>
                </>
              )}
              {s.batchCount > 1 && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting text-brand">{s.batchCount}×</span>
                </>
              )}
              {audioApplies && s.generateAudio && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <Volume2 className="composer-secondary-setting h-3.5 w-3.5 text-brand" />
                </>
              )}
              {draftApplies && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">{s.draftMode ? "Draft" : "Final"}</span>
                </>
              )}
              {bitrateApplies && (
                <>
                  <span className="composer-secondary-setting text-white/35">·</span>
                  <span className="composer-secondary-setting">{s.bitrateMode === "standard" ? "Low" : "High"}</span>
                </>
              )}
              <ImageOptionsSummary s={s} />
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
                    onChange={(v) => s.setVideoTaskMode(v.toLowerCase() )}
                  />
                  {videoTaskMode !== "generate" && s.referenceVideos.length === 0 && (
                    <p className="mt-1 text-[11px] leading-snug text-amber-400/90">
                      Attach a reference clip above to {videoTaskMode} a video.
                    </p>
                  )}
                </div>
              )}
              {firstLastFrameApplies && videoTaskMode === "generate" && (
                <div>
                  <Segment
                    label="First frame"
                    options={["Off", "On"]}
                    value={s.firstFrameMode || s.firstFrame || s.continuationFrame ? "On" : "Off"}
                    onChange={(v) => s.setFirstFrameMode(v === "On")}
                  />
                  <p className="mt-1 text-[11px] leading-snug text-white/35">
                    Start video from a keyframe with optional last frame interpolation.
                  </p>
                </div>
              )}
              {videoTaskMode === "generate" && !(s.mode === "video" && (s.firstFrame || s.continuationFrame || s.firstFrameMode)) ? (
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
                  <p className="text-xs text-white/50">
                    {s.firstFrame || s.continuationFrame || s.firstFrameMode
                      ? "Adaptive — matches first frame"
                      : "Adaptive — matches the reference clip"}
                  </p>
                </div>
              )}
              <ResolutionSegment
                model={s.model}
                aspectRatio={s.aspectRatio}
                options={resolutionOptions}
                value={s.resolution}
                onChange={s.setResolution}
              />
              <ImageOptionsSettings s={s} />
              {s.mode === "video" && (videoTaskMode === "edit" || inputDrivenVideo) && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Duration
                  </p>
                  <p className="text-xs text-white/50">{inputDrivenVideo ? "Auto - matches the audio" : "Auto - matches the reference clip"}</p>
                </div>
              )}
              {s.mode === "video" && videoTaskMode !== "edit" && !inputDrivenVideo && durationRange && (
                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
                    Duration
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={durationRange.min}
                      max={durationRange.max}
                      step={durationRange.step}
                      value={s.duration}
                      onChange={(e) => s.setDuration(Number(e.target.value))}
                      className="h-1.5 flex-1 cursor-pointer accent-brand"
                      aria-label="Duration"
                    />
                    <span className="w-8 shrink-0 text-right text-xs font-medium tabular-nums text-white/70">
                      {s.duration}s
                    </span>
                  </div>
                </div>
              )}
              {s.mode === "video" && videoTaskMode !== "edit" && !inputDrivenVideo && !durationRange && (
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
              {draftApplies && (
                  <Segment
                    label="Render"
                    options={["Final", "Draft"]}
                    value={s.draftMode ? "Draft" : "Final"}
                    onChange={(v) => s.setDraftMode(v === "Draft")}
                  />
              )}
              {bitrateApplies && (
                  <Segment
                    label="Bitrate"
                    options={["Low", "High"]}
                    value={s.bitrateMode === "standard" ? "Low" : "High"}
                    onChange={(v) => s.setBitrateMode(v === "Low" ? "standard" : "high")}
                  />
              )}
            </div>
          )}
        </Dropdown>

        {destination && <DestinationPicker />}
      </div>
  );
}

function findFolder(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const res = findFolder(n.children, id);
      if (res) return res;
    }
  }
  return null;
}

/** Where new generations land: the active project (or the Global Library) and its active folder, by name. `folder` is
 *  null when the project's unsorted items receive them ("All in project" or Unsorted). */
export function destinationOf(s) {
  const project = s.projects.find((p) => p.id === s.activeProjectId) ?? null;
  const allFolders = [
    ...(s.libraryTree?.globalFolders ?? []),
    ...(project ? (s.libraryTree?.projects?.find((p) => p.id === project.id)?.folders ?? project.folders ?? []) : [])
  ];
  const folder = s.activeFolderId && s.activeFolderId !== UNSORTED ? findFolder(allFolders, s.activeFolderId) : null;
  return { project, folder };
}

/**
 * The destination menu: which project / folder new generations land in. The composer toolbar shows it as a chip;
 * the Agents tab's header passes its own `trigger`.
 */
export function DestinationPicker({ className = "composer-destination shrink-0", side = "top", trigger }) {
  const s = useStore();
  return (
    <Dropdown
      className={className}
      label="Generation destination"
      align="right"
      side={side}
      panelClassName="min-w-[210px]"
      trigger={trigger || ((open) => {
        const { project: proj, folder } = destinationOf(s);
        const folderLabel = s.activeFolderId === UNSORTED ? "Unsorted" : (folder ? folder.name : "All");
        return (
          <Chip open={open}>
            <FolderClosed className="h-4 w-4 text-white/55" />
            <span className="max-w-[110px] truncate font-medium">{proj ? proj.name : "Global Library"}</span>
            <span className="text-white/35">/</span>
            <span className="max-w-[80px] truncate">{folderLabel}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
          </Chip>
        );
      })}
    >
      {() => {
        const proj = s.projects.find((p) => p.id === s.activeProjectId);
        const foldersToDisplay = proj
          ? (s.libraryTree?.projects?.find((p) => p.id === proj.id)?.folders ?? proj.folders ?? [])
          : (s.libraryTree?.globalFolders ?? []);

        const renderFolderMenuItems = (folders, depth = 0) =>
          folders.map((f) => (
            <div key={f.id}>
              <MenuItem
                active={s.activeFolderId === f.id}
                onClick={() => s.setActiveFolder(f.id)}
                style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
              >
                <FolderClosed className="h-4 w-4 text-white/45" />
                <span className="flex-1 truncate">{f.name}</span>
                {s.activeFolderId === f.id && <Check className="h-4 w-4 text-brand" />}
              </MenuItem>
              {f.children?.length > 0 && renderFolderMenuItems(f.children, depth + 1)}
            </div>
          ));

        return (
          <div className="max-h-[340px] overflow-y-auto scroll-thin py-1">
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">Scope</p>
            <MenuItem
              active={s.activeProjectId === null}
              onClick={() => {
                s.setActiveProject(null);
                s.setActiveFolder(null);
              }}
            >
              <Layers className="h-4 w-4 text-white/45" />
              <span className="flex-1 truncate">Global Library</span>
              {s.activeProjectId === null && <Check className="h-4 w-4 text-brand" />}
            </MenuItem>
            {s.projects.map((p) => (
              <MenuItem
                key={p.id}
                active={p.id === s.activeProjectId}
                onClick={() => {
                  s.setActiveProject(p.id);
                  s.setActiveFolder(null);
                }}
              >
                <Layers className="h-4 w-4 text-white/45" />
                <span className="flex-1 truncate">{p.name}</span>
                {p.id === s.activeProjectId && <Check className="h-4 w-4 text-brand" />}
              </MenuItem>
            ))}
            <MenuItem
              onClick={async () => {
                const name = await askText({ title: "New project", label: "Project name", confirmLabel: "Create" });
                if (name) s.createProject(name);
              }}
            >
              <Plus className="h-4 w-4 text-white/60" />
              <span className="flex-1">New project</span>
            </MenuItem>

            <div className="my-1 h-px bg-line" />
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
              Folder in {proj ? proj.name : "Global Library"}
            </p>
            <MenuItem
              active={s.activeFolderId === null}
              onClick={() => s.setActiveFolder(null)}
            >
              <Layers className="h-4 w-4 text-white/45" />
              <span className="flex-1">{proj ? "All in project" : "Global Root"}</span>
              {s.activeFolderId === null && <Check className="h-4 w-4 text-brand" />}
            </MenuItem>
            <MenuItem
              active={s.activeFolderId === UNSORTED}
              onClick={() => s.setActiveFolder(UNSORTED)}
            >
              <Inbox className="h-4 w-4 text-white/45" />
              <span className="flex-1">Unsorted</span>
              {s.activeFolderId === UNSORTED && <Check className="h-4 w-4 text-brand" />}
            </MenuItem>

            {renderFolderMenuItems(foldersToDisplay)}
          </div>
        );
      }}
    </Dropdown>
  );
}

export function Chip({ open, children }) {
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

/**
 * The model menu: every model the picker offers, with its hint and badge. The library composer and the board's
 * Create with AI image controls both render it, so a model reads the same in both.
 */
export function ModelPicker({ models, value, onChange, className, side = "top" }) {
  return (
    <Dropdown
      className={className}
      label={`Model: ${value}`}
      side={side}
      trigger={(open) => (
        <Chip open={open}>
          <Box className="h-4 w-4 text-white/55" />
          <span className="max-w-[14rem] truncate font-medium">{value ?? "No model available"}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </Chip>
      )}
    >
      {(close) =>
        models.map((m) => (
          <MenuItem
            key={m.id}
            active={m.name === value}
            onClick={() => {
              onChange(m.name);
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
            {m.name === value && <Check className="h-4 w-4 text-brand" />}
          </MenuItem>
        ))
      }
    </Dropdown>
  );
}

export function Segment({
  label,
  options,
  value,
  onChange,
  format,
}

) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            aria-pressed={value === opt}
            onClick={() => onChange(opt)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              value === opt
                ? "bg-brand/20 text-brand ring-1 ring-brand/40"
                : "bg-ink-700 text-white/65 ring-1 ring-line hover:text-white"
            )}
          >
            {format ? format(opt) : opt}
          </button>
        ))}
      </div>
    </div>
  );
}

/** GPT Image 2.5 quality and background (config.imageQualitiesForModel); both
 *  composers render these, and they render nothing for any other model. */
function imageOptions(s) {
  return s.mode === "image"
    ? { qualities: imageQualitiesForModel(s.model), backgrounds: imageBackgroundsForModel(s.model) }
    : { qualities: [], backgrounds: [] };
}

export function ImageOptionsSummary({ s }) {
  const { qualities, backgrounds } = imageOptions(s);
  return (
    <>
      {qualities.length > 0 && (
        <>
          <span className="composer-secondary-setting text-white/35">·</span>
          <span className="composer-secondary-setting">{IMAGE_QUALITY_LABELS[s.imageQuality]}</span>
        </>
      )}
      {backgrounds.length > 0 && s.imageBackground === "transparent" && (
        <>
          <span className="composer-secondary-setting text-white/35">·</span>
          <span className="composer-secondary-setting">Transparent</span>
        </>
      )}
    </>
  );
}

export function ImageOptionsSettings({ s }) {
  const { qualities, backgrounds } = imageOptions(s);
  return (
    <>
      {qualities.length > 0 && (
        <div>
          <Segment
            label="Quality"
            options={qualities.map((q) => IMAGE_QUALITY_LABELS[q])}
            value={IMAGE_QUALITY_LABELS[s.imageQuality]}
            onChange={(v) => s.setImageQuality(qualities.find((q) => IMAGE_QUALITY_LABELS[q] === v))}
          />
          <p className="mt-1 text-[11px] leading-snug text-white/35">Higher quality costs more and takes longer.</p>
        </div>
      )}
      {backgrounds.length > 0 && (
        <Segment
          label="Background"
          options={backgrounds.map((b) => IMAGE_BACKGROUND_LABELS[b])}
          value={IMAGE_BACKGROUND_LABELS[s.imageBackground]}
          onChange={(v) => s.setImageBackground(backgrounds.find((b) => IMAGE_BACKGROUND_LABELS[b] === v))}
        />
      )}
    </>
  );
}

/** The Resolution control. GPT Image 2.5 tiers show the exact pixels sent at
 *  this aspect ratio, and a note names those OpenAI calls experimental; every
 *  other model shows its plain resolutions. */
export function ResolutionSegment({ model, aspectRatio, options, value, onChange }) {
  const experimental = options.filter((resolution) => isExperimentalImageSize(model, aspectRatio, resolution));
  return (
    <div>
      <Segment
        label="Resolution"
        options={options}
        value={value}
        onChange={onChange}
        format={(resolution) => resolutionLabel(model, aspectRatio, resolution)}
      />
      {experimental.length > 0 && (
        <p className="mt-1 text-[11px] leading-snug text-white/35">
          {`${experimental.join(" and ")} ${experimental.length > 1 ? "are" : "is"} experimental at OpenAI (above 2560×1440 pixels).`}
        </p>
      )}
    </div>
  );
}
