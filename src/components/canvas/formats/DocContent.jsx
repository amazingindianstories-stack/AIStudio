"use client";

import { useRef, useState } from "react";
import { RichTextContent, RichTextEditor } from "../nodes/RichText";
import { usePeople } from "@/lib/canvas/use-people";
import { validateMarks } from "@/lib/canvas/rich-text";
import { useStore } from "@/lib/store";
import { useCanvasStore } from "@/lib/canvas-store";
import { patchFormat, openFormat } from "@/lib/canvas/formats/actions";
import { FormatNode } from "./FormatNode";
import { FramePreview } from "./FramePreview";
import { acceptSuggestion, addSuggestion, addTableRow, addTableColumn, applyBlockShortcut, dateChip, formatChipDate, insertBlockAfter, listNumbers, moveBlock, newBlock, parseChips, rejectSuggestion, removeBlock, setTableCell, updateBlock, userChip } from "@/lib/canvas/formats/model";

export function ChipText({ text = "", marks, openLinks = false }) {
  return parseChips(text).map((part, i) => part.kind === "text" ?
    <RichTextContent key={i} text={part.text} marks={validateMarks(marks?.map(([start, end, ...rest]) => [start - part.start, end - part.start, ...rest]), part.text)} openLinks={openLinks} /> :
    <span key={i} className="mx-0.5 rounded bg-indigo-100 px-1 text-indigo-800">{part.kind === "user" ? `@${part.name}` : formatChipDate(part.date)}</span>);
}

/** Keeps focus inside focus mode when the control that held it is about to disappear. */
function focusDialog(e) {
  e.currentTarget.closest('[role="dialog"]')?.focus();
}

function embeddable(n, docId) {
  return n.id !== docId && (n.type === "diagram" || n.type === "format");
}

/** A doc block showing one of this board's diagrams or formats inline; a card preview names it only. */
function DiagramBlock({ block, docId, readOnly, preview, onChoose }) {
  const target = useCanvasStore((s) => s.history.present.nodes.find((n) => n.id === block.ref && embeddable(n, docId)));
  const graph = useCanvasStore((s) => (preview ? null : s.history.present));
  return <div className="space-y-2">
    {!readOnly && !preview && <select aria-label="Embedded diagram" className="max-w-full rounded border p-1 text-sm" value={target?.id ?? ""} onChange={(e) => onChoose(e.target.value)}><option value="">Choose a diagram or format</option>{graph.nodes.filter((n) => embeddable(n, docId)).map((n) => <option key={n.id} value={n.id}>{n.name || n.type}</option>)}</select>}
    {!target ? <p className="text-sm text-slate-500">{block.ref ? "The embedded diagram is no longer on this board." : "No diagram chosen yet."}</p> :
      preview ? <p className="text-sm text-slate-500">Diagram: {target.name || target.type}</p> :
      target.type === "format" ? <div className="relative h-80"><FormatNode node={target} /></div> :
      <><FramePreview frame={target} graph={graph} /><button className="text-indigo-700 underline" onClick={() => openFormat(target.id)}>Open embedded diagram</button></>}
  </div>;
}

