"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, History, Image as ImageIcon, LayoutDashboard, Loader2, Mic, Power, Settings2, Sparkles, StickyNote, Workflow, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import {
  DEFAULTS, aspectRatiosForModel, fallbackModel, pickerModels, reconcileGenerationSettings, resolutionsForModel,
} from "@/lib/config";
import { formatCost } from "@/lib/format-cost";
import { ACTIVE_STATUSES, quoteBoardAi, requestFingerprint, trackPanelLayout, useBoardAi } from "@/lib/board-ai";
import { AI_FORMATS, AI_FORMAT_ORDER, STICKY_FILLS } from "@/lib/canvas/ai-formats";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { Chip, ModelPicker, Segment } from "@/components/ComposerControls";
import { useCanvasStore } from "@/lib/canvas-store";
import { setAiInputs, useAiPanelIntent } from "@/lib/board-ai-panel";
import { dictationSupported, startDictation } from "@/lib/canvas/dictation";
import {
  LANGUAGES, SELECTION_ACTIONS, SELECTION_FORMATS, TONES, actionApplies, contextFields, isRecolorRequest, recolorAction, selectionContext, toneAction,
  translateAction,
} from "@/lib/canvas/ai-selection";

const FORMAT_ICONS = { stickies: StickyNote, image: ImageIcon, diagram: Workflow, layout: LayoutDashboard };
const QUOTE_DELAY_MS = 350;
const PROCESSING = [
  { id: "basic", label: "Basic" },
  { id: "advanced", label: "Advanced" },
];

/**
 * The request the panel would submit right now (null while the prompt is empty). An image sends the library
 * generator's settings (model, aspect ratio, resolution), which a refinement pre-fills from the image it edits; the
 * text formats send their Basic or Advanced processing.
 */
export function panelRequest({ format, prompt, processing = "basic", model, aspectRatio, resolution, parentJobId, extra }) {
  const text = prompt.trim();
  if (!text) return null;
  const request = format === "image" ? { format, prompt: text } : { format, prompt: text, processing };
  if (parentJobId) request.parentJobId = parentJobId;
  // The selection: text context, or reference images for a new image. A refinement continues its own result, so it
  // sends none (the server ignores it, and a large selection would be rejected for nothing).
  if (extra && !parentJobId) Object.assign(request, extra);
  if (format === "image") {
    if (model) request.model = model;
    if (aspectRatio) request.aspectRatio = aspectRatio;
    if (resolution) request.resolution = resolution;
  }
  return request;
}

function statusLine(job) {
  if (!job || !ACTIVE_STATUSES.includes(job.status)) return null;
  if (job.heldReason) return job.heldReason;
  if (job.progressMessage) return job.progressMessage;
  return job.status === "queued" ? "Queued - it starts automatically." : "Generating…";
}

/**
 * "Create with AI" (Miro's Create with AI panel): pick a format, write a prompt or pick a suggestion, choose basic or
 * advanced processing (sticky notes and the other text formats) or the library generator's model, aspect ratio,
 * resolution and batch (images), see the estimated cost, run it, and keep refining. It floats above the board toolbar; the
 * result lands on the board near the viewport centre, clear of the panel and in view (a refinement replaces the result
 * it refines, in place, as one undo step). Recent results lists the last day's finished results so any of them can be
 * placed again.
 */
