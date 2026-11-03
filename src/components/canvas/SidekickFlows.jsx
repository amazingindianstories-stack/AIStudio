"use client";

import { useEffect, useMemo, useState } from "react";
import { Globe, History, Loader2, Play, Plus, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCost } from "@/lib/format-cost";
import { useCanvasStore } from "@/lib/canvas-store";
import { flowSteps, nodeText, planRun } from "@/lib/canvas/flows";
import { addStep, addTemplate, editStep, revertOutput, useFlowRun } from "@/lib/flow-run";
import { fetchFlowTemplates, fetchVersions } from "@/lib/sidekick-api";
import { useSidekick } from "@/lib/sidekick";

const QUOTE_DELAY_MS = 350;

/**
 * Flows: a chain of AI instruction blocks on the board. Arrows into a block bring its inputs; its text is the output.
 * The run shows its price first and only starts when you press Run; unchanged steps are skipped.
 */
export function FlowsTab({ boardId }) {
  const present = useCanvasStore((s) => s.history.present);
  const steps = useMemo(() => flowSteps(present), [present]);
  const ids = useMemo(() => steps.map((step) => step.id), [steps]);
  const quote = useFlowRun((s) => s.quote);
  const running = useFlowRun((s) => s.running);
  const results = useFlowRun((s) => s.results);
  const error = useFlowRun((s) => s.error);
  const [task, setTask] = useState("");
  const [web, setWeb] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [force, setForce] = useState(false);
  const [versionsFor, setVersionsFor] = useState(null);
  const credits = useSidekick((s) => s.credits);
  const signature = useMemo(() => JSON.stringify(steps.map((s) => [s.id, s.flow, nodeText(s)])) + JSON.stringify(present.connectors.map((c) => [c.from.nodeId, c.to.nodeId])), [steps, present.connectors]);

  useEffect(() => {
    fetchFlowTemplates().then(setTemplates).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ids.length || running) return undefined;
    const timer = setTimeout(() => void useFlowRun.getState().estimate(ids, { force }), QUOTE_DELAY_MS);
    return () => clearTimeout(timer);
    // `signature` covers every input the plan reads.
  }, [signature, force, running, ids]);

  const plan = useMemo(() => planRun(present, ids, { force }), [present, ids, force]);
  const staleIds = new Set(plan.steps.filter((p) => !p.skip).map((p) => p.id));
  const exhausted = credits && credits.remainingCents <= 0;
  const toRun = quote && quote.steps.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5 text-xs text-white/70">
      <p className="text-white/50">Select notes on the board, add a step, and the arrows from your selection become its inputs. Each step reads what is connected into it and writes its answer into its own note.</p>

      <form className="mt-2.5 space-y-1.5" onSubmit={(event) => { event.preventDefault(); if (task.trim()) { addStep(task.trim(), { webSearch: web }); setTask(""); } }} aria-label="Add Flow step">
        <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={2} maxLength={4000} aria-label="Step instruction" placeholder="What should this step do with its inputs?" className="w-full resize-none rounded-lg border border-line bg-ink-900/60 px-2.5 py-2 text-sm text-white/90 placeholder:text-white/35" />
        <div className="flex items-center gap-2">
          <button type="button" aria-pressed={web} onClick={() => setWeb(!web)} className={cn("flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/[0.07]", web ? "bg-white/[0.07] text-white" : "text-white/55")}><Globe className="h-3.5 w-3.5" aria-hidden />Search the web</button>
          <button type="submit" disabled={!task.trim()} className="ml-auto flex items-center gap-1 rounded-md bg-ink-600 px-2.5 py-1 font-medium text-white ring-1 ring-line disabled:opacity-40"><Plus className="h-3.5 w-3.5" aria-hidden />Add step</button>
        </div>
      </form>

      {templates.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-white/60">Templates</summary>
          <ul className="mt-1.5 space-y-1">
            {templates.map((template) => (
              <li key={template.id} className="flex items-center gap-2 rounded-lg bg-ink-900/60 px-2.5 py-1.5">
                <div className="min-w-0 flex-1"><p className="truncate font-medium text-white/85">{template.name}</p><p className="truncate text-white/45">{template.description}</p></div>
                <button type="button" aria-label={`Add template ${template.name}`} onClick={() => addTemplate(template)} className="shrink-0 rounded-md px-1.5 py-0.5 text-white/75 hover:bg-white/[0.07]">Add</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <h3 className="mt-3 font-medium text-white/80">Steps on this board</h3>
      {steps.length === 0 ? <p className="mt-1 text-white/45">No Flow steps yet.</p> : (
        <ul className="mt-1.5 space-y-1.5" aria-label="Flow steps">
          {steps.map((step, index) => (
            <li key={step.id} className="rounded-lg bg-ink-900/60 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => useCanvasStore.getState().focusObject(step.id)} className="font-medium text-white/85 hover:underline">Step {index + 1}</button>
                <span className="rounded bg-white/[0.07] px-1 py-0.5 text-[10px] text-white/60">{running?.current === step.id ? "Running" : results[step.id] === "failed" ? "Failed" : !nodeText(step) ? "No output" : staleIds.has(step.id) ? "Out of date" : "Up to date"}</span>
                {step.flow.webSearch && <Globe className="h-3 w-3 text-white/45" aria-label="Web search on" />}
                <button type="button" aria-label={`Versions of step ${index + 1}`} title="Earlier outputs (24 hours)" onClick={() => setVersionsFor(versionsFor === step.id ? null : step.id)} className="ml-auto rounded-md p-1 text-white/50 hover:bg-white/[0.07] hover:text-white"><History className="h-3.5 w-3.5" /></button>
              </div>
              <textarea
                key={`${step.id}-${step.flow.task}`}
                defaultValue={step.flow.task}
                rows={2}
                maxLength={4000}
                aria-label={`Instruction for step ${index + 1}`}
                onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== step.flow.task) editStep(step.id, { task: value }); }}
                className="mt-1 w-full resize-none rounded-md border border-line bg-transparent px-2 py-1 text-white/85"
              />
              <label className="mt-1 flex items-center gap-1.5 text-white/55"><input type="checkbox" checked={step.flow.webSearch === true} onChange={(e) => editStep(step.id, { webSearch: e.target.checked })} />Search the web</label>
              {versionsFor === step.id && <Versions boardId={boardId} nodeId={step.id} />}
            </li>
          ))}
        </ul>
      )}

      {plan.cyclic.length > 0 && <p role="alert" className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-red-300">{plan.cyclic.length} step(s) feed each other in a loop and will not run. Remove one arrow.</p>}
      {error && <p role="alert" className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-red-300">{error}</p>}

      {steps.length > 0 && (
        <div className="sticky bottom-0 mt-3 flex items-center gap-2 rounded-lg border border-line bg-ink-800 px-2.5 py-2">
          <label className="flex items-center gap-1.5 text-white/55"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />Run every step</label>
          <span className="ml-auto text-white/55" data-testid="flow-cost">{running ? `Step ${running.done + 1} of ${running.total}` : exhausted ? "Out of AI credits" : quote ? (toRun ? `${quote.steps.length} to run, ~${formatCost(quote.costCents)}` : "Everything is up to date") : ""}</span>
          {running ? (
            <button type="button" onClick={() => useFlowRun.getState().cancel()} className="flex items-center gap-1 rounded-md px-2.5 py-1 font-medium text-white ring-1 ring-line"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Stop after this step</button>
          ) : (
            <button type="button" disabled={!toRun || exhausted} onClick={() => void useFlowRun.getState().run(ids, { force })} className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 font-medium text-ink-900 disabled:opacity-40"><Play className="h-3.5 w-3.5" aria-hidden />Run</button>
          )}
        </div>
      )}
    </div>
  );
}

function Versions({ boardId, nodeId }) {
  const [versions, setVersions] = useState(null);
  useEffect(() => {
    let live = true;
    fetchVersions(boardId, nodeId).then((items) => live && setVersions(items)).catch(() => live && setVersions([]));
    return () => { live = false; };
  }, [boardId, nodeId]);
  if (!versions) return <p className="mt-1.5 text-white/45">Loading…</p>;
  if (!versions.length) return <p className="mt-1.5 text-white/45">No earlier outputs in the last 24 hours.</p>;
  return (
    <ul aria-label="Earlier outputs" className="mt-1.5 space-y-1">
      {versions.map((version) => (
        <li key={version.id} className="rounded-md bg-ink-800 px-2 py-1.5">
          <p className="line-clamp-3 whitespace-pre-wrap text-white/75">{version.text}</p>
          <div className="mt-1 flex items-center gap-2 text-white/40">
            <span>{new Date(version.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{version.by ? ` by ${version.by}` : ""}</span>
            <button type="button" onClick={() => revertOutput(boardId, nodeId, version.text)} className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-white/75 hover:bg-white/[0.07]"><Undo2 className="h-3 w-3" aria-hidden />Revert</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
