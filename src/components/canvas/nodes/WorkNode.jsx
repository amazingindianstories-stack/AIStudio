"use client";
import { useCanvasStore } from '@/lib/canvas-store';
import { previewLimit, useWorkRecords } from '@/lib/canvas/work-api';
import { viewFor } from '@/lib/canvas/work-records';
import { WorkRecordViews } from '../WorkRecordViews';

export function openWorkNode(id) {
  window.dispatchEvent(new CustomEvent('board-work-open', { detail: id }));
}

export function WorkNode({ node }) {
  const card = node.type === 'card';
  const boardId = useCanvasStore(s => s.boardId);
  const limit = previewLimit(node);
  const { data, error } = useWorkRecords(boardId, node, { limit });
  const view = data && viewFor(data.table, node.kind);
  const shown = data ? Math.min(limit, data.records.length) : 0;
  const summary = !data ? '' : node.kind === 'chart' && view.groupBy ? `${data.total.toLocaleString('en')} records in ${data.groups.length} groups`
    : shown < data.total ? `Showing ${shown} of ${data.total.toLocaleString('en')} records` : `${data.total.toLocaleString('en')} records`;
  return <div className="h-full overflow-hidden rounded-xl border border-slate-300 bg-white text-slate-800 shadow-sm" data-work-kind={card ? 'card' : node.kind}>
    <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
      <span className="truncate text-xs font-semibold uppercase tracking-wider">{card ? node.record.status || 'Task' : data?.table.name || node.title || node.kind}</span>
      <button type="button" className="rounded px-2 py-1 text-xs text-blue-700 hover:bg-blue-100" onPointerDown={e => e.stopPropagation()} onClick={() => openWorkNode(node.id)} aria-label={card ? 'Open card details' : 'Open work widget'}>Open</button>
    </div>
    {card ? <div className="space-y-2 p-3">
      <div className="line-clamp-2 text-base font-semibold">{node.record.title}</div>
      <p className="line-clamp-2 text-xs text-slate-500">{node.record.description}</p>
      <div className="flex flex-wrap gap-2 text-xs text-slate-600"><span>{node.record.end ? `Due ${node.record.end}` : ''}</span><span>{node.record.tags}</span></div>
    </div> : node.kind === 'columns' ? <div className="flex h-full gap-2 px-2 pt-2">{node.lanes.map(lane => <div key={lane.id} className="min-w-0 flex-1 rounded-t border border-slate-200" style={{ background: lane.color }}><div className="truncate p-2 text-sm font-medium">{lane.name}</div>{node.swimlanes.map(row => <div key={row.id} className="border-t border-slate-200 px-2 text-xs text-slate-500" style={{ height: (node.h - 72) / node.swimlanes.length }}>{row.name}</div>)}</div>)}</div> : <div className="pointer-events-none overflow-hidden p-3">{error ? <p className="text-xs text-red-700">{error}</p> : data ? <><p className="mb-2 text-xs text-slate-500">{summary}</p><WorkRecordViews kind={node.kind} records={data.records.slice(0, limit)} fields={data.table.fields} groups={data.groups} view={view} compact /></> : <p className="text-xs text-slate-500">Loading records</p>}</div>}
  </div>;
}