export function CanvasAiPanel({ boardId, leftInset = 0, topInset = 0, onClose }) {
  const job = useBoardAi((s) => s.job);
  const placed = useBoardAi((s) => s.placed);
  const submitting = useBoardAi((s) => s.submitting);
  const jobError = useBoardAi((s) => s.error);
  const submit = useBoardAi((s) => s.submit);
  const startOver = useBoardAi((s) => s.startOver);
  const recent = useBoardAi((s) => s.recent);
  const loadRecent = useBoardAi((s) => s.loadRecent);
  const placeAgain = useBoardAi((s) => s.placeAgain);
  const availableModelIds = useStore((s) => s.availableModelIds);

  const [format, setFormat] = useState("stickies");
  const [prompt, setPrompt] = useState("");
  const [processing, setProcessing] = useState("basic");
  const [showRecent, setShowRecent] = useState(false);
  const [chosenModel, setChosenModel] = useState(null);
  const [imageChoice, setImageChoice] = useState({ aspectRatio: DEFAULTS.image.aspectRatio, resolution: DEFAULTS.image.resolution });
  const [batchCount, setBatchCount] = useState(1);
  const [quote, setQuote] = useState({ state: "idle" });
  const [useSelection, setUseSelection] = useState(true);
  const [action, setAction] = useState(null);
  const [keptFormatFor, setKeptFormatFor] = useState(null);
  const [listening, setListening] = useState(false);
  const stopListening = useRef(null);
  const nodes = useCanvasStore((s) => s.history.present.nodes);
  const selection = useCanvasStore((s) => s.selection);
  const context = useMemo(() => selectionContext(nodes, selection), [nodes, selection]);
  const preset = useAiPanelIntent((s) => s.preset);
  const consumePreset = useAiPanelIntent((s) => s.consume);
  const textareaRef = useRef(null);
  const panelRef = useRef(null);

  // Refining continues the result this panel last placed, in its format.
  const refining = Boolean(placed);
  // A typed request to recolour the selected notes or shapes recolours them, whatever format is picked.
  const recolorKey = `${prompt}\n${(selection ?? []).join(",")}`;
  const typedRecolor = keptFormatFor !== recolorKey && !refining && context.colorable.length > 0 && isRecolorRequest(prompt);
  const activeFormat = refining ? placed.format : typedRecolor ? "recolor" : action ? action.format : format;
  const selectionFormat = SELECTION_FORMATS.includes(activeFormat);
  const extra = useSelection || selectionFormat ? contextFields(activeFormat, context) : null;
  const spec = AI_FORMATS[activeFormat];

  // The image controls are the library generator's: its model menu, aspect ratios and resolutions per model (a
  // reference image, as a refinement always has, can narrow the resolutions), clamped to what the model offers.
  const imageModels = useMemo(() => pickerModels(availableModelIds, "image"), [availableModelIds]);
  const imageActive = activeFormat === "image";
  const hasReference = imageActive && (refining || Boolean(extra?.referenceImages?.length));
  const model = imageActive
    ? (chosenModel && imageModels.some((entry) => entry.name === chosenModel) ? chosenModel : fallbackModel("image", availableModelIds))
    : null;
  const imageSettings = useMemo(
    () => (model ? reconcileGenerationSettings(model, "image", { model, ...imageChoice }, hasReference) : null),
    [model, imageChoice, hasReference]
  );
  const ratios = model ? aspectRatiosForModel(model, "image") : [];
  const resolutions = model ? resolutionsForModel(model, "image", hasReference) : [];
  const ratio = imageSettings?.aspectRatio;
  const resolution = imageSettings?.resolution;
  // A new image can be a batch, like the library's; a refinement is always one job.
  const count = imageActive && !refining ? batchCount : 1;
  const chooseModel = (name) => {
    setChosenModel(name);
    setImageChoice(reconcileGenerationSettings(name, "image", { model, aspectRatio: ratio, resolution }, hasReference));
  };

  const running = Boolean(job && ACTIVE_STATUSES.includes(job.status));
  const request = panelRequest({
    format: activeFormat, prompt, processing, model, aspectRatio: ratio, resolution, parentJobId: refining ? placed.jobId : null, extra,
  });
  const fingerprint = request && boardId ? requestFingerprint(boardId, request) : null;

  // A refinement starts from the image it edits: its model, aspect ratio and resolution fill the controls, and the
  // person can change any of them.
  const refinedJobId = placed?.format === "image" ? placed.jobId : null;
  useEffect(() => {
    if (!refinedJobId) return;
    const refined = imageModels.find((entry) => entry.name === placed.model)?.name ?? fallbackModel("image", availableModelIds);
    if (!refined) return;
    setChosenModel(refined);
    setImageChoice(reconcileGenerationSettings(refined, "image",
      { model: refined, aspectRatio: placed.aspectRatio ?? DEFAULTS.image.aspectRatio, resolution: placed.resolution ?? DEFAULTS.image.resolution }, true));
    // The refined image's settings fill the controls once per refinement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refinedJobId]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [refining, activeFormat]);

  // A one-click action (context menu): fill the prompt; the person still presses Generate.
  useEffect(() => {
    if (!preset) return;
    // A menu action starts a new request, so it leaves any result being refined behind.
    if (placed) startOver();
    setAction(preset.format ? preset : null);
    setPrompt(preset.prompt ?? "");
    consumePreset();
  }, [preset, placed, consumePreset, startOver]);
  useEffect(() => () => stopListening.current?.(), []);

  const pickAction = (next) => {
    setAction(next);
    setPrompt(next.prompt);
    textareaRef.current?.focus();
  };
  const toggleDictation = () => {
    if (listening) {
      stopListening.current?.();
      return;
    }
    const base = prompt.trim() ? `${prompt.trim()} ` : "";
    setListening(true);
    stopListening.current = startDictation({
      lang: typeof navigator === "undefined" ? undefined : navigator.language,
      onText: (text) => setPrompt(`${base}${text}`.slice(0, 4000)),
      onEnd: () => {
        stopListening.current = null;
        setListening(false);
      },
    });
  };

  // Placement keeps results in view: report this panel's rect and the canvas left visible beside the asset panel
  // (`leftInset` wide) and below the board's top chips (`topInset` tall), relative to the canvas, which shares the
  // panel's positioned parent.
  useEffect(() => trackPanelLayout(() => {
    const panel = panelRef.current;
    const canvas = panel?.offsetParent;
    if (!panel || !canvas) return null;
    const rect = panel.getBoundingClientRect();
    const origin = canvas.getBoundingClientRect();
    return {
      panel: { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height },
      visible: { x: leftInset, y: topInset, w: Math.max(origin.width - leftInset, 0), h: Math.max(origin.height - topInset, 0) },
    };
  }), [leftInset, topInset]);

  // Reload when board AI attaches a board (after the board loads, not when the prop changes), since attaching
  // clears the list.
  const attachedBoardId = useBoardAi((s) => s.boardId);
  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    void loadRecent();
  }, [attachedBoardId, jobId, jobStatus, loadRecent]);

  useEffect(() => {
    if (!request || !boardId) {
      setQuote({ state: "idle" });
      return undefined;
    }
    const controller = new AbortController();
    setQuote((current) => (current.fingerprint === fingerprint ? current : { state: "loading", fingerprint }));
    const timer = setTimeout(() => {
      quoteBoardAi(boardId, request, { signal: controller.signal })
        .then((value) => setQuote({ state: "ready", fingerprint, costCents: value.costCents, model: value.model }))
        .catch((error) => {
          if (error?.name !== "AbortError") setQuote({ state: "error", fingerprint, message: error?.message || "Cost estimate unavailable." });
        });
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `request` is fully described by `fingerprint`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, boardId]);

  const quoted = quote.state === "ready" && quote.fingerprint === fingerprint;
  const canRun = Boolean(request) && quoted && !submitting && !running;

  const run = async () => {
    if (!canRun) return;
    stopListening.current?.();
    const created = await submit(request, count);
    if (created.length) {
      setPrompt("");
      setAction(null);
      setKeptFormatFor(null);
    }
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void run();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const status = statusLine(job);
  const FormatIcon = FORMAT_ICONS[activeFormat] ?? Sparkles;

  return (
    <section
      ref={panelRef}
      aria-label="Create with AI"
      className="absolute bottom-[72px] left-1/2 z-[45] w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border border-line bg-ink-750/95 p-3 shadow-pop backdrop-blur-xl"
    >
      <header className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand" aria-hidden />
        <h2 className="whitespace-nowrap text-sm font-semibold text-white/90">Create with AI</h2>
        <button
          type="button"
          aria-label="Turn AI off"
          title="Turn AI inputs off (hides the sparkle button and the AI menu rows)"
          onClick={() => {
            setAiInputs(false);
            onClose();
          }}
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-white/50 transition-colors hover:bg-white/[0.07] hover:text-white"
        >
          <Power className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Recent results"
          aria-expanded={showRecent}
          title="Recent results"
          onClick={() => setShowRecent((value) => !value)}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-white/[0.07] hover:text-white",
            showRecent ? "bg-white/[0.07] text-white" : "text-white/50"
          )}
        >
          <History className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Close Create with AI"
          title="Close (Esc)"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-md text-white/50 transition-colors hover:bg-white/[0.07] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {!refining && (
      <div role="radiogroup" aria-label="Format" className="mt-2 flex w-fit items-center gap-1 rounded-lg bg-ink-900/60 p-0.5">
        {AI_FORMAT_ORDER.map((id) => {
          const Icon = FORMAT_ICONS[id];
          const selected = !action && !typedRecolor && id === format;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setFormat(id);
                setAction(null);
                if (typedRecolor) setKeptFormatFor(recolorKey);
              }}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                selected ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:bg-white/[0.07] hover:text-white"
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {AI_FORMATS[id].label}
            </button>
          );
        })}
      </div>
    )}

      {showRecent && (
        <ul aria-label="Recent results" className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-ink-900/60 p-1">
          {recent.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-white/45">No finished results in the last 24 hours.</li>
          ) : recent.map((item) => {
            const Icon = FORMAT_ICONS[item.format] ?? Sparkles;
            return (
              <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-white/70">
                <Icon className="h-3.5 w-3.5 shrink-0 text-white/45" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={item.prompt}>{item.prompt}</span>
                <button
                  type="button"
                  aria-label={`Place again: ${item.prompt}`}
                  onClick={() => void placeAgain(item)}
                  className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white"
                >
                  Place again
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {refining && (
        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-ink-900/60 px-2.5 py-1.5 text-xs text-white/65">
          <FormatIcon className="h-3.5 w-3.5 shrink-0 text-white/45" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            Refining {spec.resultLabel(placed.result)}: <span className="text-white/80">{placed.prompt}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              startOver();
              setPrompt("");
            }}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white"
          >
            New prompt
          </button>
        </div>
      )}

      {!refining && context.count > 0 && (
        <SelectionStrip
          context={context}
          nodes={nodes}
          action={action}
          recoloring={typedRecolor && action?.format !== "recolor"}
          onKeepFormat={() => setKeptFormatFor(recolorKey)}
          useSelection={useSelection}
          onUseSelection={setUseSelection}
          onPick={pickAction}
          onClear={() => setAction(null)}
          showContextToggle={!selectionFormat && (activeFormat === "image" ? context.images.length > 0 : context.items.length > 0)}
        />
      )}

      <div className="relative mt-2">
      <textarea
        ref={textareaRef}
        aria-label={refining ? "Refinement" : "Prompt"}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        maxLength={4000}
        placeholder={refining ? spec.refinePlaceholder : spec.placeholder}
        className="block max-h-40 min-h-[56px] w-full resize-y rounded-xl border border-line bg-ink-900/70 py-2 pl-3 pr-9 text-sm text-white/90 placeholder:text-white/35 focus:border-lineStrong focus:outline-none"
      />
      {dictationSupported() && (
        <button
          type="button"
          aria-label={listening ? "Stop dictation" : "Dictate the prompt"}
          aria-pressed={listening}
          title={listening ? "Stop dictation" : "Dictate the prompt"}
          onClick={toggleDictation}
          className={cn(
            "absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-white/[0.07]",
            listening ? "text-red-300" : "text-white/50 hover:text-white"
          )}
        >
          <Mic className={cn("h-4 w-4", listening && "animate-pulse")} />
        </button>
      )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {imageActive ? (
          <>
            <ModelPicker className="min-w-0 max-w-full" models={imageModels} value={model} onChange={chooseModel} />
            <Dropdown
              label="Generation settings"
              side="top"
              panelClassName="w-max min-w-[230px] max-w-[min(92vw,340px)] p-3 max-h-[60vh] overflow-y-auto scroll-thin"
              trigger={(open) => (
                <Chip open={open}>
                  <Settings2 className="h-4 w-4 text-white/55" />
                  <span className="font-medium">{ratio}</span>
                  <span className="text-white/35">·</span>
                  <span>{resolution}</span>
                  {count > 1 && (
                    <>
                      <span className="text-white/35">·</span>
                      <span className="text-brand">{count}×</span>
                    </>
                  )}
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
                </Chip>
              )}
            >
              {() => (
                <div className="space-y-3">
                  <Segment
                    label="Aspect ratio"
                    options={ratios}
                    value={ratio}
                    onChange={(value) => setImageChoice((current) => ({ ...current, aspectRatio: value }))}
                  />
                  <Segment
                    label="Resolution"
                    options={resolutions}
                    value={resolution}
                    onChange={(value) => setImageChoice((current) => ({ ...current, resolution: value }))}
                  />
                  {!refining && (
                    <Segment
                      label="Batch (per generate)"
                      options={["1×", "2×"]}
                      value={`${batchCount}×`}
                      onChange={(value) => setBatchCount(parseInt(value))}
                    />
                  )}
                </div>
              )}
            </Dropdown>
          </>
        ) : (
          <div role="radiogroup" aria-label="Processing" className="flex items-center gap-1 rounded-lg bg-ink-900/60 p-0.5">
            {PROCESSING.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.id === processing}
                title={option.id === "advanced" ? spec.advancedHint : "Standard model and settings"}
                onClick={() => setProcessing(option.id)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  option.id === processing ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:bg-white/[0.07] hover:text-white"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!refining && !prompt.trim() && !selectionFormat && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Suggestions">
          {spec.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => {
                setPrompt(suggestion);
                textareaRef.current?.focus();
              }}
              className="max-w-full truncate rounded-full border border-line px-2.5 py-1 text-xs text-white/60 transition-colors hover:border-lineStrong hover:text-white/85"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <footer className="mt-3 flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1 text-xs" aria-live="polite">
          {jobError ? (
            <span role="alert" className="block truncate text-red-300/90" title={jobError}>{jobError}</span>
          ) : running ? (
            <span className="flex min-w-0 items-center gap-1.5 text-white/70">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              <span className="truncate">{status}</span>
            </span>
          ) : !request ? (
            <span className="text-white/40">Enter to run · Shift+Enter for a new line</span>
          ) : quote.state === "ready" && quoted ? (
            <span className="text-white/60">Estimated cost <span className="font-medium text-white/85">≈{formatCost(quote.costCents * count)}</span>{count > 1 ? <span className="text-white/40"> · {count} images</span> : null}{quote.model ? <span className="text-white/40" title="Model"> · {quote.model}</span> : null}</span>
          ) : quote.state === "error" && quote.fingerprint === fingerprint ? (
            <span className="block truncate text-amber-200/85" title={quote.message}>{quote.message}</span>
          ) : (
            <span className="text-white/45">Estimating cost…</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={!canRun}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-ink-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
          {refining ? "Refine" : "Generate"}
        </button>
      </footer>
    </section>
  );
}

function ActionMenu({ label, items, onPick }) {
  return (
    <Dropdown
      side="top"
      label={label}
      trigger={(open) => (
        <span className={cn("flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-white/65 transition-colors hover:border-lineStrong hover:text-white/85", open && "bg-white/[0.07]")}>
          {label}
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        </span>
      )}
    >
      {(close) => items.map((item) => (
        <MenuItem key={item.id} onClick={() => { onPick(item); close(); }}>
          <span className="flex-1">{item.label}</span>
        </MenuItem>
      ))}
    </Dropdown>
  );
}

/** What the selection offers: use it as context, or run a one-click action on it (nothing runs until Generate). */
function SelectionStrip({ context, nodes, action, recoloring, onKeepFormat, useSelection, onUseSelection, onPick, onClear, showContextToggle }) {
  const applies = (item) => actionApplies(item, context, nodes);
  const presets = SELECTION_ACTIONS.filter(applies);
  const tones = TONES.map((tone) => ({ ...toneAction(tone), label: tone }));
  const languages = LANGUAGES.map((language) => ({ ...translateAction(language), label: language }));
  const colors = Object.keys(STICKY_FILLS).map((name) => ({ ...recolorAction(name), label: name[0].toUpperCase() + name.slice(1) }));
  const text = context.items.length > 0;
  return (
    <div aria-label="Selection" className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-white/45">{context.count} selected</span>
      {showContextToggle && (
        <label className="flex cursor-pointer items-center gap-1.5 text-white/65">
          <input type="checkbox" checked={useSelection} onChange={(event) => onUseSelection(event.target.checked)} />
          Use selection as context
        </label>
      )}
      {action && !recoloring && (
        <button type="button" onClick={onClear} className="rounded-full bg-ink-600 px-2.5 py-1 font-medium text-white ring-1 ring-line" title="Clear this action">
          {action.label ?? action.prompt} <X className="inline h-3 w-3" aria-hidden />
        </button>
      )}
      {recoloring && (
        <button type="button" onClick={onKeepFormat} aria-label="Change colour: keep the picked format instead" title="Keep the picked format instead"
          className="rounded-full bg-ink-600 px-2.5 py-1 font-medium text-white ring-1 ring-line">
          Change colour <X className="inline h-3 w-3" aria-hidden />
        </button>
      )}
      {presets.filter((item) => item.id !== action?.id).map((item) => (
        <button key={item.id} type="button" onClick={() => onPick(item)} className="rounded-full border border-line px-2.5 py-1 text-white/60 transition-colors hover:border-lineStrong hover:text-white/85">
          {item.label}
        </button>
      ))}
      {applies(colors[0]) && <ActionMenu label="Change colour" items={colors} onPick={onPick} />}
      {text && <ActionMenu label="Change tone" items={tones} onPick={onPick} />}
      {text && <ActionMenu label="Translate" items={languages} onPick={onPick} />}
    </div>
  );
}
