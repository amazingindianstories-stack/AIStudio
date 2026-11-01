"use client";

import { useRef, useState } from "react";
import { ArrowLeft, FileText, Trash2 } from "lucide-react";
import { saveSidekick, deleteSidekick } from "@/lib/sidekick-api";
import { useSidekick } from "@/lib/sidekick";
import { KNOWLEDGE_EXTENSIONS, addKnowledge, estimateTokens, knowledgeFileProblem } from "@/lib/sidekick-knowledge";

const FIELD = "w-full rounded-lg border border-line bg-ink-900/60 px-2.5 py-1.5 text-sm text-white/90 placeholder:text-white/35";

/** Create or edit a custom Sidekick: name, description, instructions, starters, model, knowledge. */
export function SidekickEditor({ sidekick, onDone }) {
  const editing = Boolean(sidekick?.id);
  const [name, setName] = useState(sidekick?.name ?? "");
  const [description, setDescription] = useState(sidekick?.description ?? "");
  const [instructions, setInstructions] = useState(sidekick?.instructions ?? "");
  const [starters, setStarters] = useState((sidekick?.starters ?? []).join("\n"));
  const [processing, setProcessing] = useState(sidekick?.processing ?? "basic");
  // null keeps the files the server holds; an array replaces them (the server does not send file text back).
  const [files, setFiles] = useState(null);
  const [problem, setProblem] = useState(null);
  const [saving, setSaving] = useState(false);
  const input = useRef(null);
  const kept = sidekick?.knowledge ?? [];

  const onFiles = async (event) => {
    const chosen = [...event.target.files];
    event.target.value = "";
    const bad = chosen.map(knowledgeFileProblem).find(Boolean);
    if (bad) return setProblem(bad);
    const read = await Promise.all(chosen.map(async (file) => ({ name: file.name, text: await file.text() })));
    const result = addKnowledge(files ?? [], read);
    if (result.error) return setProblem(result.error);
    setProblem(null);
    setFiles(result.files);
  };

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const body = {
        ...(editing ? { id: sidekick.id } : {}),
        name, description, instructions, processing,
        starters: starters.split("\n").map((line) => line.trim()).filter(Boolean),
        ...(files ? { knowledge: files } : {}),
      };
      const saved = await saveSidekick(body);
      await useSidekick.getState().loadCatalogue();
      useSidekick.getState().chooseSidekick(saved.id);
      onDone();
    } catch (error) {
      setProblem(error.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${sidekick.name}? Chats that used it keep their history.`)) return;
    try {
      await deleteSidekick(sidekick.id);
      await useSidekick.getState().loadCatalogue();
      useSidekick.getState().chooseSidekick("ux-researcher");
      onDone();
    } catch (error) {
      setProblem(error.message);
    }
  };

  const shown = files ?? kept.map((item) => ({ name: item.name, text: "x".repeat(item.chars) }));
  const chars = shown.reduce((sum, item) => sum + item.text.length, 0);

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={editing ? "Edit Sidekick" : "New Sidekick"}>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        <button type="button" onClick={onDone} className="flex items-center gap-1 text-xs text-white/55 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" aria-hidden />Back to chat</button>
        <label className="block text-xs text-white/60">Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className={`${FIELD} mt-1`} />
        </label>
        <label className="block text-xs text-white/60">Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} className={`${FIELD} mt-1`} />
        </label>
        <label className="block text-xs text-white/60">Instructions
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} rows={5} placeholder="How should it behave? What does it know about your project?" className={`${FIELD} mt-1`} />
        </label>
        <label className="block text-xs text-white/60">Conversation starters (one per line, up to 6)
          <textarea value={starters} onChange={(e) => setStarters(e.target.value)} rows={3} className={`${FIELD} mt-1`} />
        </label>
        <div className="flex items-center gap-3 text-xs text-white/60">
          <label className="flex items-center gap-1.5">Model
            <select value={processing} onChange={(e) => setProcessing(e.target.value)} className="rounded-md border border-line bg-ink-900/60 px-1.5 py-1 text-white/80">
              <option value="basic">Basic</option>
              <option value="advanced">Advanced</option>
            </select>
          </label>
        </div>
        <div className="space-y-1.5 text-xs text-white/60">
          <div className="flex items-center justify-between">
            <span>Knowledge ({KNOWLEDGE_EXTENSIONS.join(", ")}; 10 MB each, about 50,000 tokens in all)</span>
            <button type="button" onClick={() => input.current?.click()} className="rounded-md px-1.5 py-0.5 text-white/75 hover:bg-white/[0.07]">{files === null && kept.length ? "Replace files" : "Add files"}</button>
          </div>
          <input ref={input} type="file" multiple accept={KNOWLEDGE_EXTENSIONS.join(",")} className="sr-only" aria-label="Knowledge files" onChange={onFiles} />
          {shown.length > 0 && (
            <ul className="rounded-lg bg-ink-900/60 p-1">
              {shown.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center gap-1.5 px-1.5 py-1"><FileText className="h-3.5 w-3.5 text-white/40" aria-hidden /><span className="min-w-0 flex-1 truncate">{file.name}</span>
                  {files && <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, i) => i !== index))} className="text-white/40 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button>}
                </li>
              ))}
              <li className="px-1.5 py-1 text-white/40">About {estimateTokens(chars).toLocaleString()} tokens</li>
            </ul>
          )}
        </div>
        {problem && <p role="alert" className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">{problem}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        {editing && <button type="button" onClick={() => void remove()} className="rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-500/10">Delete</button>}
        <button type="button" onClick={onDone} className="ml-auto rounded-md px-2.5 py-1 text-xs text-white/70 hover:bg-white/[0.07]">Cancel</button>
        <button type="submit" disabled={saving || !name.trim()} className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white disabled:opacity-40">{saving ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
