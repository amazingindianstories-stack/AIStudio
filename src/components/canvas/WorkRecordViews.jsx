"use client";

import { treeLayout, timelineLayout, storyLayout, numberPresentation } from '@/lib/canvas/work-layouts';
import { blockersOf } from '@/lib/canvas/work-records';

const COLORS = ['#dbeafe', '#fce7f3', '#dcfce7', '#fef3c7', '#ede9fe'];
export function WorkRecordViews({ kind, records, fields, groups = [], view = {}, onSelect = () => {}, selectedId, compact = false, onDateMove, onReclassify }) {
  function dragDates(event, record, edge) {
    if (!onDateMove || event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    const startX = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const end = e => {
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', cancel);
      const days = Math.round((e.clientX - startX) / 24);
      if (days) onDateMove(record, days, edge);
    };
    const cancel = () => { target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', cancel); };
    target.addEventListener('pointerup', end); target.addEventListener('pointercancel', cancel);
  }
  const label = record => String(record.cells.title || record.cells[fields[0]?.id] || 'Untitled');
  if (kind === 'mindmap' || kind === 'org') {
    const placed = treeLayout(records, { collapsed: view.collapsed });
    const byId = new Map(placed.map(r => [r.id, r]));
    return <svg aria-label={kind === 'org' ? 'Org chart' : 'Mind map'} width={Math.max(600, ...placed.map(r => r.x + 230))} height={Math.max(200, placed.length * 110)}>
      {placed.filter(r => byId.has(r.parentId)).map(r => { const parent = byId.get(r.parentId); return <path key={r.id} d={`M${parent.x + 210},${parent.y + 40} H${parent.x + 225} V${r.y + 40} H${r.x}`} fill="none" stroke="#94a3b8" strokeWidth="2" />; })}
      {placed.map(r => <g key={r.id} onClick={() => onSelect(r)} role="button" tabIndex={compact ? -1 : 0} aria-label={label(r)} onKeyDown={e => { if (e.key === 'Enter') onSelect(r); }}>
        {view.nodeType === 'ellipse' ? <ellipse cx={r.x + 105} cy={r.y + 40} rx="105" ry="40" fill={view.branchColor || COLORS[r.branch % COLORS.length]} stroke={selectedId === r.id ? '#2563eb' : '#94a3b8'} /> : <rect x={r.x} y={r.y} width="210" height="80" rx={view.nodeType === 'shape' ? 24 : 8} fill={view.branchColor || COLORS[r.branch % COLORS.length]} stroke={selectedId === r.id ? '#2563eb' : '#94a3b8'} />}
        <text x={r.x + 12} y={r.y + 28} fontSize="14" fill="#0f172a">{label(r).slice(0, 25)}</text>
        {kind === 'org' && fields.filter(f => f.id !== 'title' && !view.hiddenFields?.includes(f.id)).slice(0, 2).map((f, i) => <text key={f.id} x={r.x + 12} y={r.y + 48 + i * 16} fontSize="11" fill="#475569">{String(r.cells[f.id] || '').slice(0, 32)}</text>)}
      </g>)}
    </svg>;
  }
  if (kind === 'timeline') {
    const layout = timelineLayout(records, view);
    const byId = new Map(layout.records.map(r => [r.id, r]));
    const width = Math.min(100000, Math.max(600, ...layout.records.map(r => r.x + r.w + 100)));
    return <div><p className="mb-2 text-xs text-slate-500">Start {new Date(layout.start).toISOString().slice(0, 10)} · 24 px per day · records without start dates are omitted</p><svg aria-label="Timeline" width={width} height={Math.max(100, layout.height + 20)}>
      {layout.groups.map(g => <g key={g.label} aria-label={`Timeline group ${g.label}`}><line x1="0" x2={width} y1={g.y + 26} y2={g.y + 26} stroke="#e2e8f0" /><text x="4" y={g.y + 18} fontSize="12" fontWeight="600" fill="#334155">{g.label}</text></g>)}
      {layout.records.flatMap(r => blockersOf(r, fields).filter(id => byId.has(id)).map(id => { const source = byId.get(id); return <path key={`${r.id}:${id}`} d={`M${source.x + source.w},${source.y + 15} L${r.x},${r.y + 15}`} stroke="#64748b" strokeWidth="2" />; }))}
      {layout.records.map(r => <g key={r.id} role="button" tabIndex={compact ? -1 : 0} aria-label={label(r)} onClick={() => onSelect(r)} onKeyDown={e => { if (e.key === 'Enter') onSelect(r); }}>
        <rect x={r.x} y={r.y} width={r.w} height="30" rx={r.milestone ? 15 : 4} fill={selectedId === r.id ? '#2563eb' : '#93c5fd'} onPointerDown={e => dragDates(e, r, 'both')} style={{ cursor: onDateMove ? 'ew-resize' : undefined }} />
        {onDateMove && <rect aria-label={`Resize ${label(r)} end date`} x={r.x + r.w - 6} y={r.y} width="6" height="30" fill="#1d4ed8" onPointerDown={e => dragDates(e, r, 'end')} style={{ cursor: 'ew-resize' }} />}
        <text x={r.x + 5} y={r.y + 20} fontSize="12" fill="#0f172a">{r.depth ? '↳ '.repeat(r.depth) : ''}{label(r).slice(0, 35)}{r.milestone ? ' ◆' : ''}</text>
      </g>)}
    </svg></div>;
  }
  const card = r => <button key={r.id} draggable={Boolean(onReclassify)} onDragStart={e => e.dataTransfer.setData('text/x-work-record', r.id)} onClick={() => onSelect(r)} className={`mb-2 block w-full rounded border bg-white p-3 text-left text-sm shadow-sm ${selectedId === r.id ? 'border-blue-500' : 'border-slate-200'}`}><strong>{label(r)}</strong>{fields.filter(f => f.id !== 'title' && !view.hiddenFields?.includes(f.id)).slice(0, 3).map(f => <div key={f.id} className="truncate text-xs text-slate-500">{f.name}: {String(r.cells[f.id] ?? '')}</div>)}</button>;
  const dropTarget = cells => ({
    onDragOver: e => { if (onReclassify) e.preventDefault(); },
    onDrop: e => {
      if (!onReclassify) return;
      e.preventDefault(); const record = records.find(r => r.id === e.dataTransfer.getData('text/x-work-record'));
      if (record) onReclassify(record, Object.fromEntries(Object.entries(cells).map(([key, value]) => [key, value === 'Unassigned' ? '' : value])));
    },
  });
  if (kind === 'story') {
    const activityKey = view.groupBy || 'activity', releaseKey = view.swimlaneBy || 'release';
    const map = storyLayout(records, { activityField: activityKey, releaseField: releaseKey });
    return <table aria-label="Story map" className="border-separate border-spacing-2 text-left text-sm"><thead>
      <tr><th scope="col" className="text-xs text-slate-500">Activities</th>{map.activities.map(a => <th key={a.name} scope="colgroup" colSpan={a.tasks.length} className="rounded bg-amber-100 p-2">{a.name}</th>)}</tr>
      <tr><th scope="col" className="text-xs text-slate-500">Tasks</th>{map.activities.flatMap(a => a.tasks.map(t => <th key={`${a.name}\u0000${t.name}`} scope="col" className="w-56 min-w-56 rounded bg-sky-100 p-2 font-medium">{t.name}</th>))}</tr>
    </thead><tbody>{map.releases.map(release => <tr key={release}><th scope="row" className="align-top text-sm font-semibold">{release}</th>{map.activities.flatMap(a => a.tasks.map(t => <td key={`${a.name}\u0000${t.name}`} aria-label={`${a.name} / ${t.name} / ${release}`} className="w-56 rounded bg-slate-100 p-2 align-top" {...dropTarget({ [activityKey]: a.name, task: t.name, [releaseKey]: release })}>{t.stories.get(release).map(card)}</td>))}</tr>)}</tbody></table>;
  }
  if (kind === 'kanban') {
    const groupKey = view.groupBy || 'status';
    const columnField = fields.find(f => f.id === groupKey);
    const columns = [...new Set([...(columnField?.options || []), ...records.map(r => String(r.cells[groupKey] || 'Unassigned'))])].filter(v => !view.hiddenColumns?.includes(v));
    const swimlaneKey = view.swimlaneBy || '';
    const lanes = swimlaneKey ? [...new Set(records.map(r => String(r.cells[swimlaneKey] || 'Unassigned')))] : ['All records'];
    return <div className="space-y-4">{lanes.map(lane => <section key={lane}><h3 className="mb-2 text-sm font-semibold">{lane}</h3><div className="flex gap-3">{columns.map(column => <div key={column} className="w-56 shrink-0 rounded-lg bg-slate-100 p-2" {...dropTarget({ [groupKey]: column, ...(swimlaneKey ? { [swimlaneKey]: lane } : {}) })}><h4 className="mb-2 text-sm font-semibold">{column}</h4>{records.filter(r => String(r.cells[groupKey] || 'Unassigned') === column && (!swimlaneKey || String(r.cells[swimlaneKey] || 'Unassigned') === lane)).map(card)}</div>)}</div></section>)}</div>;
  }
  if (kind === 'chart') {
    const valueField = view.valueField || fields.find(f => ['number', 'points', 'formula'].includes(f.type))?.id;
    const bars = view.groupBy ? groups.map(g => ({ id: String(g.value ?? ''), name: String(g.value ?? '') || 'Unassigned', value: Math.max(0, Number('sum' in g ? g.sum : g.count) || 0) }))
      : records.map(r => ({ id: r.id, name: label(r), value: Math.max(0, Number(r.cells[valueField]) || 0), record: r }));
    const max = Math.max(1, ...bars.map(b => b.value)), sum = bars.reduce((a, b) => a + b.value, 0) || 1;
    const choose = bar => { if (bar.record) onSelect(bar.record); };
    let angle = 0;
    return <div><div className="mb-2 text-xs text-slate-500">Legend: {bars.map(b => b.name).join(' · ') || 'Add numeric records to draw a chart'}</div><svg aria-label="Chart" width="600" height="300" viewBox="0 0 600 300">
      {view.chartType === 'line' ? <polyline fill="none" stroke="#2563eb" strokeWidth="3" points={bars.map((b, i) => `${30 + i * (540 / Math.max(1, bars.length - 1))},${250 - b.value / max * 220}`).join(' ')} /> : bars.map((b, i) => {
        if (view.chartType === 'pie') {
          const start = angle; angle += b.value / sum * Math.PI * 2;
          const end = Math.min(angle, start + Math.PI * 2 - 0.0001);
          return <path key={b.id} d={`M300,145 L${300 + 120 * Math.cos(start)},${145 + 120 * Math.sin(start)} A120,120 0 ${end - start > Math.PI ? 1 : 0},1 ${300 + 120 * Math.cos(end)},${145 + 120 * Math.sin(end)} Z`} fill={COLORS[i % COLORS.length]} stroke="#94a3b8" onClick={() => choose(b)}><title>{b.name}: {b.value}</title></path>;
        }
        const width = 540 / Math.max(1, bars.length);
        return <g key={b.id} onClick={() => choose(b)}><rect x={30 + i * width} y={250 - b.value / max * 220} width={Math.max(1, width - 4)} height={b.value / max * 220} fill="#60a5fa" /><text x={30 + i * width} y="275" fontSize="10">{b.name.slice(0, 10)}</text><title>{b.name}: {b.value}</title></g>;
      })}
    </svg></div>;
  }
  const visible = fields.filter(f => !view.hiddenFields?.includes(f.id));
  const groupValue = value => String(value ?? '');
  const counts = new Map(groups.map(g => [groupValue(g.value), g.count]));
  const grouped = view.groupBy ? [...new Set(records.map(r => groupValue(r.cells[view.groupBy])))] : [''];
  return <div className="space-y-3">{grouped.map(group => { const rows = records.filter(r => !view.groupBy || groupValue(r.cells[view.groupBy]) === group); return <section key={group} aria-label={view.groupBy ? `Group ${group || 'Unassigned'}` : undefined}>{view.groupBy && <h3 className="text-sm font-semibold">{group || 'Unassigned'} · {counts.get(group) ?? rows.length} records</h3>}<table className="min-w-full border-collapse text-left text-sm"><thead><tr>{visible.map(f => <th key={f.id} className="whitespace-nowrap border bg-slate-50 px-3 py-2">{f.name}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.id} onClick={() => onSelect(r)} className={selectedId === r.id ? 'bg-blue-50' : 'hover:bg-slate-50'}>{visible.map(f => { const number = ['number', 'points', 'formula'].includes(f.type) ? numberPresentation(r.cells[f.id], f) : null; return <td key={f.id} className="max-w-64 truncate border px-3 py-2" style={{ color: number?.color }}><button className="w-full text-left" onClick={() => onSelect(r)}>{r.parentId && f.id === 'title' ? '↳ ' : ''}{number ? number.text : String(r.cells[f.id] ?? '')}{number?.progress != null && <progress aria-label={`${f.name} progress`} max="100" value={number.progress} className="block w-24" />}</button></td>; })}</tr>)}</tbody></table></section>; })}</div>;
}
