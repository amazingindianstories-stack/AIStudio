"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { templateApi } from "@/lib/canvas/templates";
import { useStore } from "@/lib/store";

/** Blueprints: a whole project (several boards) from one choice. Custom ones come from an existing project. */
export function BlueprintsTab({ projectId, onMade }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState("");

  const load = () => templateApi.blueprints(projectId).then((r) => setItems(r.blueprints), (e) => setError(e.message));
  useEffect(() => { void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const use = async (item) => {
    setBusy(item.id);
    setError("");
    try {
      const made = await templateApi.useBlueprint(item.id, name || item.name);
      // The new project becomes the open one, and its first board loads.
      await useStore.getState().loadProjects();
      useStore.getState().setActiveProject(made.project.id);
      onMade?.(made);
    }
    catch (failure) { setError(failure.message); }
    setBusy("");
  };
  const saveProject = async () => {
    setBusy("save");
    setError("");
    try {
      await templateApi.createBlueprint({ name: saveName, sourceProjectId: projectId, scope: "project", projectId });
      setSaveName("");
      await load();
    } catch (failure) { setError(failure.message); }
    setBusy("");
  };
  const remove = async (item) => {
    try { await templateApi.removeBlueprint(item.id); await load(); } catch (failure) { setError(failure.message); }
  };

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5" data-testid="blueprints">
      <p className="mb-3 text-xs text-white/55">A blueprint starts a whole project: one board for each step, ready to fill in.</p>
      <label className="mb-4 flex max-w-sm flex-col gap-1 text-xs text-white/60">
        New project name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the blueprint name" maxLength={120}
          className="rounded-lg border border-line bg-ink-700 px-3 py-2 text-sm text-white outline-none focus:border-white/25" />
      </label>
      {error && <p role="alert" className="mb-2 text-xs text-red-300">{error}</p>}
      {items === null ? <Loader2 className="h-5 w-5 animate-spin text-white/40" /> : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 rounded-xl border border-line bg-ink-700 p-4">
              <h3 className="text-sm font-medium text-white">{item.name}</h3>
              <p className="text-xs text-white/55">{item.description}</p>
              <p className="text-[11px] text-white/40">{item.boards.map((board) => board.name).join(" · ")}</p>
              <div className="mt-auto flex gap-2">
                <button type="button" disabled={busy === item.id} onClick={() => use(item)}
                  className="cursor-pointer rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  {busy === item.id ? "Creating…" : "Create project"}
                </button>
                {item.canManage && <button type="button" onClick={() => remove(item)} className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10">Delete</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {projectId && (
        <div className="mt-6 max-w-sm border-t border-line pt-4">
          <h3 className="text-xs font-medium text-white/80">Save this project as a blueprint</h3>
          <div className="mt-2 flex gap-2">
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Blueprint name" aria-label="Blueprint name" maxLength={120}
              className="min-w-0 flex-1 rounded-lg border border-line bg-ink-700 px-3 py-2 text-xs text-white outline-none focus:border-white/25" />
            <button type="button" disabled={!saveName.trim() || busy === "save"} onClick={saveProject}
              className="cursor-pointer rounded-lg bg-ink-600 px-3 py-2 text-xs text-white disabled:opacity-40">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What is used, as counts over the last 30 days and the last year (admins only). */
export function InsightsTab() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { templateApi.usage().then((r) => setRows(r.usage), (e) => setError(e.message)); }, []);
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5" data-testid="template-insights">
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {rows === null && !error ? <Loader2 className="h-5 w-5 animate-spin text-white/40" /> : rows && rows.length === 0 ? (
        <p className="text-xs text-white/45">No template has been used yet.</p>
      ) : rows && (
        <table className="w-full max-w-2xl text-left text-xs text-white/75">
          <thead className="text-white/45"><tr><th className="py-1.5 pr-3 font-normal">Template</th><th className="py-1.5 pr-3 font-normal">Kind</th><th className="py-1.5 pr-3 text-right font-normal">30 days</th><th className="py-1.5 text-right font-normal">Year</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ref} className="border-t border-line"><td className="py-1.5 pr-3">{row.name}</td><td className="py-1.5 pr-3 text-white/45">{row.kind}</td><td className="py-1.5 pr-3 text-right">{row.last30Days}</td><td className="py-1.5 text-right">{row.lastYear}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
