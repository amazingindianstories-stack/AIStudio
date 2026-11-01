"use client";

import { useState } from 'react';
import { useCanvasStore } from '@/lib/canvas-store';
import { usePeople } from '@/lib/canvas/use-people';
import { FIELD_TYPES, WORK_KINDS, WORK_VIEW_NAMES, selectChoices, viewFor } from '@/lib/canvas/work-records';
import { workRequest, tablePath, useWorkRecords } from '@/lib/canvas/work-api';
import { readWorkFile, exportWorkFile } from '@/lib/canvas/work-files';
import { downloadWork } from '@/lib/canvas/work-layouts';
import { WorkRecordViews } from './WorkRecordViews';
import { WorkRecordPicker } from './WorkRecordPicker';

const input = 'rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-100';
export function WorkDataPanel({ node, readOnly, onClose }) {
  const boardId = useCanvasStore(s => s.boardId);
  const people = usePeople();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState({ q: '', sort: '', direction: 'asc', filterField: '', filterValue: '', offset: 0 });
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [configuration, setConfiguration] = useState(null);
  const [history, setHistory] = useState(null);
  const path = tablePath(boardId, node.datasetId);
  const { data, error: loadError, load } = useWorkRecords(boardId, node, { query });
  const table = data?.table;
  const canEdit = Boolean(table?.canEdit && !readOnly);
  const view = viewFor(table, node.kind);
  async function change(operation) {
    if (!canEdit || busy) return null;
    setBusy(true); setError('');
    try { const response = await workRequest(path, operation); await load(); return response; }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  }
  function select(record) { setSelected(record); setDraft({ cells: { ...record.cells }, parentId: record.parentId, blockedBy: record.blockedBy || [] }); }
  async function add(parentId = null, cells = {}) {
    const response = await change({ op: 'add', cells: { title: 'Untitled record', ...cells }, parentId });
    if (response?.record) select(response.record);
  }
  async function viewChange(patch) {
    const next = { ...view, ...patch };
    await change({ op: 'settings', version: table.version, views: [...table.views.filter(v => v.id !== view.id && v.kind !== view.kind), next] });
  }
  async function allRecords() {
    return (await workRequest(`${path}?all=1`)).records;
  }
  async function exportFile(excel) {
    setBusy(true);
    try {
      const records = await allRecords();
      // Stable ids make org-chart CSV re-import update the same people and hierarchy.
      const fields = [{ id: '_id', name: 'Record id' }, { id: '_parent', name: 'Parent id' }, ...table.fields];
      await exportWorkFile(fields, records.map(r => ({ ...r, cells: { ...r.cells, _id: r.id, _parent: r.parentId } })), excel);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function importFile(file) {
    if (!file || !canEdit) return;
    setBusy(true); setError('');
    try {
      const [head, ...rows] = await readWorkFile(file);
      if (!head) return;
      const ids = head.map(value => { const raw = String(value).trim(); return table.fields.find(f => f.id === raw || f.name === raw)?.id || (['_id', '_parent'].includes(raw) ? raw : null); });
      if (!ids.some(id => table.fields.some(f => f.id === id))) throw new Error('Use field ids or names as column headers.');
      const existing = new Map((await allRecords()).map(r => [r.id, r]));
      const imported = new Map(); const parents = [];
      for (const row of rows.filter(r => r.some(v => String(v).trim()))) {
        const cells = {}; let stableId = '', parentId = '';
        row.forEach((value, i) => {
          const key = ids[i];
          if (key === '_id') { stableId = String(value); return; }
          if (key === '_parent') { parentId = String(value); return; }
          const field = table.fields.find(f => f.id === key);
          if (!field || field.type === 'formula') return;
          cells[key] = ['number', 'points'].includes(field.type) ? (value === '' ? '' : Number(value)) : field.type === 'relation' ? String(value).split(';').filter(Boolean) : String(value);
        });
        const previous = existing.get(stableId);
        const response = await workRequest(path, previous ? { op: 'update', id: previous.id, version: previous.version, cells: { ...previous.cells, ...cells } } : { op: 'add', cells });
        imported.set(stableId || response.record.id, response.record);
        if (parentId) parents.push([response.record, parentId]);
      }
      for (const [record, parentId] of parents) {
        const parent = imported.get(parentId)?.id || existing.get(parentId)?.id;
        if (!parent) throw new Error(`Parent ${parentId} is missing. Imported records are saved; correct the parent id and re-import.`);
        await workRequest(path, { op: 'update', id: record.id, version: record.version, parentId: parent });
      }
      await load();
    } catch (e) { setError(`Import stopped: ${e.message}. Completed records remain saved.`); await load(); }
    finally { setBusy(false); }
  }
  async function convertSelection() {
    const state = useCanvasStore.getState();
    const chosen = state.history.present.nodes.filter(n => state.selection.includes(n.id) && ['card', 'sticky'].includes(n.type));
    if (!chosen.length) { setError('Select cards or stickies on the board before opening this widget.'); return; }
    setBusy(true);
    try {
      for (const item of chosen) await workRequest(path, { op: 'add', cells: item.type === 'card' ? item.record : { title: item.text || '' } });
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function exportTree() {
    try {
      const { treeToBoard } = await import('@/lib/canvas/work-generators');
      const records = await allRecords();
      useCanvasStore.getState().editBoard(board => treeToBoard(board, records, view, { x: node.x + node.w + 60, y: node.y }, node.kind));
    } catch (e) { setError(e.message); }
  }
  function keyboard(e) {
    if (!e.target.closest('[aria-label="Record workspace"]') || e.target.closest('input,textarea,select') || !canEdit || !['mindmap', 'org', 'story'].includes(node.kind)) return;
    if ((e.key === 'Tab' || e.key === 'Enter') && node.kind === 'story') {
      e.preventDefault();
      const activityKey = view.groupBy || 'activity', releaseKey = view.swimlaneBy || 'release';
      const story = { [activityKey]: selected?.cells[activityKey] || 'New activity', [releaseKey]: selected?.cells[releaseKey] || 'Release 1' };
      void add(null, e.key === 'Tab' ? { ...story, task: 'New task' } : { ...story, task: selected?.cells.task || 'New task' });
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault(); void add(e.key === 'Tab' ? selected?.id || null : selected?.parentId || null);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const rows = data.records, index = rows.findIndex(r => r.id === selected?.id);
      const target = e.key === 'ArrowLeft' ? rows.find(r => r.id === selected?.parentId) : e.key === 'ArrowRight' ? rows.find(r => r.parentId === selected?.id) : rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)))];
      if (target) select(target);
    }
  }
  return <section role="dialog" aria-label="Work records" className="absolute inset-x-4 bottom-4 top-16 z-[46] flex flex-col overflow-hidden rounded-xl border border-slate-300 bg-white text-slate-800 shadow-2xl md:left-[20%]" onKeyDown={e => { e.stopPropagation(); keyboard(e); }}>
    <header className="flex flex-wrap items-center gap-2 border-b bg-slate-50 p-3"><h2 className="mr-auto font-semibold">{table?.name || 'Loading records'}</h2><button className={input} onClick={() => void load()}>Refresh</button><button className={input} onClick={onClose}>Close records</button></header>
    {(error || loadError) && !configuration && <p role="alert" className="bg-red-50 p-3 text-sm text-red-800">{error || loadError}</p>}
    {table && <>
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <label className="text-xs">View <select aria-label="Work view" className={input} disabled={!canEdit || busy} value={node.kind} onChange={e => useCanvasStore.getState().updateNodeFields(node.id, { kind: e.target.value })}>{WORK_KINDS.filter(k => k !== 'columns').map(k => <option key={k} value={k}>{WORK_VIEW_NAMES[k]}</option>)}</select></label>
        <input aria-label="Search table" placeholder="Search records" className={input} value={query.q} onChange={e => setQuery({ ...query, q: e.target.value, offset: 0 })} />
        <select aria-label="Sort field" className={input} value={query.sort} onChange={e => setQuery({ ...query, sort: e.target.value, offset: 0 })}><option value="">Record order</option>{table.fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <select aria-label="Sort direction" className={input} value={query.direction} onChange={e => setQuery({ ...query, direction: e.target.value })}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
        <select aria-label="Filter field" className={input} value={query.filterField} onChange={e => setQuery({ ...query, filterField: e.target.value, offset: 0 })}><option value="">No filter</option>{table.fields.filter(f => !['formula', 'relation'].includes(f.type)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        {query.filterField && <input aria-label="Filter value" className={input} value={query.filterValue} onChange={e => setQuery({ ...query, filterValue: e.target.value, offset: 0 })} />}
        <button className={input} disabled={!canEdit || busy} onClick={() => void add()}>Add record</button>
        <button className={input} disabled={!canEdit || busy} onClick={() => void convertSelection()}>Copy selected cards or stickies</button>
        <button className={input} disabled={busy} onClick={() => void exportFile(false)}>Export CSV</button>
        <button className={input} disabled={busy} onClick={() => void exportFile(true)}>Export Excel</button>
        <label className={`${input} ${!canEdit || busy ? 'opacity-50' : 'cursor-pointer'}`}>Import CSV or Excel<input aria-label="Import work file" type="file" accept=".csv,.xlsx" className="sr-only" disabled={!canEdit || busy} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className={input} disabled={busy} onClick={() => setConfiguration({ name: table.name, fields: structuredClone(table.fields), ownerOnly: table.ownerOnly })}>Fields and settings</button>
        <button className={input} onClick={async () => { try { setHistory((await workRequest(path + '/history')).history); } catch (e) { setError(e.message); } }}>History</button>
      </div>
      <div className="flex flex-wrap gap-3 border-b bg-slate-50 px-3 py-2 text-xs">
        <label>Group by <select aria-label="Group by" className={input} disabled={!canEdit || busy} value={view.groupBy || ''} onChange={e => void viewChange({ groupBy: e.target.value })}><option value="">None</option>{table.fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        {['kanban', 'story'].includes(node.kind) && <label>Swimlanes <select aria-label="Swimlane field" className={input} disabled={!canEdit || busy} value={view.swimlaneBy || ''} onChange={e => void viewChange({ swimlaneBy: e.target.value })}><option value="">None</option>{table.fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
        {node.kind === 'timeline' && ['startField', 'endField'].map(key => <label key={key}>{key === 'startField' ? 'Start date field' : 'End date field'} <select aria-label={key} className={input} disabled={!canEdit || busy} value={view[key] || (key === 'startField' ? 'start' : 'end')} onChange={e => void viewChange({ [key]: e.target.value })}>{table.fields.filter(f => f.type === 'date').map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>)}
        {['mindmap', 'org'].includes(node.kind) && <><label>Node style <select className={input} disabled={!canEdit || busy} value={view.nodeType || 'rect'} onChange={e => void viewChange({ nodeType: e.target.value })}><option value="rect">Box</option><option value="ellipse">Ellipse</option><option value="shape">Rounded box</option></select></label><label>Branch color <input type="color" disabled={!canEdit || busy} value={view.branchColor || '#dbeafe'} onChange={e => void viewChange({ branchColor: e.target.value })} /></label><button className={input} disabled={!selected || !canEdit || busy} onClick={() => void viewChange({ collapsed: view.collapsed?.includes(selected.id) ? view.collapsed.filter(id => id !== selected.id) : [...(view.collapsed || []), selected.id] })}>Collapse or expand branch</button><button className={input} disabled={!canEdit || busy} onClick={() => void exportTree()}>Place shapes and links on board</button><button className={input} onClick={async () => downloadWork('map.json', JSON.stringify({ fields: table.fields, records: await allRecords() }), 'application/json')}>Export map</button></>}
        {node.kind === 'chart' && <><label>Chart type <select className={input} disabled={!canEdit || busy} value={view.chartType || 'bar'} onChange={e => void viewChange({ chartType: e.target.value })}><option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option></select></label>{(() => { const numbers = table.fields.filter(f => ['number', 'points', 'formula'].includes(f.type)); const plotted = numbers.find(f => f.id === view.valueField) || numbers[0]; return <label>Values <select aria-label="Chart values" className={input} disabled={!canEdit || busy || !numbers.length} value={plotted?.id || ''} onChange={e => void viewChange({ valueField: e.target.value })}>{numbers.length ? numbers.map(f => <option key={f.id} value={f.id}>{f.name}</option>) : <option value="">{view.groupBy ? 'Record count' : 'Add a number field'}</option>}</select></label>; })()}</>}
        <details><summary className="cursor-pointer py-2">Visible fields and columns</summary><div className="flex flex-wrap gap-2">{table.fields.map(f => <label key={f.id}><input type="checkbox" disabled={!canEdit || busy} checked={!view.hiddenFields?.includes(f.id)} onChange={e => void viewChange({ hiddenFields: e.target.checked ? (view.hiddenFields || []).filter(id => id !== f.id) : [...(view.hiddenFields || []), f.id] })} /> {f.name}</label>)}{node.kind === 'kanban' && (table.fields.find(f => f.id === (view.groupBy || 'status'))?.options || []).map(column => <label key={column}><input type="checkbox" disabled={!canEdit || busy} checked={!view.hiddenColumns?.includes(column)} onChange={e => void viewChange({ hiddenColumns: e.target.checked ? (view.hiddenColumns || []).filter(v => v !== column) : [...(view.hiddenColumns || []), column] })} /> {column}</label>)}</div></details>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-4" tabIndex={0} aria-label="Record workspace"><WorkRecordViews kind={node.kind} records={data.records} fields={table.fields} groups={data.groups} view={view} selectedId={selected?.id} onSelect={select} onReclassify={canEdit && !busy ? (record, patch) => {
          const removed = table.fields.find(f => f.type === 'select' && patch[f.id] && !selectChoices(f, record.cells[f.id]).includes(patch[f.id]));
          if (removed) setError(`"${patch[removed.id]}" is no longer a ${removed.name} option. Choose a current option.`);
          else void change({ op: 'update', id: record.id, version: record.version, cells: { ...record.cells, ...patch } });
        } : undefined} onDateMove={canEdit && !busy ? (record, days, edge) => {
          const startKey = view.startField || 'start', endKey = view.endField || 'end';
          const shift = value => new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
          const cells = { ...record.cells };
          if (edge !== 'end' && cells[startKey]) cells[startKey] = shift(cells[startKey]);
          if (cells[endKey]) cells[endKey] = shift(cells[endKey]);
          if (cells[endKey] && cells[endKey] < cells[startKey]) cells[endKey] = cells[startKey];
          void change({ op: 'update', id: record.id, version: record.version, cells });
        } : undefined} /></div>
        {draft && selected && <form className="w-72 shrink-0 space-y-3 overflow-auto border-l bg-slate-50 p-3" aria-label="Record details" onSubmit={async e => { e.preventDefault(); const result = await change({ op: 'update', id: selected.id, version: selected.version, ...draft }); if (result?.record) select(result.record); }}>
          <div className="flex justify-between"><h3 className="font-semibold">Record details</h3><button type="button" onClick={() => setDraft(null)}>Close</button></div>
          <fieldset disabled={!canEdit || busy} className="space-y-3">{table.fields.filter(f => f.type !== 'formula').map(f => <label key={f.id} className="block text-xs">{f.name}{f.type === 'select' || f.type === 'people' ? <select className={`${input} w-full`} value={draft.cells[f.id] || ''} onChange={e => setDraft({ ...draft, cells: { ...draft.cells, [f.id]: e.target.value } })}><option value="">None</option>{f.type === 'select' ? selectChoices(f, selected.cells[f.id]).map(v => <option key={v} value={v}>{f.options.includes(v) ? v : `${v} (removed)`}</option>) : [...people.values()].map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}</select> : <input className={`${input} w-full`} type={['number', 'points'].includes(f.type) ? 'number' : f.type === 'date' ? 'date' : 'text'} step="any" maxLength={2000} value={Array.isArray(draft.cells[f.id]) ? draft.cells[f.id].join(';') : draft.cells[f.id] ?? ''} onChange={e => setDraft({ ...draft, cells: { ...draft.cells, [f.id]: ['number', 'points'].includes(f.type) ? (e.target.value === '' ? '' : Number(e.target.value)) : f.type === 'relation' ? e.target.value.split(';').filter(Boolean) : e.target.value } })} />}</label>)}
          <WorkRecordPicker path={path} label="Parent" value={draft.parentId} excludeId={selected.id} onChange={parentId => setDraft({ ...draft, parentId })} />
          <WorkRecordPicker path={path} label="Blocked by" multiple value={draft.blockedBy} excludeId={selected.id} onChange={blockedBy => setDraft({ ...draft, blockedBy })}
            fixed={table.fields.filter(f => f.type === 'relation').flatMap(f => (Array.isArray(draft.cells[f.id]) ? draft.cells[f.id] : []).map(id => ({ id, source: f.name })))} />
          <button className={`${input} bg-blue-50`} type="submit">Save record</button><button className={input} type="button" onClick={async () => { const result = await change({ op: 'delete', id: selected.id, version: selected.version }); if (result) { setSelected(null); setDraft(null); } }}>Delete record</button>
          </fieldset>
        </form>}
      </div>
      <footer className="flex flex-wrap gap-3 border-t p-3 text-xs"><span>{data.total} records · showing {data.offset + (data.records.length ? 1 : 0)}-{data.offset + data.records.length}</span>{node.kind === 'table' && <><button disabled={!query.offset || busy} onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - data.limit) })}>Previous</button><button disabled={data.offset + data.limit >= data.total || busy} onClick={() => setQuery({ ...query, offset: query.offset + data.limit })}>Next</button></>}{Object.entries(data.aggregates).map(([key, value]) => <span key={key}>{key}: {value == null ? 'Empty' : Number(value).toLocaleString('en', { maximumFractionDigits: 2 })}</span>)}</footer>
    </>}
    {configuration && <section role="dialog" aria-label="Table fields and settings" className="absolute inset-4 overflow-auto rounded-xl border bg-white p-4 shadow-xl"><h3 className="mb-3 font-semibold">Fields and settings</h3><fieldset disabled={!canEdit || busy} className="space-y-3"><label className="block text-sm">Table title <input className={input} value={configuration.name} onChange={e => setConfiguration({ ...configuration, name: e.target.value })} /></label><label className="block text-sm"><input type="checkbox" checked={configuration.ownerOnly} onChange={e => setConfiguration({ ...configuration, ownerOnly: e.target.checked })} /> Only the table owner and board owner can edit this table</label>{configuration.fields.map((field, index) => <div key={field.id} className="flex flex-wrap items-center gap-2 rounded border p-2"><span className="text-xs text-slate-500">{field.id}</span><input aria-label={`Field name ${index + 1}`} className={input} value={field.name} onChange={e => setConfiguration({ ...configuration, fields: configuration.fields.map((f, i) => i === index ? { ...f, name: e.target.value } : f) })} /><select aria-label={`Field type ${index + 1}`} className={input} value={field.type} onChange={e => setConfiguration({ ...configuration, fields: configuration.fields.map((f, i) => i === index ? { ...f, type: e.target.value, options: [], expression: '0' } : f) })}>{FIELD_TYPES.map(type => <option key={type}>{type}</option>)}</select>{['select', 'formula'].includes(field.type) && <input aria-label={`Field ${field.type} ${index + 1}`} placeholder={field.type === 'select' ? 'Options separated by commas' : 'Example: points * estimate'} className={input} value={field.type === 'select' ? field.options?.join(',') : field.expression || ''} onChange={e => setConfiguration({ ...configuration, fields: configuration.fields.map((f, i) => i === index ? { ...f, [field.type === 'select' ? 'options' : 'expression']: field.type === 'select' ? e.target.value.split(',') : e.target.value } : f) })} />}{['number', 'points', 'formula'].includes(field.type) && <><select aria-label={`Number format ${index + 1}`} className={input} value={field.format || 'number'} onChange={e => setConfiguration({ ...configuration, fields: configuration.fields.map((f, i) => i === index ? { ...f, format: e.target.value } : f) })}>{['number', 'currency', 'percent', 'progress'].map(format => <option key={format}>{format}</option>)}</select><input aria-label={`Color threshold ${index + 1}`} type="number" placeholder="Color at or above" className={input} value={field.colors?.[0]?.min ?? ''} onChange={e => setConfiguration({ ...configuration, fields: configuration.fields.map((f, i) => i === index ? { ...f, colors: e.target.value === '' ? [] : [{ min: Number(e.target.value), color: f.colors?.[0]?.color || '#15803d' }] } : f) })} /><input aria-label={`Conditional color ${index + 1}`} type="color" value={field.colors?.[0]?.color || '#15803d'} onChange={e => setConfiguration({ ...configuration, fields: configuration.fields.map((f, i) => i === index ? { ...f, colors: [{ min: f.colors?.[0]?.min || 0, color: e.target.value }] } : f) })} /></>}<button className={input} onClick={() => setConfiguration({ ...configuration, fields: configuration.fields.filter((_, i) => i !== index) })}>Remove field</button></div>)}<button className={input} onClick={() => { const id = `field_${crypto.randomUUID().slice(0, 8)}`; setConfiguration({ ...configuration, fields: [...configuration.fields, { id, name: 'New field', type: 'text' }] }); }}>Add field</button>{error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}<button className={input} onClick={async () => { const result = await change({ op: 'settings', version: table.version, ...configuration }); if (result) setConfiguration(null); }}>Save fields and settings</button></fieldset><button className={`${input} mt-3`} onClick={() => setConfiguration(null)}>Close settings</button></section>}
    {history && <section role="dialog" aria-label="Table history" className="absolute inset-4 overflow-auto rounded-xl border bg-white p-4 shadow-xl"><div className="mb-4 flex justify-between"><h3 className="font-semibold">Table history</h3><button className={input} onClick={() => setHistory(null)}>Close history</button></div>{history.map(row => <details key={row.id} className="border-b py-2 text-sm"><summary>{row.action} · {people.get(row.actorId)?.name || row.actorId.slice(0, 8)} · {new Date(row.createdAt).toLocaleString()}</summary><div className="grid grid-cols-2 gap-3 p-2"><div><strong>Before</strong><pre className="whitespace-pre-wrap text-xs">{Object.entries(row.before?.cells || row.before || {}).filter(([, value]) => typeof value !== 'object').map(([key, value]) => `${table?.fields.find(f => f.id === key)?.name || key}: ${value}`).join('\n') || 'No record'}</pre></div><div><strong>After</strong><pre className="whitespace-pre-wrap text-xs">{Object.entries(row.after?.cells || row.after || {}).filter(([, value]) => typeof value !== 'object').map(([key, value]) => `${table?.fields.find(f => f.id === key)?.name || key}: ${value}`).join('\n') || 'No record'}</pre></div></div></details>)}{history.length === 100 && <button className={input} onClick={async () => { try { setHistory([...history, ...(await workRequest(`${path}/history?offset=${history.length}`)).history]); } catch (e) { setError(e.message); } }}>Load earlier changes</button>}</section>}
  </section>;
}
