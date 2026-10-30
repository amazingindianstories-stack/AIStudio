"use client";

import { useState } from 'react';
import { useCanvasStore } from '@/lib/canvas-store';
import { buildTimeline } from '@/lib/canvas/work-generators';

export function TimelineBuilder({ viewCenter, onClose, readOnly }) {
  const [options, setOptions] = useState({ start: new Date().toISOString().slice(0, 10), end: '', interval: 'month', lanes: 'Team', color: '#dbeafe' });
  const [error, setError] = useState('');
  return <form role="dialog" aria-label="Timeline Builder" className="absolute inset-x-4 top-28 z-50 mx-auto max-w-lg space-y-4 rounded-xl border bg-white p-5 text-slate-800 shadow-xl" onKeyDown={e => e.stopPropagation()} onSubmit={e => {
    e.preventDefault();
    if (readOnly) return;
    try { useCanvasStore.getState().editBoard(board => buildTimeline(board, options, viewCenter())); onClose(); }
    catch (error) { setError(error.message); }
  }}><h2 className="font-semibold">Timeline Builder</h2>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<fieldset disabled={readOnly} className="space-y-3">{['start', 'end'].map(key => <label key={key} className="block text-sm capitalize">{key} date<input required type="date" className="ml-3 rounded border px-2 py-1" value={options[key]} onChange={e => setOptions({ ...options, [key]: e.target.value })} /></label>)}<label className="block text-sm">Interval<select className="ml-3 rounded border px-2 py-1" value={options.interval} onChange={e => setOptions({ ...options, interval: e.target.value })}>{['day', 'week', 'month', 'quarter'].map(v => <option key={v}>{v}</option>)}</select></label><label className="block text-sm">Swimlanes, one per line<textarea className="mt-1 block w-full rounded border px-2 py-1" rows={4} value={options.lanes} onChange={e => setOptions({ ...options, lanes: e.target.value })} /></label><label className="block text-sm">Header color<input className="ml-3" type="color" value={options.color} onChange={e => setOptions({ ...options, color: e.target.value })} /></label><button className="rounded bg-blue-600 px-3 py-2 text-sm text-white" type="submit">Build timeline</button></fieldset><button className="text-sm" type="button" onClick={onClose}>Cancel</button></form>;
}
