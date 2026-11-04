"use client";
import { useEffect, useState } from "react";
import { AlertCircle, Ban, Check, Clock, Loader2, PauseCircle, Wrench, X } from "lucide-react";
import {
  needsSecondConfirmation, outcomeText, pauseReasonText, quoteCardStep, quoteCost, quoteDetails, resumeText, sentenceCase, statusLine, stepStatusText,
} from "@/lib/agent-run";
import { MediaCard } from "./MediaCard";
import { GenerationStatus } from "./GenerationStatus";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";

const BUBBLE = "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed";

function toolLabel(tool) {
  return sentenceCase(tool || "tool");
}

function StepIcon({ status }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />;
  if (status === "done") return <Check className="h-3.5 w-3.5 text-emerald-300" />;
  if (status === "error") return <AlertCircle className="h-3.5 w-3.5 text-red-300" />;
  if (status === "declined") return <Ban className="h-3.5 w-3.5 text-white/40" />;
  return <Clock className="h-3.5 w-3.5 text-amber-200" />;
}

/** A finished job's card. A succeeded generation outside every loaded scope (an earlier run, a reload) is read by id. */
function JobResult({ job, item }) {
  const loadItem = useStore((s) => s.loadItem);
  const [unread, setUnread] = useState(null);
  const wanted = job.status === "succeeded" && !item ? job.generationId : null;
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    loadItem(wanted).then((found) => {
      if (live && !found) setUnread(wanted);
    });
    return () => {
      live = false;
    };
  }, [wanted, loadItem]);
  if (item) return <div className="w-56"><MediaCard item={item} /></div>;
  const noun = job.kind === "video" ? "video" : job.kind === "image" ? "image" : "job";
  if (job.status === "queued" || job.status === "running") {
    return <div className="w-56"><GenerationStatus status={job.status === "queued" ? "queued" : "running"} compact className="rounded-lg ring-1 ring-line" /></div>;
  }
  const text = job.status === "succeeded" ? (unread === wanted ? `The ${noun} is ready. Check your library to view it.` : `Loading the ${noun}…`)
    : job.status === "cancelled" ? `The ${noun} was cancelled.` : `The ${noun} failed.`;
  return <div className="rounded-lg bg-ink-750 px-2.5 py-2 text-xs text-white/50">{text}</div>;
}

function ToolStep({ step, jobs, findItem }) {
  const quote = step.quote;
  const status = stepStatusText(step);
  return (
    <div data-testid="agent-run-step" data-status={step.status} className="flex max-w-[85%] flex-col gap-1.5">
      <div className="flex items-start gap-2 rounded-lg border border-line bg-ink-800/70 px-2.5 py-1.5 text-xs text-white/70">
        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium text-white/85">
            <span className="break-words">{toolLabel(step.tool)}</span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap font-normal text-white/50"><StepIcon status={step.status} /> {status}</span>
          </p>
          {step.summary && <p className="mt-0.5 break-words text-white/55">{step.summary}</p>}
          {quote?.state === "approved" && <p className="mt-0.5 text-emerald-200/80">Approved {quoteCost(quote)}.</p>}
          {quote?.state === "declined" && <p className="mt-0.5 text-white/50">Declined{quote.reason && quote.reason !== "declined" ? ` (${quote.reason.replace(/_/g, " ")})` : ""}.</p>}
        </div>
      </div>
      {jobs.map((job) => <JobResult key={job.generationId} job={job} item={findItem(job.generationId)} />)}
    </div>
  );
}

