"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, History, Image as ImageIcon, Loader2, Sparkles, StickyNote, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { fallbackModel, pickerModels } from "@/lib/config";
import { capability } from "@/lib/model-registry";
import { formatCost } from "@/lib/format-cost";
import { ACTIVE_STATUSES, quoteBoardAi, requestFingerprint, useBoardAi } from "@/lib/board-ai";
import { AI_FORMATS, AI_FORMAT_ORDER } from "@/lib/canvas/ai-formats";
import { Dropdown, MenuItem } from "@/components/Dropdown";

const FORMAT_ICONS = { stickies: StickyNote, image: ImageIcon };
const BOARD_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const QUOTE_DELAY_MS = 350;
const PROCESSING = [
  { id: "basic", label: "Basic" },
  { id: "advanced", label: "Advanced" },
];

/** The request the panel would submit right now (null while the prompt is empty). */
export function panelRequest({ format, prompt, processing = "basic", model, aspectRatio, parentJobId }) {
  const text = prompt.trim();
  if (!text) return null;
  const request = { format, prompt: text, processing };
  if (parentJobId) request.parentJobId = parentJobId;
  // A refinement keeps the image's own model and aspect ratio (it edits that image).
  if (format === "image" && !parentJobId) {
    if (model) request.model = model;
    if (aspectRatio) request.aspectRatio = aspectRatio;
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
 * advanced processing, see the estimated cost, run it, and keep refining. It floats above the board toolbar; the
 * result lands on the board near the viewport centre (a refinement replaces the result it refines, in place, as one
 * undo step). Recent results lists the last day's finished results so any of them can be placed again.
 */
export function CanvasAiPanel({ boardId, onClose }) {
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
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [chosenModel, setChosenModel] = useState(null);
  const [quote, setQuote] = useState({ state: "idle" });
  const textareaRef = useRef(null);

  const imageModels = useMemo(() => pickerModels(availableModelIds, "image"), [availableModelIds]);
  const model = format === "image"
    ? (chosenModel && imageModels.some((entry) => entry.name === chosenModel) ? chosenModel : fallbackModel("image", availableModelIds))
    : null;
  const ratios = useMemo(() => {
    const supported = model ? capability(model, "aspectRatios", null) : null;
    return Array.isArray(supported) ? BOARD_RATIOS.filter((ratio) => supported.includes(ratio)) : BOARD_RATIOS;
  }, [model]);
  const ratio = ratios.includes(aspectRatio) ? aspectRatio : ratios[0] ?? "1:1";

  // Refining continues the result this panel last placed, in its format.
  const refining = Boolean(placed);
  const activeFormat = refining ? placed.format : format;
  const spec = AI_FORMATS[activeFormat];
  const running = Boolean(job && ACTIVE_STATUSES.includes(job.status));
  const request = panelRequest({ format: activeFormat, prompt, processing, model, aspectRatio: ratio, parentJobId: refining ? placed.jobId : null });
  const fingerprint = request && boardId ? requestFingerprint(boardId, request) : null;

  useEffect(() => {
    textareaRef.current?.focus();
  }, [refining, activeFormat]);

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
        .then((value) => setQuote({ state: "ready", fingerprint, costCents: value.costCents }))
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
    const created = await submit(request);
    if (created) setPrompt("");
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
      aria-label="Create with AI"
      className="absolute bottom-[72px] left-1/2 z-[45] w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border border-line bg-ink-750/95 p-3 shadow-pop backdrop-blur-xl"
    >
      <header className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand" aria-hidden />
        <h2 className="text-sm font-semibold text-white/90">Create with AI</h2>
        {!refining && (
          <div role="radiogroup" aria-label="Format" className="ml-2 flex items-center gap-1 rounded-lg bg-ink-900/60 p-0.5">
            {AI_FORMAT_ORDER.map((id) => {
              const Icon = FORMAT_ICONS[id];
              const selected = id === format;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setFormat(id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
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
        <button
          type="button"
          aria-label="Recent results"
          aria-expanded={showRecent}
          title="Recent results"
          onClick={() => setShowRecent((value) => !value)}
          className={cn(
            "ml-auto grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-white/[0.07] hover:text-white",
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

      <textarea
        ref={textareaRef}
        aria-label={refining ? "Refinement" : "Prompt"}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        maxLength={4000}
        placeholder={refining ? spec.refinePlaceholder : spec.placeholder}
        className="mt-2 block max-h-40 min-h-[56px] w-full resize-y rounded-xl border border-line bg-ink-900/70 px-3 py-2 text-sm text-white/90 placeholder:text-white/35 focus:border-lineStrong focus:outline-none"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
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
        {activeFormat === "image" && !refining && (
          <>
            <Dropdown
              side="top"
              label="Image model"
              trigger={(open) => (
                <span
                  className={cn(
                    "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-white/75 transition-colors hover:bg-white/[0.07]",
                    open && "bg-white/[0.07]"
                  )}
                >
                  {model ?? "No image model available"}
                  <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
                </span>
              )}
            >
              {(close) => imageModels.map((entry) => (
                <MenuItem
                  key={entry.id}
                  active={entry.name === model}
                  onClick={() => {
                    setChosenModel(entry.name);
                    close();
                  }}
                >
                  <span className="flex-1">{entry.name}</span>
                </MenuItem>
              ))}
            </Dropdown>
            <div role="radiogroup" aria-label="Aspect ratio" className="flex items-center gap-1">
              {ratios.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={value === ratio}
                  onClick={() => setAspectRatio(value)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs tabular-nums transition-colors",
                    value === ratio ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:bg-white/[0.07] hover:text-white"
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {!refining && !prompt.trim() && (
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
          {running ? (
            <span className="flex min-w-0 items-center gap-1.5 text-white/70">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              <span className="truncate">{status}</span>
            </span>
          ) : jobError ? (
            <span role="alert" className="block truncate text-red-300/90" title={jobError}>{jobError}</span>
          ) : !request ? (
            <span className="text-white/40">Enter to run · Shift+Enter for a new line</span>
          ) : quote.state === "ready" && quoted ? (
            <span className="text-white/60">Estimated cost <span className="font-medium text-white/85">≈{formatCost(quote.costCents)}</span></span>
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
