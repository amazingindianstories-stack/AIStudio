"use client";

import { Fragment, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { scopeOptions, templateApi } from "@/lib/canvas/templates";
import { fetchProjectAccess } from "@/lib/board-access";
import { useStore } from "@/lib/store";

const field = "rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-xs text-white outline-none focus:border-white/25";

/**
 * A custom blueprint's details: name, description and who can use it. Projects already made from it stay as they are.
 * Like templates, only an admin shares with everyone and only a project member with the open project; the access is sent only when it changes.
 */
function BlueprintEditor({ item, projectId, member, isAdmin, onSaved, onCancel }) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [scope, setScope] = useState(item.scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scopes = scopeOptions(item, { projectId, member, isAdmin });
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await templateApi.updateBlueprint(item.id, { name, description, ...(scope !== item.scope ? { scope, projectId } : {}) });
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-2" aria-label={`Edit ${item.name}`}>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Blueprint name" className={field} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} aria-label="Blueprint description" placeholder="What it is for" className={field} />
      <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Who can use it" className={field}>
        {scopes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !name.trim()} className="cursor-pointer rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink-950 disabled:opacity-50">Save details</button>
        <button type="button" onClick={onCancel} className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/10">Cancel</button>
      </div>
    </form>
  );
}

/** Blueprints: a whole project (several boards) from one choice. Custom ones come from an existing project, shared with its members. */
export function BlueprintsTab({ projectId, isAdmin, onMade }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState("");
  const [member, setMember] = useState(false);

  const load = () => templateApi.blueprints(projectId).then((r) => setItems(r.blueprints), (e) => setError(e.message));
  useEffect(() => { void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    fetchProjectAccess(projectId).then((access) => !cancelled && setMember(Boolean(access.role)), () => {});
    return () => { cancelled = true; };
  }, [projectId]);

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
    setNote("");
    try {
      const result = await templateApi.createBlueprint({ name: saveName, sourceProjectId: projectId, scope: "project", projectId });
      const kept = result.blueprint.boards.length;
      setNote(result.leftOut
        ? `Blueprint saved with the first ${kept} boards. ${result.leftOut} more ${result.leftOut === 1 ? "board was" : "boards were"} left out: a blueprint holds up to ${kept}.`
        : "Blueprint saved.");
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
              {editing === item.id ? (
                <BlueprintEditor item={item} projectId={projectId} member={member} isAdmin={isAdmin}
                  onSaved={() => { setEditing(null); void load(); }} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <h3 className="text-sm font-medium text-white">{item.name}</h3>
                  <p className="text-xs text-white/55">{item.description}</p>
                  <p className="text-[11px] text-white/40">{item.boards.map((board, index) => <Fragment key={index}>{index > 0 && " · "}<span className="whitespace-nowrap">{board.name}</span></Fragment>)}</p>
                  <div className="mt-auto flex gap-2">
                    <button type="button" disabled={busy === item.id} onClick={() => use(item)}
                      className="cursor-pointer rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink-950 disabled:opacity-50">
                      {busy === item.id ? "Creating…" : "Create project"}
                    </button>
                    {item.canManage && (
                      <>
                        <button type="button" onClick={() => setEditing(item.id)} className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/10">Edit</button>
                        <button type="button" onClick={() => remove(item)} className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10">Delete</button>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {projectId && member && (
        <div className="mt-6 max-w-sm border-t border-line pt-4">
          <h3 className="text-xs font-medium text-white/80">Save this project as a blueprint</h3>
          <div className="mt-2 flex gap-2">
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Blueprint name" aria-label="Blueprint name" maxLength={120}
              className="min-w-0 flex-1 rounded-lg border border-line bg-ink-700 px-3 py-2 text-xs text-white outline-none focus:border-white/25" />
            <button type="button" disabled={!saveName.trim() || busy === "save"} onClick={saveProject}
              className="cursor-pointer rounded-lg bg-ink-600 px-3 py-2 text-xs text-white disabled:opacity-40">Save</button>
          </div>
          {note && <p role="status" className="mt-2 text-xs text-white/60">{note}</p>}
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