export function DocContent({ node, readOnly, preview = false }) {
  const [active, setActive] = useState(null);
  const [editing, setEditing] = useState(null);
  const closedEditor = useRef(null);
  const [suggesting, setSuggesting] = useState(false);
  const people = usePeople();
  const actor = useStore((s) => s.currentUser?.id) ?? "editor";
  const blocks = node.blocks ?? [];
  const numbers = listNumbers(blocks);
  const update = (id, patch) => patchFormat(node.id, (n) => ({ blocks: updateBlock(n.blocks, id, patch) }));
  const append = (type) => patchFormat(node.id, (n) => ({ blocks: insertBlockAfter(n.blocks, active ?? n.blocks.at(-1)?.id, newBlock(type)) }));
  const appendText = (text) => {
    const id = active ?? blocks.at(-1)?.id;
    patchFormat(node.id, (n) => ({ blocks: n.blocks.map((b) => b.id === id && typeof b.text === "string" ? { ...b, text: (b.text + text).slice(0, 5000) } : b) }));
  };
  const closeEditor = (id) => {
    closedEditor.current = id;
    setEditing(null);
  };
  const editButton = (id) => (el) => {
    if (!el || closedEditor.current !== id) return;
    closedEditor.current = null;
    if (!document.activeElement || document.activeElement === document.body) el.focus();
  };
  const commitText = (b, text, marks) => {
    closeEditor(b.id);
    if (!suggesting) patchFormat(node.id, (n) => ({ blocks: n.blocks.map((block) => block.id === b.id ? applyBlockShortcut(block, text, marks) : block) }));
    else if (text !== (b.text ?? "") || JSON.stringify(validateMarks(marks, text)) !== JSON.stringify(b.marks ?? null)) {
      patchFormat(node.id, (n) => ({ suggestions: addSuggestion(n.suggestions ?? [], { blockId: b.id, kind: "replace", text, marks, by: actor }) }));
    }
  };
  return <div className="space-y-3 text-slate-900" data-doc-content="">
    {!readOnly && !preview && <div className="sticky top-0 z-10 flex flex-wrap gap-2 rounded-lg border bg-white p-2 text-xs shadow-sm">
      <select aria-label="Insert doc block" disabled={suggesting} defaultValue="" onChange={(e) => { if (e.target.value) append(e.target.value); e.target.value = ""; }}><option value="">Add block</option>{["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code", "table", "diagram"].map((t) => <option key={t}>{t}</option>)}</select>
      <button aria-pressed={suggesting} onClick={() => setSuggesting(!suggesting)}>{suggesting ? "Suggesting changes" : "Suggest changes"}</button>
      <select aria-label="Mention person" disabled={suggesting} value="" onChange={(e) => { const p = people.get(e.target.value); if (p) appendText(userChip(p.name || p.email, p.id)); }}><option value="">@ Person</option>{[...people.values()].map((p) => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}</select>
      <label>Date <input type="date" aria-label="Insert date chip" disabled={suggesting} onChange={(e) => { if (e.target.value) appendText(dateChip(e.target.value)); }} /></label>
      <button disabled={suggesting} onClick={() => appendText(" 😊")}>Emoji 😊</button>
      <span className="text-slate-500">Select text: Ctrl/Cmd+B, I, U, K. Type #, -, [] for blocks.</span>
    </div>}
    {(preview ? blocks.slice(0, 7) : blocks).map((b, index) => <div key={b.id} data-doc-block={b.id} className="group rounded p-1 focus-within:bg-slate-50" onFocus={() => setActive(b.id)}>
      {!readOnly && !preview && <div className="mb-1 flex gap-2 text-xs text-slate-500">
        <select aria-label={`Block ${index + 1} type`} value={b.type} disabled={suggesting} onChange={(e) => update(b.id, { ...newBlock(e.target.value, b.text ?? ""), id: b.id })}>{["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code", "table", "diagram"].map((t) => <option key={t}>{t}</option>)}</select>
        <button disabled={suggesting || index === 0} aria-label={`Move block ${index + 1} up`} onClick={() => patchFormat(node.id, (n) => ({ blocks: moveBlock(n.blocks, b.id, -1) }))}>↑</button>
        <button disabled={suggesting || index === blocks.length - 1} aria-label={`Move block ${index + 1} down`} onClick={() => patchFormat(node.id, (n) => ({ blocks: moveBlock(n.blocks, b.id, 1) }))}>↓</button>
        <button onClick={(e) => { if (!suggesting) focusDialog(e); patchFormat(node.id, (n) => suggesting ? { suggestions: addSuggestion(n.suggestions ?? [], { blockId: b.id, kind: "delete", by: actor }) } : { blocks: removeBlock(n.blocks, b.id) }); }}>Remove</button>
      </div>}
      {b.type === "table" ? <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className="border border-slate-300 p-2">{readOnly || preview || suggesting ? cell : <input className="w-full min-w-16 bg-transparent" aria-label={`Row ${r + 1} column ${c + 1}`} maxLength={500} value={cell} onChange={(e) => patchFormat(node.id, (n) => ({ blocks: n.blocks.map((block) => block.id === b.id ? { ...block, rows: setTableCell(block.rows, r, c, e.target.value) } : block) }), { coalesce: true })} />}</td>)}</tr>)}</tbody></table>{!readOnly && !preview && !suggesting && <div className="flex gap-3 text-xs"><button onClick={() => update(b.id, { rows: addTableRow(b.rows) })}>Add row</button><button onClick={() => update(b.id, { rows: addTableColumn(b.rows) })}>Add column</button></div>}</div> : b.type === "diagram" ?
        <DiagramBlock block={b} docId={node.id} readOnly={readOnly || suggesting} preview={preview} onChoose={(ref) => update(b.id, { ref })} /> :
        <div className={`whitespace-pre-wrap ${b.type === "h1" ? "text-3xl font-bold" : b.type === "h2" ? "text-2xl font-bold" : b.type === "h3" ? "text-xl font-semibold" : b.type === "code" ? "bg-slate-100 p-3 font-mono" : b.type === "quote" ? "border-l-4 pl-3 italic" : "text-base"}`}>
          {b.type === "todo" && <input aria-label={`Checklist ${index + 1}`} type="checkbox" disabled={readOnly || preview || suggesting} checked={!!b.checked} onChange={(e) => update(b.id, { checked: e.target.checked })} />}{b.type === "ul" && "• "}{b.type === "ol" && `${numbers[index]}. `}
          {readOnly || preview ? <ChipText text={b.text} marks={b.marks} openLinks /> : editing === b.id ?
            <RichTextEditor key={`${b.id}-${suggesting}`} text={b.text} marks={b.marks} maxLength={5000} className="min-h-6 outline-none" onCancel={() => closeEditor(b.id)} onCommit={(text, marks) => commitText(b, text, marks)} /> :
            <div ref={editButton(b.id)} role="button" tabIndex={0} aria-label={`Edit block ${index + 1}`} className="min-h-6 cursor-text outline-none" onClick={() => setEditing(b.id)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(b.id); } }}><ChipText text={b.text} marks={b.marks} /></div>}
        </div>}
      {!preview && (node.suggestions ?? []).filter((s) => s.blockId === b.id).map((s) => <div key={s.id} className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm"><span>{people.get(s.by)?.name || s.by}: {s.kind === "delete" ? "Remove block" : <ChipText text={s.text} marks={s.marks} />}</span>{!readOnly && <div className="flex gap-3"><button onClick={(e) => { focusDialog(e); patchFormat(node.id, (n) => acceptSuggestion(n.blocks, n.suggestions ?? [], s.id)); }}>Accept</button><button onClick={(e) => { focusDialog(e); patchFormat(node.id, (n) => ({ suggestions: rejectSuggestion(n.suggestions ?? [], s.id) })); }}>Reject</button></div>}</div>)}
    </div>)}
  </div>;
}
