"use client";

import { useEffect, useState } from 'react';
import { useCanvasStore, selectReadOnly } from '@/lib/canvas-store';
import { usePeople } from '@/lib/canvas/use-people';
import { DEFAULT_FIELDS, newCard, newColumns, layoutColumns } from '@/lib/canvas/work-records';

import { WorkDataPanel } from './WorkDataPanel';
import { WorkInbox } from './WorkInbox';
import { TimelineBuilder } from './TimelineBuilder';
import { workRequest, tablePath } from '@/lib/canvas/work-api';

const inputClass = 'w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-100';
export function WorkTools({ viewCenter, viewOnly }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [builder, setBuilder] = useState(false);
  const boardId = useCanvasStore(s => s.boardId);
  useEffect(() => { if (open && boardId) workRequest(tablePath(boardId)).then(r => setDatasets(r.tables)).catch(e => setError(e.message)); }, [open, boardId, activeId]);
  const nodes = useCanvasStore(s => s.history.present.nodes);
  const boardReadOnly = useCanvasStore(selectReadOnly);
  const readOnly = boardReadOnly || viewOnly;
  const people = usePeople();
  const active = nodes.find(n => n.id === activeId);
  useEffect(() => {
    const show = e => { setActiveId(e.detail); setOpen(true); };
    const keyboard = e => {
      if (e.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      const state = useCanvasStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        const card = state.history.present.nodes.find(n => n.id === state.selection[0] && n.type === 'card');
        if (card) { e.preventDefault(); e.stopPropagation(); setActiveId(card.id); setOpen(true); }
      } else if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey && !selectReadOnly(state) && !viewOnly) {
        e.preventDefault(); e.stopPropagation(); const card = newCard(viewCenter()); state.addNode(card); setActiveId(card.id); setOpen(true);
      }
    };
    window.addEventListener('board-work-open', show);
    window.addEventListener('keydown', keyboard, true);
    return () => { window.removeEventListener('board-work-open', show); window.removeEventListener('keydown', keyboard, true); };
  }, [viewCenter, viewOnly]);
  function update(patch) { if (!readOnly) useCanvasStore.getState().updateNodeFields(activeId, patch); }
  function record(key, value) { update({ record: { ...active.record, [key]: value } }); }
  function create(kind) {
    const node = kind === 'card' ? newCard(viewCenter()) : newColumns(viewCenter());
    useCanvasStore.getState().addNode(node); setActiveId(node.id); setOpen(true);
  }
  async function createDataset(kind, datasetId) {
    if (readOnly || busy) return;
    setBusy(true); setError('');
    try {
      let id = datasetId;
      if (!id) {
        const extras = kind === 'story' ? [{ id: 'activity', name: 'Activity', type: 'text' }, { id: 'task', name: 'Task', type: 'text' }, { id: 'release', name: 'Release', type: 'text' }] : kind === 'org' ? [{ id: 'role', name: 'Role', type: 'text' }, { id: 'team', name: 'Team', type: 'text' }] : kind === 'chart' ? [{ id: 'value', name: 'Value', type: 'number' }] : [];
        const result = await workRequest(tablePath(boardId), { name: 'New ' + kind, fields: [...DEFAULT_FIELDS, ...extras], views: [{ id: kind, name: kind, kind }] });
        id = result.table.id;
      }
      const point = viewCenter();
      const node = { id: crypto.randomUUID(), type: 'work', kind, title: datasets.find(t => t.id === id)?.name || 'New ' + kind, datasetId: id, x: point.x, y: point.y, w: 640, h: 420, parentId: null, groupId: null };
      useCanvasStore.getState().addNode(node); setActiveId(node.id);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function changeLane(key, id, patch) {
    const list = active[key].map(lane => lane.id === id ? { ...lane, ...patch } : lane);
    useCanvasStore.getState().editBoard(board => layoutColumns({ ...board, nodes: board.nodes.map(n => n.id === activeId ? { ...n, [key]: list } : n) }, activeId));
  }
  return <>
    <WorkInbox />
    {builder && <TimelineBuilder viewCenter={viewCenter} onClose={() => setBuilder(false)} readOnly={readOnly} />}
    {open && active?.datasetId && <WorkDataPanel key={active.id} node={active} readOnly={readOnly} onClose={() => setActiveId(null)} />}
    <button type="button" onClick={() => setOpen(v => !v)} className="absolute right-4 top-16 z-30 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow" aria-expanded={open}>Cards and work</button>
    {open && <section role="dialog" aria-label="Cards and work" className="absolute bottom-20 right-4 top-28 z-30 w-[min(400px,calc(100%-32px))] overflow-auto rounded-xl border border-slate-300 bg-white p-4 text-slate-800 shadow-xl" onKeyDown={e => e.stopPropagation()}>
      <div className="mb-4 flex justify-between"><h2 className="font-semibold">Cards and work</h2><button onClick={() => setOpen(false)} aria-label="Close cards and work">Close</button></div>
      {!readOnly && <div className="mb-4 flex gap-2"><button className={inputClass} onClick={() => create('card')}>Add card (D)</button><button className={inputClass} onClick={() => create('columns')}>Add columns</button></div>}
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
      {!readOnly && <><div className="mb-3 grid grid-cols-2 gap-2">{[['table', 'Table'], ['kanban', 'Kanban'], ['timeline', 'Timeline'], ['story', 'Story map'], ['mindmap', 'Mind map'], ['org', 'Org chart'], ['chart', 'Chart']].map(([kind, label]) => <button key={kind} className={inputClass} disabled={busy} onClick={() => void createDataset(kind)}>Add {label}</button>)}<button className={inputClass} onClick={() => setBuilder(true)}>Timeline Builder</button></div><label className="mb-4 block text-sm">Reuse table records<select className={inputClass} disabled={busy} value="" onChange={e => { if (e.target.value) void createDataset('table', e.target.value); }}><option value="">Choose an existing table</option>{datasets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></>}
      <label className="mb-4 block text-sm">Selected widget<select className={inputClass} value={active?.id || ''} onChange={e => setActiveId(e.target.value)}><option value="">Choose a card or widget</option>{nodes.filter(n => ['card', 'work'].includes(n.type)).map(n => <option key={n.id} value={n.id}>{n.record?.title || n.title}</option>)}</select></label>
      {active?.type === 'card' && <div className="space-y-3">
        {['title', 'description', 'start', 'end', 'tags', 'links'].map(key => <label key={key} className="block text-sm capitalize">{key}{key === 'description' ? <textarea className={inputClass} rows={4} value={active.record[key] || ''} disabled={readOnly} onChange={e => record(key, e.target.value)} /> : <input className={inputClass} type={['start', 'end'].includes(key) ? 'date' : 'text'} value={active.record[key] || ''} disabled={readOnly} onChange={e => record(key, e.target.value)} />}</label>)}
        <label className="block text-sm">Assignee<select className={inputClass} disabled={readOnly} value={active.record.assignee || ''} onChange={e => record('assignee', e.target.value)}><option value="">Unassigned</option>{[...people.values()].map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}</select></label>
        <label className="block text-sm">Status<select className={inputClass} disabled={readOnly} value={active.record.status} onChange={e => record('status', e.target.value)}>{['To do', 'In progress', 'Done'].map(v => <option key={v}>{v}</option>)}</select></label>
        {nodes.filter(n => n.kind === 'columns').length > 0 && <label className="block text-sm">Columns widget<select className={inputClass} disabled={readOnly} value={active.parentId || ''} onChange={e => update({ parentId: e.target.value || null })}><option value="">None</option>{nodes.filter(n => n.kind === 'columns').map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>}
        {['lane', 'swimlane'].map(key => { const parent = nodes.find(n => n.id === active.parentId && n.kind === 'columns'); return parent && <label key={key} className="block text-sm capitalize">{key}<select className={inputClass} disabled={readOnly} value={active.record[key] || ''} onChange={e => { record(key, e.target.value); useCanvasStore.getState().editBoard(b => layoutColumns(b, parent.id)); }}>{parent[key === 'lane' ? 'lanes' : 'swimlanes'].map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>; })}
      </div>}
      {active?.kind === 'columns' && <div className="space-y-4">
        <label className="block text-sm">Widget title<input className={inputClass} disabled={readOnly} value={active.title} onChange={e => update({ title: e.target.value })} /></label>
        {['lanes', 'swimlanes'].map(key => <fieldset key={key} disabled={readOnly} className="space-y-2"><legend className="text-sm font-semibold capitalize">{key}</legend>{active[key].map((lane, index) => <div key={lane.id} className="flex gap-1"><input aria-label={`${key} name ${index + 1}`} className={inputClass} value={lane.name} onChange={e => changeLane(key, lane.id, { name: e.target.value })} /><input aria-label={`${key} color ${index + 1}`} type="color" value={lane.color} onChange={e => changeLane(key, lane.id, { color: e.target.value })} /><button disabled={!index} aria-label={`Move ${lane.name} up`} onClick={() => { const list = [...active[key]]; [list[index - 1], list[index]] = [list[index], list[index - 1]]; update({ [key]: list }); useCanvasStore.getState().editBoard(b => layoutColumns(b, active.id)); }}>↑</button></div>)}<button className={inputClass} disabled={active[key].length >= 30} onClick={() => update({ [key]: [...active[key], { id: crypto.randomUUID(), name: 'New lane', color: '#dbeafe' }] })}>Add {key === 'lanes' ? 'column' : 'swimlane'}</button></fieldset>)}
        <button disabled={readOnly} className={inputClass} onClick={() => { const card = { ...newCard({ x: active.x + 16, y: active.y + 84 }), parentId: active.id, record: { title: 'Untitled task', status: 'To do', lane: active.lanes[0]?.id, swimlane: active.swimlanes[0]?.id } }; useCanvasStore.getState().editBoard(b => layoutColumns({ ...b, nodes: [...b.nodes, card] }, active.id)); setActiveId(card.id); }}>Add card to columns</button>
        <button disabled={readOnly} className={inputClass} onClick={() => useCanvasStore.getState().editBoard(b => layoutColumns(b, active.id))}>Arrange cards</button>
      </div>}
    </section>}
  </>;
}