/** The quote waiting for approval. Approving is a click, and at $1.00 or more a second, explicit confirmation. */
function QuoteCard({ quote, onDecide }) {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);
  useEffect(() => {
    setPhase("idle");
    setError(null);
  }, [quote.stepIndex, quote.seq]);
  const cost = quoteCost(quote);
  const decide = async (action) => {
    const next = action === "approve" ? quoteCardStep(phase, "approve", quote.costCents) : "sending";
    setPhase(next);
    if (next !== "sending") return;
    setError(null);
    const result = await onDecide(action, quote.stepIndex);
    if (!result.ok) {
      setError(result.error);
      setPhase("idle");
    }
  };
  const details = quoteDetails(quote.arguments);
  return (
    <section aria-label="Quote waiting for approval" className="flex max-w-[85%] flex-col gap-2 rounded-xl border border-amber-300/30 bg-amber-300/5 px-3 py-2.5 text-xs text-white/75">
      <p className="text-sm font-medium text-white">{toolLabel(quote.tool)} costs {cost}</p>
      {quote.summary && <p>{quote.summary}</p>}
      {quote.prompt && <p className="whitespace-pre-wrap break-words rounded-lg bg-ink-800/80 px-2 py-1.5 text-white/80">{quote.prompt}</p>}
      {details.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-white/60">
          {details.map(({ key, label, value }) => (
            <div key={key} className="contents"><dt>{label}</dt><dd className="truncate text-white/80">{value}</dd></div>
          ))}
        </dl>
      )}
      {phase === "confirming" && <p role="status" className="text-amber-100">This costs {cost}. Confirm to spend it.</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {phase === "confirming" ? (
          <>
            <button type="button" onClick={() => decide("approve")} className="rounded-full bg-brand/25 px-3 py-1 font-medium text-brand ring-1 ring-brand/50 transition hover:bg-brand/35">
              Confirm {cost}
            </button>
            <button type="button" onClick={() => setPhase(quoteCardStep(phase, "back", quote.costCents))} className="rounded-full border border-line px-3 py-1 font-medium text-white/70 transition hover:text-white">
              Back
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={phase === "sending"} onClick={() => decide("approve")} className="rounded-full bg-brand/20 px-3 py-1 font-medium text-brand ring-1 ring-brand/40 transition hover:bg-brand/30 disabled:opacity-50">
              {needsSecondConfirmation(quote.costCents) ? `Approve ${cost}…` : `Approve ${cost}`}
            </button>
            <button type="button" disabled={phase === "sending"} onClick={() => decide("decline")} className="rounded-full border border-line px-3 py-1 font-medium text-white/70 transition hover:text-white disabled:opacity-50">
              Decline
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function StatusLine({ view, onStop }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(null);
  const { label, icon } = statusLine(view);
  const Icon = icon === "pause" ? PauseCircle : icon === "clock" ? Clock : Loader2;
  const stop = async (cancelJobs) => {
    setStopping(true);
    setError(null);
    const result = await onStop(cancelJobs);
    if (!result.ok && result.code !== "RUN_FINISHED") setError(result.error);
    setStopping(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
      <span role="status" data-testid="agent-run-status" data-icon={icon} className="flex items-center gap-1.5">
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", icon === "spin" && "animate-spin")} /> {label}
      </span>
      {!view.stopping && (
        <>
          <button type="button" disabled={stopping} onClick={() => stop(false)} className="rounded-full border border-line px-2.5 py-0.5 text-white/70 transition hover:text-white disabled:opacity-50">
            Stop
          </button>
          <button type="button" disabled={stopping} onClick={() => stop(true)} className="rounded-full border border-red-400/30 px-2.5 py-0.5 text-red-200/80 transition hover:text-red-100 disabled:opacity-50">
            Stop and cancel jobs
          </button>
        </>
      )}
      {error && <span role="alert" className="text-red-300">{error}</span>}
    </div>
  );
}

/**
 * One segment of an agent run in the thread (see threadEntries): `items` are its model text, tool steps with the jobs
 * they queued, and messages it read that the saved thread does not hold yet. The `last` segment also renders the run's
 * state: queued messages (until the thread is re-read, `synced`), the quote, pause and outcome cards, and Stop.
 */
export function AgentRunPanel({ view, items, last, synced, findItem, onDecide, onStop, pollError }) {
  const jobsByStep = {};
  for (const job of view.jobs) (jobsByStep[job.stepIndex] ??= []).push(job);
  const failed = view.outcome?.status === "failed";
  const ended = last && view.outcome && view.outcome.status !== "completed";
  const queued = last && !synced ? view.queued : [];
  const quote = last ? view.quote : null;
  const paused = last ? view.paused : null;
  // A segment with nothing to add (a finished run whose reply is all in the saved thread) would still take a gap.
  if (!items.length && !queued.length && !quote && !paused && !(last && view.active) && !ended && !pollError) return null;
  return (
    <div data-testid="agent-run" data-run-id={view.runId} data-run-status={view.status} className="flex flex-col gap-3">
      {items.map((item) => {
        if (item.type === "tool") return <ToolStep key={`step-${item.stepIndex}`} step={item} jobs={jobsByStep[item.stepIndex] || []} findItem={findItem} />;
        if (item.type === "message") {
          return <div key={`message-${item.inboxId}`} className="flex flex-col items-end"><div className={cn(BUBBLE, "bg-brand/15 text-white")}>{item.content}</div></div>;
        }
        return (
          <div key={`text-${item.seq}`} className="flex flex-col items-start">
            <div className={cn(BUBBLE, "bg-white/6", item.final ? "text-white/85" : "text-white/65")}>{item.text}</div>
          </div>
        );
      })}
      {queued.map((row) => (
        <div key={`queued-${row.id}`} data-testid="agent-queued-message" className="flex flex-col items-end gap-1">
          <div className={cn(BUBBLE, "border border-dashed border-brand/40 bg-transparent text-white/70")}>{row.content}</div>
          <span className="flex items-center gap-1 text-[11px] text-white/40"><Clock className="h-3 w-3" /> Queued. The agent reads it after its current step.</span>
        </div>
      ))}
      {quote && <QuoteCard quote={quote} onDecide={onDecide} />}
      {paused && (
        <section aria-label="Run paused" className="flex max-w-[85%] items-start gap-2 rounded-xl border border-line bg-ink-800/80 px-3 py-2.5 text-xs text-white/70">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
          <div>
            <p className="text-sm font-medium text-white">{pauseReasonText(paused.reason)}</p>
            <p>{resumeText(paused.resumeAfter)}</p>
          </div>
        </section>
      )}
      {last && view.active && <StatusLine view={view} onStop={onStop} />}
      {ended && (
        <section aria-label={failed ? "Run failed" : "Run stopped"} className={cn(
          "flex max-w-[85%] items-start gap-2 rounded-xl border px-3 py-2.5 text-xs",
          failed ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-line bg-ink-800/80 text-white/70"
        )}>
          {failed ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
          <p>{outcomeText(view.outcome)}</p>
        </section>
      )}
      {pollError && <p role="alert" className="text-xs text-red-300">{pollError}</p>}
    </div>
  );
}
